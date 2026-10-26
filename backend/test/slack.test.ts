/**
 * Posting to Slack, and what the daily digest looks like when it arrives.
 *
 * Two things here are easy to get wrong and expensive to discover late.
 *
 * The first is that Slack answers HTTP 200 for almost every failure and puts
 * the real result in the body as `{ ok: false, error: '...' }`. Treating the
 * status as success is how an integration reports a month of delivered
 * messages that nobody received — which is close to what happened to the
 * WhatsApp digests, where every send failed silently on a template mismatch.
 *
 * The second is `text`. Slack requires it even alongside blocks: it is what a
 * phone shows in the notification, so a message without it arrives as a blank
 * line.
 */

import {
  postMessage, SlackError, findUserByEmail, openDirectMessage, tokenForTenant,
  resetSlackConfigCache, exchangeOAuthCode,
} from '../functions/shared/slack';
import * as secretsModule from '@aws-sdk/client-secrets-manager';
import {
  digestBlocks, digestText, monthTrend, biggestMover, devMark,
} from '../functions/shared/digest-slack';
import type { Digest } from '../functions/shared/digest';

const USD = { code: 'USD', symbol: '$', rate: 1, localCode: 'USD', mode: 'USD', source: 'auto', rateSource: 'none', rateAsOf: null } as Digest['currency'];
const INR = { ...USD, code: 'INR', symbol: '₹', rate: 96.35, localCode: 'INR', mode: 'LOCAL' } as Digest['currency'];

const digest = (over: Partial<Digest> = {}): Digest => ({
  tenantName: 'ACME',
  dayKey: '2026-10-05',
  dayLabel: 'Oct 5',
  daysBehind: 1,
  daySpend: 11.95,
  monthToDate: 53.48,
  lastMonthToSamePoint: 125.03,
  monthDeltaPct: -57.2,
  movers: [],
  accountCount: 1,
  stale: [],
  currency: USD,
  ...over,
} as Digest);

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

/*
 * Production by default.
 *
 * Message content is asserted as a customer would see it; dev's "[dev]" mark
 * is the exception, and the describe that covers it sets its own TABLE_NAME.
 * Without this the marking leaks into every content assertion and the tests
 * stop describing what anyone actually receives.
 */
const ORIGINAL_TABLE = process.env.TABLE_NAME;
beforeEach(() => { process.env.TABLE_NAME = 'cloudmeter_prod'; });
afterAll(() => {
  if (ORIGINAL_TABLE === undefined) delete process.env.TABLE_NAME;
  else process.env.TABLE_NAME = ORIGINAL_TABLE;
});

/** Captures what was actually sent, and answers with whatever Slack would. */
function mockSlack(reply: unknown, status = 200) {
  const calls: Array<{
    url: string; body: Record<string, unknown>; auth: string; contentType: string;
  }> = [];
  global.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const contentType = init.headers['Content-Type'] ?? '';
    // postMessage sends JSON; the read methods must send form-encoded, so the
    // harness decodes whichever arrived rather than assuming.
    const body = contentType.startsWith('application/json')
      ? JSON.parse(init.body)
      : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url: String(url), body, auth: init.headers.Authorization, contentType });
    return { ok: status < 400, status, json: async () => reply };
  }) as unknown as typeof fetch;
  return calls;
}

