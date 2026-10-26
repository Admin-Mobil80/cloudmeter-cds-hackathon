/**
 * Posting to Slack.
 *
 * One call, `chat.postMessage`, which is all CloudMeter needs: Slack treats a
 * channel and a direct message as the same thing — both are addressed by an id
 * — so this file is unchanged whether a workspace receives its digest in
 * #cloud-costs or each person receives their own.
 *
 * Unlike WhatsApp, the token here belongs to the *customer*: they install the
 * CloudMeter app into their own Slack and we store what Slack hands back. One
 * tenant's token must therefore never be used to post for another, which is
 * why it is passed in rather than read from the environment the way the
 * WhatsApp credentials are.
 */

import {
  SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const SLACK_API = 'https://slack.com/api';

const secrets = new SecretsManagerClient({});

interface SlackConfig {
  /** CloudMeter's own Slack app credentials, for the install flow. */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Where one tenant's bot token lives.
 *
 * A secret each, not one shared map. Secrets Manager can only replace a whole
 * secret, so a shared map means every install does read-modify-write over
 * every customer's token — and a bug that writes the new entry instead of the
 * merged set silently deletes everyone else's Slack. Nothing errors; it
 * surfaces days later as "the digests stopped".
 *
 * A secret each costs about $0.40 a month per tenant and removes that
 * entirely: creating one customer's token cannot touch another's. It is also
 * the shape already used for customer cloud credentials — see
 * shared/secrets.ts — so this is an existing pattern rather than a new one.
 */
function tenantSecretName(tenantId: string): string {
  const prefix = process.env.SECRET_PREFIX ?? 'cloudmeter';
  return `${prefix}/slack/tenant/${tenantId}`;
}

/**
 * Cached per tenant, with a short life for "no token" and a long one for a
 * token that was found.
 *
 * Tokens are long-lived, so re-reading on every send would put a Secrets
 * Manager call — and its cost — on every message.
 *
 * "No token" is the opposite: it is the one answer that changes the instant
 * somebody installs, and it changes at exactly the moment they are watching
 * the page. This used to be cached for the life of the container, on the
 * reasoning that a container dies soon enough — and on 2026-10-09 that proved
 * wrong on prod. Mobil80 installed CloudMeter into Slack, and a warm container
 * holding `null` from a few minutes earlier went on telling the Notifications
 * page "Nobody has set up Slack for this workspace yet", while Connect failed
 * with a 409 that logged nothing. The install had worked perfectly; only the
 * memory of its absence was stale.
 *
 * So a miss is remembered just long enough to spare the sweep from asking for
 * every unconnected tenant on every pass, and not long enough to outlive an
 * install. A hit is kept far longer, because a token that exists rarely stops
 * existing — and when it does, the send fails and `withSlackBroken` handles it.
 */
interface CachedToken {
  token: string | null;
  at: number;
}

const tokenCache = new Map<string, CachedToken>();

/** A found token: re-read occasionally, since it almost never changes. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * No token: forgotten quickly, because an install flips this and the person
 * who just installed is looking at the page. Long enough that one sweep over
 * every unconnected tenant still costs one lookup each, not one per send.
 */
const NO_TOKEN_TTL_MS = 30 * 1000;

/** The cached answer, or undefined when there is none worth using. */
function cachedToken(tenantId: string, now: number): string | null | undefined {
  const hit = tokenCache.get(tenantId);
  if (!hit) return undefined;

  const ttl = hit.token === null ? NO_TOKEN_TTL_MS : TOKEN_TTL_MS;
  if (now - hit.at >= ttl) {
    tokenCache.delete(tenantId);
    return undefined;
  }
  return hit.token;
}

/**
 * One tenant's bot token, or null if that workspace has not connected Slack.
 *
 * Null rather than throwing, because "this tenant has no Slack" is the
 * ordinary case for most tenants and must not interrupt a sweep that is also
 * sending email to them.
 */
export async function tokenForTenant(tenantId: string): Promise<string | null> {
  const now = Date.now();
  const cached = cachedToken(tenantId, now);
  if (cached !== undefined) return cached;

  let token: string | null = null;
  /*
   * Whether this result is an answer worth remembering.
   *
   * A missing secret is an answer: the workspace has not connected Slack. A
   * permissions problem or a throttle is not — it is a failure to ask, and
   * caching it would turn a momentary blip into half a minute of a connected
   * workspace looking unconnected. Same distinction the BMS Slack column
   * makes between "no" and "unknown".
   */
  let isAnswer = true;
  try {
    const { SecretString } = await secrets.send(new GetSecretValueCommand({
      SecretId: tenantSecretName(tenantId),
    }));
    const parsed = SecretString ? JSON.parse(SecretString) as { botToken?: string } : null;
    token = parsed?.botToken ?? null;
  } catch (err) {
    // No secret is how an unconnected tenant looks, not a fault. Anything else
    // — a permissions problem, a malformed value — is worth a log line rather
    // than being swallowed as "no Slack".
    const name = (err as { name?: string }).name;
    if (name !== 'ResourceNotFoundException') {
      console.error(`Could not read Slack token for tenant ${tenantId}`, (err as Error).message);
      isAnswer = false;
    }
  }

  if (isAnswer) tokenCache.set(tenantId, { token, at: now });
  return token;
}

/** CloudMeter's own app credentials, for the install flow. */
let cachedConfig: SlackConfig | null = null;

export async function slackConfig(): Promise<SlackConfig> {
  if (cachedConfig) return cachedConfig;

  const arn = process.env.SLACK_SECRET_ARN;
  if (!arn) throw new Error('SLACK_SECRET_ARN is not set');

  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  // Empty before the app credentials are filled in, which is not an error.
  cachedConfig = SecretString ? JSON.parse(SecretString) as SlackConfig : {};
  return cachedConfig;
}

/** Forgets what is cached. For tests, and after an install writes a token. */
export function resetSlackConfigCache(): void {
  cachedConfig = null;
  tokenCache.clear();
}



export interface SlackPost {
  /** Slack's own id for the message, for logs and de-duplication. */
  ts: string;
  /** The channel it landed in, echoed back by Slack. */
  channel: string;
}

/**
 * Slack answers 200 for almost everything and puts the failure in the body.
 *
 * A non-2xx status is the rare case; `{ ok: false, error: '...' }` on a 200 is
 * the normal one. Treating HTTP status as success is how an integration ends
 * up reporting that it delivered a month of messages nobody received.
 */
export class SlackError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'SlackError';
  }

  /**
   * Whether this is worth telling the customer about rather than retrying.
   *
   * These mean the installation is broken — the app was removed, the token
   * revoked, the channel deleted, or the bot was never invited. Retrying
   * cannot fix any of them, and they need a person to reconnect.
   */
  get needsReconnect(): boolean {
    return [
      'invalid_auth', 'token_revoked', 'account_inactive',
      'channel_not_found', 'not_in_channel', 'is_archived',
    ].includes(this.code);
  }
}

