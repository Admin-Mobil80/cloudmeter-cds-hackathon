import { createHash } from 'node:crypto';
import type { SNSEvent } from 'aws-lambda';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { getMembershipForUser, getMembershipInTenant, getMembershipsForUser, normalizeAccountIds } from '../../shared/membership';
import { createTeamInvite } from '../../shared/team-invite';
import { resolveDisplayCurrency } from '../../shared/display-currency';
import { sendTextViaAws } from '../../shared/whatsapp';
import { extractInbound, type InboundMessage } from '../inbound';
import { decideWorkspace, chooseMessage, type ChoiceSession } from '../workspace-choice';
import { continueInvite, isInviteRequest, startFromText, type InviteStep, type PendingInvite } from '../invite-flow';
import type { AssistantContext, WorkspaceScope } from '../tools';

/*
 * WhatsApp → CloudMeter's AI cost assistant.
 *
 * AWS End User Messaging Social publishes every event for our WhatsApp number
 * to an SNS topic; this function is that topic's only subscriber. For each
 * genuine customer text it works out who is asking from their verified
 * number, asks the agent on Bedrock AgentCore, and replies on WhatsApp.
 *
 * It must never be able to loop (an SNS hard rule for this project). The
 * guards, in order:
 *   1. extractInbound drops status updates and our own number's messages, so
 *      our replies and their receipts can never come back as questions.
 *   2. Each WhatsApp message id is claimed once in DynamoDB; SNS may deliver
 *      twice, and a second delivery is skipped.
 *   3. A per-number hourly limit caps how many questions reach the model.
 *   4. This function never publishes to SNS, has no retries (set on the
 *      function) and a small reserved concurrency (set in the stack).
 */

const AGENT_RUNTIME_ARN = process.env.ASSISTANT_RUNTIME_ARN!;
const PHONE_NUMBER_ID = (process.env.WHATSAPP_ORIGINATION_PHONE_ID ?? '').trim();
const HOURLY_LIMIT = Number(process.env.ASSISTANT_HOURLY_LIMIT ?? 20);
/**
 * Invite steps ("invite", a workspace number, an email, 1 or 2) have their
 * own cap, so setting one up doesn't use up the questions. They never reach
 * the model, but each still sends a reply, so they are capped too.
 */
const INVITE_HOURLY_LIMIT = 40;
/**
 * Whether a number with no CloudMeter user gets told so. Off outside prod: dev
 * and prod share one WhatsApp number, so while dev is the one listening, a real
 * customer replying to a prod digest would reach dev — which has never heard of
 * them — and be told their number isn't linked. Silence is the lesser surprise.
 */
const REPLY_TO_UNKNOWN = process.env.ASSISTANT_REPLY_TO_UNKNOWN === 'true';
/** How long a conversation is remembered for follow-up questions. */
const HISTORY_TTL_S = 30 * 60;
/** How long a chosen workspace is remembered. */
const SESSION_TTL_S = 12 * 60 * 60;
const DEDUPE_TTL_S = 3 * 24 * 60 * 60;
/** How long a half-finished WhatsApp invite waits for its next reply. */
const INVITE_TTL_S = 15 * 60;
const FROM_EMAIL = process.env.OTP_FROM_EMAIL ?? '';
const PORTAL_URL = process.env.PORTAL_URL ?? 'https://portal.cloudmeter.io';

const agentcore = new BedrockAgentCoreClient({});
const nowS = () => Math.floor(Date.now() / 1000);

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records ?? []) {
    for (const msg of extractInbound(record.Sns?.Message ?? '', PHONE_NUMBER_ID)) {
      try {
        await handleMessage(msg);
      } catch (err) {
        // Logged, never retried: a retry is a second answer to one question.
        console.error('assistant message failed', msg.id, (err as Error).message);
      }
    }
  }
};