describe('posting', () => {
  it('sends the message and reports where it landed', async () => {
    const calls = mockSlack({ ok: true, ts: '1728200000.1', channel: 'C123' });
    const out = await postMessage('xoxb-token', 'C123', 'hello');

    expect(out).toEqual({ ts: '1728200000.1', channel: 'C123' });
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0].auth).toBe('Bearer xoxb-token');
    expect(calls[0].body.channel).toBe('C123');
    expect(calls[0].body.text).toBe('hello');
  });

  it('carries the customer\'s own token, not an ambient one', async () => {
    // The token belongs to the tenant whose Slack this is. One tenant's token
    // must never post for another, which is why it is an argument.
    const calls = mockSlack({ ok: true, ts: '1', channel: 'C1' });
    await postMessage('xoxb-tenant-a', 'C1', 'x');
    await postMessage('xoxb-tenant-b', 'C2', 'y');
    expect(calls.map((c) => c.auth)).toEqual(['Bearer xoxb-tenant-a', 'Bearer xoxb-tenant-b']);
  });

  it('does not let a link preview double the message height', async () => {
    const calls = mockSlack({ ok: true, ts: '1', channel: 'C1' });
    await postMessage('t', 'C1', 'x', [{ type: 'divider' }]);
    expect(calls[0].body.unfurl_links).toBe(false);
    expect(calls[0].body.unfurl_media).toBe(false);
  });
});

describe('a failure Slack reports as HTTP 200', () => {
  it('is treated as a failure, not a delivery', async () => {
    // The whole point. `{ok:false}` arrives with a 200 status.
    mockSlack({ ok: false, error: 'channel_not_found' });
    await expect(postMessage('t', 'C-gone', 'x')).rejects.toThrow(SlackError);
  });

  it('keeps Slack\'s own code, so a log says what to do about it', async () => {
    mockSlack({ ok: false, error: 'not_in_channel' });
    await expect(postMessage('t', 'C1', 'x')).rejects.toMatchObject({ code: 'not_in_channel' });
  });

  it('knows which failures need a person rather than a retry', () => {
    // An install that has been removed or revoked cannot be retried into
    // working; somebody has to reconnect it.
    for (const code of ['invalid_auth', 'token_revoked', 'channel_not_found', 'not_in_channel', 'is_archived']) {
      expect(new SlackError(code).needsReconnect).toBe(true);
    }
    // A rate limit or an outage is exactly the opposite.
    for (const code of ['ratelimited', 'slack_unavailable', 'internal_error']) {
      expect(new SlackError(code).needsReconnect).toBe(false);
    }
  });

  it('reports a 5xx plainly rather than guessing at the body', async () => {
    mockSlack(null, 503);
    await expect(postMessage('t', 'C1', 'x')).rejects.toMatchObject({ code: 'slack_unavailable' });
  });

  it('does not treat an unreadable body as success', async () => {
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } })) as unknown as typeof fetch;
    await expect(postMessage('t', 'C1', 'x')).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('what the digest says', () => {
  it('has a notification line, so it is not a blank line on a phone', () => {
    expect(digestText(digest())).toBe('ACME — $12 on Oct 5');
  });

  it('quotes the tenant\'s own currency', () => {
    // Every figure stored is USD; the digest carries the conversion so the
    // email, the WhatsApp and the Slack post cannot disagree.
    expect(digestText(digest({ currency: INR }))).toBe('ACME — ₹1,151 on Oct 5');
  });

  it('names the direction of the month, not just a number', () => {
    // Worded to slot into the same sentence WhatsApp uses, so the two channels
    // describing one day read identically.
    expect(monthTrend(digest({ monthDeltaPct: -57.2 }))).toBe('down 57%');
    expect(monthTrend(digest({ monthDeltaPct: 12.4 }))).toBe('up 12%');
  });

  it('admits when there is nothing to compare', () => {
    expect(monthTrend(digest({ monthDeltaPct: null }))).toBe('no prior month to compare');
  });

  it('says plainly when nothing moved, in WhatsApp\'s words', () => {
    expect(biggestMover(digest())).toBe('nothing moved unusually');
  });

  it('names the mover and what it cost, in WhatsApp\'s words', () => {
    const d = digest({ movers: [{ service: 'Amazon DynamoDB', delta: 7744.53, baseline: 20 }] as Digest['movers'] });
    expect(biggestMover(d)).toBe('Amazon DynamoDB, up $7,745');
  });
});