/**
 * Posts one message.
 *
 * `text` is required even when blocks are supplied: it is what Slack shows in
 * a notification preview and in clients that cannot render blocks, and a
 * message without it arrives as a silent blank line on a phone.
 */
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
): Promise<SlackPost> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      text,
      ...(blocks ? { blocks } : {}),
      // The digest is a notification, not a conversation: an unfurled link
      // preview of the portal would double the height of every message.
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  // A transport failure or a 5xx is worth saying plainly; Slack's own errors
  // come back below with their code intact.
  if (!res.ok && res.status >= 500) {
    throw new SlackError('slack_unavailable', `Slack returned HTTP ${res.status}`);
  }

  const body = await res.json().catch(() => null) as
    { ok?: boolean; error?: string; ts?: string; channel?: string } | null;

  if (!body) throw new SlackError('bad_response', 'Slack returned no readable body');
  if (!body.ok) throw new SlackError(body.error ?? 'unknown_error');

  return { ts: body.ts ?? '', channel: body.channel ?? channel };
}

/**
 * A Slack API call that is not postMessage, with the same error handling.
 *
 * Form-encoded, not JSON. Slack's read methods — `users.lookupByEmail` among
 * them — accept only `application/x-www-form-urlencoded` and answer a JSON
 * body with `invalid_arguments`, which reads like a bad email address rather
 * than the wrong content type. Posting methods accept both, so one encoding
 * serves every call here.
 */