async function handleMessage(msg: InboundMessage): Promise<void> {
  if (!(await claimOnce(msg.id))) {
    console.log('duplicate delivery skipped', msg.id);
    return;
  }

  // An invite under way, or one being started, is counted apart from questions.
  const pendingInvite = await loadInvite(msg.from);
  const isInviteStep = msg.type === 'text' && !!msg.text && (!!pendingInvite || isInviteRequest(msg.text));
  const counter = isInviteStep ? 'invites' : 'questions';
  const limit = isInviteStep ? INVITE_HOURLY_LIMIT : HOURLY_LIMIT;
  const count = await countThisHour(msg.from, counter);
  if (count > limit) {
    // Told once, then silent until the hour turns over.
    if (count === limit + 1) {
      await sendTextViaAws(msg.from, isInviteStep
        ? 'That\'s a lot of invite steps for one hour. Please try again a little later, or invite people from Team at portal.cloudmeter.io.'
        : `You've reached the limit of ${HOURLY_LIMIT} questions an hour. Please try again a little later, or open portal.cloudmeter.io.`);
    }
    return;
  }

  // One number can be verified on more than one login — the same person
  // with two email addresses. Most recently verified first.
  const users = await usersForPhone(msg.from);
  if (users.length === 0) {
    if (!REPLY_TO_UNKNOWN) return;
    if (await claimOnce(`unknown#${msg.from}#${new Date().toISOString().slice(0, 10)}`)) {
      await sendTextViaAws(msg.from, 'This number isn\'t linked to a CloudMeter account. To ask about your cloud costs here, connect WhatsApp under Notifications at portal.cloudmeter.io.');
    }
    return;
  }

  if (msg.type !== 'text' || !msg.text) {
    await sendTextViaAws(msg.from, 'I can only read text messages for now. Ask me something like "How much have we spent this month?"');
    return;
  }

  // The first of those logins that belongs to a workspace. Rohan's number is
  // on rohan@acme.com (no workspaces, verified later) and rohan@mobil80.com
  // (eleven); taking only the newest told him he had no workspace.
  let context: AssistantContext | null = null;
  let contextUserId = '';
  for (const userId of users) {
    context = await contextFor(userId);
    if (context) { contextUserId = userId; break; }
  }
  if (!context) {
    await sendTextViaAws(msg.from, 'Your CloudMeter login isn\'t part of a workspace yet. Open portal.cloudmeter.io to set one up.');
    return;
  }

  // Inviting a teammate: "invite …", or the next reply in one already under
  // way. Handled here in plain code, before the agent, which stays read-only.
  const inviteWorkspaces = context.workspaces.map((w) => ({ tenantId: w.tenantId, name: w.name, role: w.role }));
  let inviteStep: InviteStep | null = null;
  if (pendingInvite) inviteStep = continueInvite(pendingInvite, msg.text);
  else if (isInviteRequest(msg.text)) inviteStep = startFromText(msg.text, inviteWorkspaces);
  if (inviteStep) {
    await runInviteStep(msg, contextUserId, inviteStep);
    return;
  }

  // Which workspace this is about: decided here, not by the model. Someone in
  // several workspaces picks one, and it sticks — see workspace-choice.ts.
  const session = await loadSession(msg.from);
  const decision = decideWorkspace(msg.text, context.workspaces.map((w) => ({ tenantId: w.tenantId, name: w.name })), session);
  if (decision.kind === 'reply') {
    await sendTextViaAws(msg.from, decision.message);
    await saveSession(msg.from, decision.session);
    console.log(JSON.stringify({ workspacePrompt: msg.id, awaiting: !!decision.session.awaitingChoice }));
    return;
  }
  context.defaultTenantId = decision.tenantId;
  const question = decision.question;

  const history = await loadHistory(msg.from);
  const started = Date.now();
  let reply: { answer: string; toolsUsed: string[]; workspaceTenantId?: string; needsWorkspace?: boolean };
  try {
    reply = await askAgent(msg.from, question, history, context);
  } catch (err) {
    console.error('agent failed', msg.id, (err as Error).message);
    await sendTextViaAws(msg.from, 'Sorry, I couldn\'t answer that just now. Please try again in a minute.');
    return;
  }
  if (reply.needsWorkspace) {
    await sendTextViaAws(msg.from, chooseMessage(context.workspaces));
    await saveSession(msg.from, { awaitingChoice: true, pendingQuestion: question });
    console.log(JSON.stringify({ workspacePrompt: msg.id, afterAgent: true }));
    return;
  }
  await sendTextViaAws(msg.from, reply.answer);
  // The choice only changes by "switch to X" or "all"; answering a question
  // about one workspace doesn't make it stick.
  const used = context.workspaces.find((w) => w.tenantId === reply.workspaceTenantId);
  await saveSession(msg.from, { selectedTenantId: decision.session.selectedTenantId });
  await saveHistory(msg.from, [...history, { role: 'user', text: question }, { role: 'assistant', text: reply.answer }]);
  console.log(JSON.stringify({ answered: msg.id, tenantId: context.defaultTenantId, usedTenantId: used?.tenantId ?? null, workspaces: context.workspaces.length, toolsUsed: reply.toolsUsed, ms: Date.now() - started }));
}