describe('the blocks', () => {
  const find = (blocks: unknown[], type: string) =>
    blocks.filter((b) => (b as { type: string }).type === type);
  const asText = (blocks: unknown[]) => JSON.stringify(blocks);

  it('opens the dashboard at a real URL, however the portal URL was written', () => {
    for (const base of ['https://portal.cloudmeter.io', 'https://portal.cloudmeter.io/']) {
      const blocks = digestBlocks(digest(), base);
      expect(asText(blocks)).toContain('https://portal.cloudmeter.io/dashboard.html');
      expect(asText(blocks)).not.toContain('.io//dashboard');
    }
  });

  it('names accounts that are not syncing instead of quietly dropping them', () => {
    /*
     * A digest that omits a broken account reports a total that is too low and
     * looks entirely normal. The reader cannot spot it from the figures, so it
     * has to be said.
     */
    const d = digest({ stale: [{ name: 'Soylent AZ 01', provider: 'azure', lastSync: null }] });
    expect(asText(digestBlocks(d, 'https://p'))).toContain('Soylent AZ 01');
  });

  it('says nothing about syncing when everything is fine', () => {
    expect(asText(digestBlocks(digest(), 'https://p'))).not.toContain('Not syncing');
  });

  it('stays quiet about a one-day lag, which is normal', () => {
    expect(asText(digestBlocks(digest({ daysBehind: 1 }), 'https://p'))).not.toContain('days back');
  });

  it('says so when the data is further behind than usual', () => {
    // A reader seeing today's date on the message would otherwise assume
    // today's numbers.
    expect(asText(digestBlocks(digest({ daysBehind: 3 }), 'https://p'))).toContain('3 days back');
  });

  it('links to the dashboard as text, not as an interactive element', () => {
    /*
     * A plain link rather than a button, matching the WhatsApp message's
     * "Full breakdown:" line. It also sidesteps Slack's rule that every
     * interactive element needs an action_id and an app able to receive the
     * interaction — neither of which a one-way digest has any use for.
     */
    const blocks = digestBlocks(digest(), 'https://p');
    expect(find(blocks, 'actions')).toHaveLength(0);
    expect(asText(blocks)).toContain('Full breakdown:');
  });
});

describe('finding a person and opening a DM', () => {
  /*
   * How a Member gets their own digest without authorising Slack themselves.
   *
   * The workspace installs CloudMeter once; each person is then matched by the
   * email CloudMeter already knows them by. The alternative — an OAuth round
   * per person — would mean all 32 members of a workspace like Mobil80 clicking
   * through a Slack consent screen before any of them received anything.
   */
  it('matches a person by their email', async () => {
    const calls = mockSlack({ ok: true, user: { id: 'U123' } });
    await expect(findUserByEmail('t', 'rohan@mobil80.com')).resolves.toBe('U123');
    expect(calls[0].url).toBe('https://slack.com/api/users.lookupByEmail');
    expect(calls[0].body.email).toBe('rohan@mobil80.com');
  });

  it('asks form-encoded, which is the only way this method answers', async () => {
    /*
     * Found against the real API, not guessed. Slack's read methods accept
     * only application/x-www-form-urlencoded; sent JSON, users.lookupByEmail
     * answers `invalid_arguments`, which reads like a malformed email address
     * rather than the wrong content type. That is a day lost to the wrong
     * suspect, so it is pinned here.
     */
    const calls = mockSlack({ ok: true, user: { id: 'U1' } });
    await findUserByEmail('t', 'a@b.com');
    expect(calls[0].contentType).toContain('application/x-www-form-urlencoded');
  });

  it('treats no match as an answer, not a failure', async () => {
    /*
     * Plenty of people use a different address on Slack than at work. That is
     * a thing to tell them on the Notifications page, not an error to throw
     * through a digest sweep sending to nineteen other people.
     */
    mockSlack({ ok: false, error: 'users_not_found' });
    await expect(findUserByEmail('t', 'nobody@example.com')).resolves.toBeNull();
  });

  it('still raises a real failure', async () => {
    // A revoked token is not "no such user" and must not look like one.
    mockSlack({ ok: false, error: 'invalid_auth' });
    await expect(findUserByEmail('t', 'x@y.com')).rejects.toMatchObject({ code: 'invalid_auth' });
  });

  it('opens the DM and returns the channel to post to', async () => {
    const calls = mockSlack({ ok: true, channel: { id: 'D456' } });
    await expect(openDirectMessage('t', 'U123')).resolves.toBe('D456');
    expect(calls[0].url).toBe('https://slack.com/api/conversations.open');
    expect(calls[0].body.users).toBe('U123');
  });

  it('does not pretend to have a channel it was not given', async () => {
    mockSlack({ ok: true, channel: {} });
    await expect(openDirectMessage('t', 'U123')).rejects.toMatchObject({ code: 'no_dm_channel' });
  });
});