async function call(
  token: string,
  method: string,
  payload: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams(payload).toString(),
  });

  if (!res.ok && res.status >= 500) {
    throw new SlackError('slack_unavailable', `Slack returned HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw new SlackError('bad_response', 'Slack returned no readable body');
  if (!body.ok) throw new SlackError(String(body.error ?? 'unknown_error'));
  return body;
}

/**
 * Finds someone's Slack account from the email CloudMeter knows them by.
 *
 * This is what spares every member an OAuth round of their own: the workspace
 * installs CloudMeter once, and each person is matched by address.
 *
 * Returns null when there is no match, which is a normal outcome rather than a
 * fault — plenty of people use a different address on Slack than at work, and
 * the page says so instead of silently never sending.
 */
export async function findUserByEmail(token: string, email: string): Promise<string | null> {
  try {
    const body = await call(token, 'users.lookupByEmail', { email });
    const user = body.user as { id?: string } | undefined;
    return user?.id ?? null;
  } catch (err) {
    if (err instanceof SlackError && err.code === 'users_not_found') return null;
    throw err;
  }
}

/**
 * Opens the direct message channel with someone and returns its id.
 *
 * Slack addresses a DM by channel id like any other conversation, so this id
 * is what gets stored and handed to postMessage. Opening is idempotent — it
 * returns the existing conversation when there is one — so it is safe to call
 * again if the stored id is ever lost.
 */
export async function openDirectMessage(token: string, slackUserId: string): Promise<string> {
  const body = await call(token, 'conversations.open', { users: slackUserId });
  const channel = body.channel as { id?: string } | undefined;
  if (!channel?.id) throw new SlackError('no_dm_channel', 'Slack opened no DM channel');
  return channel.id;
}

/**
 * Trades the one-time code Slack sends back for that workspace's bot token.
 *
 * The only call here that uses CloudMeter's own app credentials rather than a
 * tenant's token — this is the moment a workspace becomes a tenant we can post
 * for. Form-encoded, like Slack's other non-posting methods.
 */
export interface SlackInstall {
  botToken: string;
  teamId: string;
  teamName: string;
}

export async function exchangeOAuthCode(code: string, redirectUri: string): Promise<SlackInstall> {
  const { clientId, clientSecret } = await slackConfig();
  if (!clientId || !clientSecret) {
    throw new SlackError('not_configured', 'CloudMeter has no Slack app credentials stored');
  }

  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok && res.status >= 500) {
    throw new SlackError('slack_unavailable', `Slack returned HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null) as {
    ok?: boolean; error?: string; access_token?: string;
    team?: { id?: string; name?: string };
  } | null;

  if (!body) throw new SlackError('bad_response', 'Slack returned no readable body');
  if (!body.ok) throw new SlackError(body.error ?? 'unknown_error');

  /*
   * The bot token, not a user token.
   *
   * oauth.v2.access answers with both shapes depending on what was requested,
   * and the user token would post as whoever installed the app — so every
   * digest would appear to come from that person rather than from CloudMeter.
   * Absent means the install did not grant a bot, which is not something to
   * paper over.
   */
  if (!body.access_token) throw new SlackError('no_bot_token', 'Slack granted no bot token');

  return {
    botToken: body.access_token,
    teamId: body.team?.id ?? '',
    teamName: body.team?.name ?? '',
  };
}

/**
 * Stores one workspace's token, in that tenant's own secret.
 *
 * Create-then-overwrite rather than read-modify-write: there is nothing in
 * this secret but this tenant's token, so an install cannot disturb another
 * customer's Slack however it goes wrong. See tenantSecretName above.
 */
export async function storeTenantToken(tenantId: string, install: SlackInstall): Promise<void> {
  const Name = tenantSecretName(tenantId);
  const SecretString = JSON.stringify({
    botToken: install.botToken,
    teamId: install.teamId,
    teamName: install.teamName,
    installedAt: new Date().toISOString(),
  });

  try {
    await secrets.send(new CreateSecretCommand({
      Name,
      SecretString,
      Description: `CloudMeter Slack bot token for tenant ${tenantId}`,
    }));
  } catch (err) {
    // Reinstalling, or a retried callback. Slack issues a fresh token each
    // time, so the newest wins.
    if ((err as { name?: string }).name !== 'ResourceExistsException') throw err;
    await secrets.send(new PutSecretValueCommand({ SecretId: Name, SecretString }));
  }

  // The sweeps cache per container; this one is about to be reused by the
  // caller's own verification.
  tokenCache.delete(tenantId);
}
