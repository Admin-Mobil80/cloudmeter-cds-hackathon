import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import { renderEmailHtml, renderEmailText, displayName, rolePhrase } from '../../../shared/email-layout';

const ses = new SESClient({});
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const PORTAL_URL = process.env.PORTAL_URL!;

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  let body: { email?: string; role?: string; accountIds?: unknown; name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const { email, role } = body;
  // Optional but strongly wanted: without it the roster shows a slice of an
  // email address until the person signs in and supplies their own.
  const invitedName = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['admin', 'member'].includes(role ?? '')) {
    return json(400, { message: 'A valid email and role (admin or member) are required' });
  }

  // Admins can bring in Members but not create more Admins — otherwise an
  // Admin could invite a second Admin and, between them, hold rights the Owner
  // never granted. Mirrors removal, where an Admin can only remove Members.
  if (caller.membership.role === 'admin' && role !== 'member') {
    return json(403, { message: 'Admins can invite Members. Ask the Owner to add an Admin.' });
  }

  // Which cloud accounts a Member starts with. Ignored for an Admin, who sees
  // every account in the tenant — storing a list for one would be data that
  // means nothing.
  const requestedAccountIds = role === 'member' && Array.isArray(body.accountIds)
    ? [...new Set(body.accountIds.filter((id): id is string => typeof id === 'string' && !!id))]
    : [];

  const token = randomUUID();
  const now = new Date().toISOString();
  const tenantId = caller.membership.tenantId;

  // Re-inviting an existing member would list them twice — once as a member
  // and once as a pending invite — so refuse and point at role changes instead.
  const { Items: existing } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':pk': `TENANT#${tenantId}`,
      ':sk': 'MEMBER#',
      ':email': email,
    },
  }));
  if (existing && existing.length > 0) {
    return json(409, {
      message: `${email} is already on this team — change their role from the members list instead.`,
    });
  }

  // Re-inviting a still-pending address is almost always "they didn't get the
  // email", so treat it as a resend: drop the previous pending invite and
  // issue a fresh one. Without this each attempt added another row, leaving
  // duplicate entries for the same person.
  const { Items: pending } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :e AND GSI2SK = :t',
    FilterExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':e': `EMAIL#${email}`,
      ':t': `TENANT#${tenantId}`,
      ':pending': 'pending',
    },
  }));
  const superseded = pending?.length ?? 0;
  await Promise.all((pending ?? []).map((p) =>
    ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: p.PK, SK: p.SK } })),
  ));

  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));
  const tenantName = tenant?.name ?? 'a CloudMeter account';

  // Named in the email, so the invite says what they're being brought in for.
  // Also validates the ids: an invite is stored now and consumed days later,
  // and a bad id would fail silently at that distance.
  let invitedAccountNames: string[] = [];
  if (requestedAccountIds.length) {
    const { Items: tenantAccounts } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ProjectionExpression: 'accountId, #n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
    }));
    const byId = new Map((tenantAccounts ?? []).map((a) => [a.accountId as string, a.name as string]));
    const unknown = requestedAccountIds.filter((id) => !byId.has(id));
    if (unknown.length) {
      return json(400, {
        message: 'Those cloud accounts are not part of this CloudMeter account.',
        rejectedAccountIds: unknown,
      });
    }
    invitedAccountNames = requestedAccountIds.map((id) => byId.get(id)!);
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `INVITE#${token}`,
      GSI2PK: `EMAIL#${email}`,
      GSI2SK: `TENANT#${tenantId}`,
      email,
      role,
      invitedBy: caller.userId,
      invitedAt: now,
      status: 'pending',
      ...(invitedName ? { name: invitedName } : {}),
      ...(requestedAccountIds.length ? { accountIds: requestedAccountIds } : {}),
    },
  }));

  // Sign-in, not sign-up: the invite itself is the account creation, so the
  // invitee just enters this address and gets a one-time code.
  const signInUrl = `${PORTAL_URL}/login.html?mode=signin&email=${encodeURIComponent(email)}`;

  const inviter = displayName(caller.membership.name, caller.email);
  const roleName = rolePhrase(role!);
  // What the role actually means, so the invitee knows what to expect on the
  // other side of the button rather than discovering it by finding pages
  // missing.
  const roleNote = role === 'admin'
    ? 'As an Admin you can connect and manage cloud accounts, see costs across all of them, and invite teammates.'
    : invitedAccountNames.length
      ? `You will have access to ${invitedAccountNames.length === 1 ? 'this cloud account' : `these ${invitedAccountNames.length} cloud accounts`} and their costs: ${invitedAccountNames.join(', ')}.`
      : 'As a Member you will see the cloud accounts you are given access to, and the costs for those.';

  const mail = {
    title: `${inviter} invited you to ${tenantName} on CloudMeter`,
    paragraphs: [
      `${inviter} has invited you to join ${tenantName} on CloudMeter as ${roleName}.`,
      roleNote,
      'CloudMeter tracks cloud spend across AWS, Azure, Google Cloud, Alibaba Cloud and Huawei Cloud in one place.',
    ],
    cta: { label: 'Accept invite & sign in', url: signInUrl },
    footnote: `Sign in with ${email} and we'll email you a one-time code — no password, and nothing to set up.`,
  };

  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: `${inviter} invited you to ${tenantName} on CloudMeter` },
      Body: {
        Text: { Data: renderEmailText(mail) },
        Html: { Data: renderEmailHtml(mail) },
      },
    },
  }));

  return json(201, { email, role, status: 'pending', invitedAt: now, resent: superseded > 0 });
};