describe('the per-tenant token', () => {
  /*
   * A secret each, not one shared map.
   *
   * Secrets Manager can only replace a whole secret, so a shared map means
   * every install does read-modify-write over every customer's token — and a
   * bug writing the new entry instead of the merged set silently deletes
   * everyone else's Slack. Nothing errors; it surfaces days later as "the
   * digests stopped". A secret each makes that impossible for about $0.40 a
   * month per tenant.
   */
  afterEach(() => { resetSlackConfigCache(); jest.restoreAllMocks(); });

  const mockSecret = (fn: (id: string) => unknown) =>
    jest.spyOn(secretsModule.SecretsManagerClient.prototype, 'send')
      .mockImplementation(((cmd: { input: { SecretId: string } }) =>
        Promise.resolve(fn(cmd.input.SecretId))) as never);

  it('reads only its own tenant\'s secret', async () => {
    const seen: string[] = [];
    mockSecret((id) => { seen.push(id); return { SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }; });

    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');
    expect(seen).toEqual(['cloudmeter/slack/tenant/t1']);
  });

  it('keeps one tenant\'s token away from another\'s', async () => {
    mockSecret((id) => ({
      SecretString: JSON.stringify({ botToken: `xoxb-${id.split('/').pop()}` }),
    }));

    await expect(tokenForTenant('mobil80')).resolves.toBe('xoxb-mobil80');
    await expect(tokenForTenant('hooli')).resolves.toBe('xoxb-hooli');
  });

  it('is null for a tenant that has not connected Slack', async () => {
    /*
     * The ordinary case for most tenants. A missing secret is how that looks,
     * and it must not interrupt a sweep that is also sending them email.
     */
    mockSecret(() => { const e = new Error('not found'); e.name = 'ResourceNotFoundException'; throw e; });
    await expect(tokenForTenant('nobody')).resolves.toBeNull();
  });

  it('does not mistake a real failure for "no Slack"', async () => {
    // A permissions problem or a malformed value is worth a log line rather
    // than being swallowed as an unconnected tenant.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSecret(() => { const e = new Error('denied'); e.name = 'AccessDeniedException'; throw e; });

    await expect(tokenForTenant('t1')).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it('asks Secrets Manager once per tenant, not once per message', async () => {
    // The sweep sends many messages for one tenant; re-reading the secret for
    // each would put a Secrets Manager call and its cost on every message.
    let reads = 0;
    mockSecret(() => { reads += 1; return { SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }; });

    await tokenForTenant('t1');
    await tokenForTenant('t1');
    await tokenForTenant('t1');
    expect(reads).toBe(1);
  });

  it('caches an unconnected tenant too', async () => {
    // Most tenants have no Slack; re-asking for each on every sweep is the
    // same wasted call.
    let reads = 0;
    mockSecret(() => { reads += 1; const e = new Error('x'); e.name = 'ResourceNotFoundException'; throw e; });

    await tokenForTenant('nobody');
    await tokenForTenant('nobody');
    expect(reads).toBe(1);
  });
});


describe('the Slack message says what the WhatsApp one says', () => {
  /*
   * The first version was laid out natively for Slack — the day and the month
   * side by side in a two-column field block, no labels — and read as thinner
   * than the WhatsApp message even though it carried the same numbers. Two
   * channels describing one day should not feel like two different reports.
   *
   * These pin the wording to the approved WhatsApp template:
   *
   *   HEADER: CloudMeter daily summary for {{1}}
   *   BODY:   Spend on {{1}}: {{2}}
   *           Month to date: {{3}} ({{4}} vs the same point last month)
   *           Biggest mover: {{5}}
   */
  const text = (d = digest()) => JSON.stringify(digestBlocks(d, 'https://portal.cloudmeter.io'));

  it('opens with the same header line', () => {
    expect(text()).toContain('CloudMeter daily summary for ACME');
  });

  it('labels the day the same way', () => {
    expect(text()).toContain('Spend on Oct 5:');
  });

  it('writes the month line as one sentence, as the template does', () => {
    expect(text()).toContain('Month to date: *$53* (down 57% vs the same point last month)');
  });

  it('labels the mover the same way', () => {
    expect(text()).toContain('Biggest mover: nothing moved unusually');
  });

  it('offers the full breakdown, as the template does', () => {
    expect(text()).toContain('Full breakdown:');
    expect(text()).toContain('https://portal.cloudmeter.io/dashboard.html');
  });

  it('closes with the same line about managing alerts', () => {
    expect(text()).toContain('Manage alerts in CloudMeter → Notifications');
  });

  it('keeps the two things WhatsApp has no room for', () => {
    // Both only appear when they apply, so the ordinary message stays the
    // length of the WhatsApp one.
    const broken = digest({ stale: [{ name: 'Soylent AZ 01', provider: 'azure', lastSync: null }] });
    expect(text(broken)).toContain('Soylent AZ 01');
    expect(text(digest({ daysBehind: 3 }))).toContain('3 days back');
    expect(text()).not.toContain('Not syncing');
    expect(text()).not.toContain('days back');
  });
});

describe('exchanging the install code', () => {
  /*
   * The moment a workspace becomes a tenant CloudMeter can post for, and the
   * only call that uses CloudMeter's own app credentials rather than a
   * tenant's token.
   */
  const ORIGINAL = process.env.SLACK_SECRET_ARN;
  beforeEach(() => {
    process.env.SLACK_SECRET_ARN = 'arn:test';
    jest.spyOn(secretsModule.SecretsManagerClient.prototype, 'send')
      .mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      } as never);
    resetSlackConfigCache();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SLACK_SECRET_ARN;
    else process.env.SLACK_SECRET_ARN = ORIGINAL;
    resetSlackConfigCache();
    jest.restoreAllMocks();
  });

  it('returns the workspace and its bot token', async () => {
    const calls = mockSlack({
      ok: true, access_token: 'xoxb-new', team: { id: 'T1', name: 'Hooli' },
    });
    await expect(exchangeOAuthCode('code-1', 'https://api/callback')).resolves.toEqual({
      botToken: 'xoxb-new', teamId: 'T1', teamName: 'Hooli',
    });
    expect(calls[0].url).toBe('https://slack.com/api/oauth.v2.access');
    expect(calls[0].body.code).toBe('code-1');
    expect(calls[0].body.redirect_uri).toBe('https://api/callback');
  });

  it('sends the app credentials, not a tenant token', async () => {
    // This is the one call authenticated as CloudMeter itself.
    const calls = mockSlack({ ok: true, access_token: 'xoxb-new', team: { id: 'T1', name: 'X' } });
    await exchangeOAuthCode('c', 'https://api/callback');
    expect(calls[0].body.client_id).toBe('cid');
    expect(calls[0].body.client_secret).toBe('csec');
  });

  it('refuses an install that granted no bot token', async () => {
    /*
     * oauth.v2.access answers with a user token or a bot token depending on
     * what was requested. A user token would post as whoever installed the
     * app, so every digest would appear to come from that person rather than
     * from CloudMeter — worth failing over, not papering over.
     */
    mockSlack({ ok: true, team: { id: 'T1', name: 'X' } });
    await expect(exchangeOAuthCode('c', 'https://api/callback'))
      .rejects.toMatchObject({ code: 'no_bot_token' });
  });

  it('keeps Slack\'s own refusal', async () => {
    // An expired or reused code is the commonest, and the log should say so.
    mockSlack({ ok: false, error: 'invalid_code' });
    await expect(exchangeOAuthCode('c', 'https://api/callback'))
      .rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('says plainly when CloudMeter has no Slack app credentials', async () => {
    jest.restoreAllMocks();
    jest.spyOn(secretsModule.SecretsManagerClient.prototype, 'send')
      .mockResolvedValue({ SecretString: JSON.stringify({}) } as never);
    resetSlackConfigCache();
    await expect(exchangeOAuthCode('c', 'https://api/callback'))
      .rejects.toMatchObject({ code: 'not_configured' });
  });

  it('survives a workspace that reports no name', async () => {
    mockSlack({ ok: true, access_token: 'xoxb-new', team: {} });
    await expect(exchangeOAuthCode('c', 'https://api/callback'))
      .resolves.toMatchObject({ botToken: 'xoxb-new', teamId: '', teamName: '' });
  });
});

describe('telling dev\'s messages apart from the real ones', () => {
  /*
   * Dev and prod share one Slack app and post into the same conversation. A
   * dev digest for ACME has sat directly above a prod digest for Mobil80
   * with nothing to distinguish them — legible only if you happen to remember
   * which workspaces exist where.
   *
   * Email solved this in September with a "[dev → …]" subject prefix, after a
   * dev message told a real person their CloudMeter subscription had ended.
   * Slack had no equivalent, and it stops being harmless the moment a customer
   * connects and their dev workspace messages them.
   */
  const ORIGINAL = process.env.TABLE_NAME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = ORIGINAL;
  });

  it('leaves production untouched', () => {
    // The direction that matters most: a customer must never see "[dev]" on a
    // real message.
    process.env.TABLE_NAME = 'cloudmeter_prod';
    expect(devMark('CloudMeter daily summary for Mobil80'))
      .toBe('CloudMeter daily summary for Mobil80');
  });

  it('marks dev', () => {
    process.env.TABLE_NAME = 'cloudmeter_dev';
    expect(devMark('CloudMeter daily summary for ACME'))
      .toBe('[dev] CloudMeter daily summary for ACME');
  });

  it('marks anything that is not plainly production', () => {
    /*
     * Erring toward marking is the safe direction. An unmarked dev message can
     * be mistaken for the real thing and acted on; a marked production message
     * is merely untidy.
     */
    for (const table of ['', 'cloudmeter_staging', 'something_else', 'cloudmeter_prodtest_dev']) {
      process.env.TABLE_NAME = table;
      expect(devMark('x')).toBe('[dev] x');
    }
  });

  it('recognises production however the table is spelled', () => {
    // The same latitude the email guard allows, since both read one value.
    for (const table of ['cloudmeter_prod', 'cloudmeter-prod', 'CloudMeter_PROD', ' cloudmeter_prod ']) {
      process.env.TABLE_NAME = table;
      expect(devMark('x')).toBe('x');
    }
  });

  it('marks both the notification line and the heading', () => {
    /*
     * The preview on a phone is the notification line; the heading is what is
     * read in the conversation. Marking one and not the other leaves the
     * message ambiguous in whichever place the reader looks.
     */
    process.env.TABLE_NAME = 'cloudmeter_dev';
    expect(digestText(digest())).toContain('[dev]');
    expect(JSON.stringify(digestBlocks(digest(), 'https://p'))).toContain('[dev]');
  });

  it('keeps production digests clean in both places', () => {
    process.env.TABLE_NAME = 'cloudmeter_prod';
    expect(digestText(digest())).not.toContain('[dev]');
    expect(JSON.stringify(digestBlocks(digest(), 'https://p'))).not.toContain('[dev]');
  });
});