async function runInviteStep(msg: InboundMessage, userId: string, step: InviteStep): Promise<void> {
  if (step.kind === 'reply') {
    await sendTextViaAws(msg.from, step.message);
    await saveInvite(msg.from, step.pending);
    console.log(JSON.stringify({ invitePrompt: msg.id, open: !!step.pending }));
    return;
  }

  // The person's own membership in the chosen workspace, re-read now: the
  // shared invite function checks role, read-only and billing against it.
  await saveInvite(msg.from, null);
  const membership = await getMembershipInTenant(userId, step.tenantId);
  if (!membership) {
    await sendTextViaAws(msg.from, 'You\'re no longer part of that workspace, so no invitation was sent.');
    return;
  }
  const row = (await getMembershipsForUser(userId)).find((m) => String(m.PK) === `TENANT#${step.tenantId}`);
  const caller = { userId, email: String(row?.email ?? ''), membership };
  const res = await createTeamInvite(caller, { email: step.email, role: step.role, name: step.name ?? undefined }, { fromEmail: FROM_EMAIL, portalUrl: PORTAL_URL });
  const status = typeof res === 'object' ? res.statusCode : 500;
  const body = JSON.parse(typeof res === 'object' && typeof res.body === 'string' ? res.body : '{}') as { message?: string };

  if (status === 201) {
    const person = step.name ?? step.email;
    const role = step.role === 'admin' ? 'an Admin' : 'a Member';
    const access = step.role === 'member'
      ? ` Members see only the cloud accounts you give them: choose those under Team at ${PORTAL_URL.replace(/^https:\/\//, '')}.`
      : '';
    await sendTextViaAws(msg.from, `Invitation emailed to ${step.email}. When ${person} signs in with that address, they'll join ${membership.tenantName ?? 'the workspace'} as ${role}.${access}`);
  } else {
    await sendTextViaAws(msg.from, `No invitation sent: ${body.message ?? 'something went wrong. Please try again from Team at portal.cloudmeter.io.'}`);
  }
  console.log(JSON.stringify({ inviteSent: msg.id, tenantId: step.tenantId, role: step.role, status }));
}

async function loadInvite(phone: string): Promise<PendingInvite | null> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `WAINVITE#${phone}`, SK: 'PENDING' } }));
  if (!Item || Number(Item.expiresAt) < nowS()) return null;
  return Item.pending as PendingInvite;
}

async function saveInvite(phone: string, pending: PendingInvite | null): Promise<void> {
  const Key = { PK: `WAINVITE#${phone}`, SK: 'PENDING' };
  if (!pending) {
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key }));
    return;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...Key, pending, expiresAt: nowS() + INVITE_TTL_S } }));
}

async function loadSession(phone: string): Promise<ChoiceSession> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `WASESSION#${phone}`, SK: 'STATE' } }));
  if (!Item || Number(Item.expiresAt) < nowS()) return {};
  return {
    selectedTenantId: Item.selectedTenantId as string | undefined,
    awaitingChoice: Item.awaitingChoice === true,
    pendingQuestion: Item.pendingQuestion as string | undefined,
  };
}

async function saveSession(phone: string, session: ChoiceSession): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: `WASESSION#${phone}`, SK: 'STATE', ...session, expiresAt: nowS() + SESSION_TTL_S },
  }));
}

/** True the first time a key is seen; false on every later attempt. */
async function claimOnce(key: string): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: `WAINBOUND#${key}`, SK: 'SEEN', expiresAt: nowS() + DEDUPE_TTL_S },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Adds one to this number's count for the hour; `counter` is 'questions' or 'invites'. */
async function countThisHour(phone: string, counter: 'questions' | 'invites'): Promise<number> {
  const hour = new Date().toISOString().slice(0, 13);
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `WARATE#${phone}`, SK: hour },
    UpdateExpression: 'ADD #c :one SET expiresAt = :exp',
    ExpressionAttributeNames: { '#c': counter },
    ExpressionAttributeValues: { ':one': 1, ':exp': nowS() + 2 * 60 * 60 },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number(Attributes?.[counter] ?? 1);
}

/**
 * The CloudMeter user behind a WhatsApp number.
 *
 * WAPHONE# rows are written when someone verifies their number, but they are
 * only a pointer: the user's live notification settings are re-read here, so a
 * number that has since been disconnected or changed is refused.
 */
async function usersForPhone(phone: string): Promise<string[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `WAPHONE#${phone}`, ':sk': 'USER#' },
  }));
  const candidates = (Items ?? []).sort((a, b) => String(b.verifiedAt ?? '').localeCompare(String(a.verifiedAt ?? '')));
  const users: string[] = [];
  for (const c of candidates) {
    const userId = String(c.SK).replace('USER#', '');
    const { Item: prefs } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
    }));
    const wa = (prefs?.channels as { whatsapp?: { connected?: boolean; phone?: string } } | undefined)?.whatsapp;
    if (wa?.connected && (wa.phone ?? '').replace(/\D/g, '') === phone) users.push(userId);
  }
  return users;
}

/**
 * Every workspace this person belongs to, each with what they may see in it.
 *
 * The current one (the portal's active workspace) is the default; the others
 * can be asked about by name. A Member is scoped to their mapped accounts in
 * that workspace only. Closed or pending memberships are left out.
 */
async function contextFor(userId: string): Promise<AssistantContext | null> {
  const current = await getMembershipForUser(userId);
  if (!current) return null;
  const memberships = (await getMembershipsForUser(userId))
    .filter((m) => !m.status || m.status === 'active');
  const workspaces = (await Promise.all(memberships.map(async (m): Promise<WorkspaceScope | null> => {
    const tenantId = String(m.PK).replace('TENANT#', '');
    const { Item: tenant } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    }));
    if (!tenant) return null;
    const currency = await resolveDisplayCurrency(tenant);
    return {
      tenantId,
      name: (tenant.name as string) ?? 'Unnamed workspace',
      role: String(m.role),
      accountIds: m.role === 'member' ? normalizeAccountIds(m.accountIds) : null,
      currency: { code: currency.code, symbol: currency.symbol, rate: currency.rate },
    };
  }))).filter((w): w is WorkspaceScope => w !== null);
  if (!workspaces.some((w) => w.tenantId === current.tenantId)) return null;
  return {
    workspaces,
    defaultTenantId: current.tenantId,
    userName: current.name,
    timezone: current.timezone ?? 'UTC',
  };
}

interface Turn { role: 'user' | 'assistant'; text: string }

async function loadHistory(phone: string): Promise<Turn[]> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `WACHAT#${phone}`, SK: 'HISTORY' } }));
  if (!Item || Number(Item.expiresAt) < nowS()) return [];
  return (Item.turns as Turn[]) ?? [];
}

async function saveHistory(phone: string, turns: Turn[]): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: `WACHAT#${phone}`, SK: 'HISTORY', turns: turns.slice(-6), expiresAt: nowS() + HISTORY_TTL_S },
  }));
}

async function askAgent(phone: string, question: string, history: Turn[], context: AssistantContext): Promise<{ answer: string; toolsUsed: string[]; workspaceTenantId?: string; needsWorkspace?: boolean }> {
  // AgentCore wants a session id of at least 33 characters; one per number per day.
  const sessionId = `wa-${createHash('sha256').update(phone).digest('hex').slice(0, 32)}-${new Date().toISOString().slice(0, 10)}`;
  const res = await agentcore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: AGENT_RUNTIME_ARN,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ question, history, context })),
  }));
  const body = JSON.parse(await res.response!.transformToString()) as { answer?: string; toolsUsed?: string[]; workspaceTenantId?: string; needsWorkspace?: boolean; error?: string };
  if (body.needsWorkspace) return { answer: '', toolsUsed: body.toolsUsed ?? [], needsWorkspace: true };
  if (!body.answer) throw new Error(`agent returned no answer: ${body.error ?? 'unknown'}`);
  return { answer: body.answer, toolsUsed: body.toolsUsed ?? [], workspaceTenantId: body.workspaceTenantId };
}
