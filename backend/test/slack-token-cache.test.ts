/**
 * Remembering that a workspace has Slack, and forgetting quickly that it does not.
 *
 * The token cache used to hold its answer for the life of the container,
 * including `null`. On 2026-10-09 that broke the first real OAuth install on
 * prod: Mobil80 installed CloudMeter into Slack, and a warm lambda container
 * holding a `null` from a few minutes earlier went on telling the
 * Notifications page "Nobody has set up Slack for this workspace yet". Connect
 * failed with a 409 that logged nothing, so from the outside the install
 * simply appeared not to have worked. It had worked perfectly — only the
 * memory of its absence was stale.
 *
 * `storeTenantToken` clears the cache, but only in its own container; the
 * install runs in the OAuth callback lambda while the page is served by
 * another. Nothing could reach across.
 *
 * So the rule is asymmetric, and the asymmetry is the point: "no token" is the
 * one answer that changes at the exact moment somebody is watching, and a
 * found token is the one that almost never does.
 */

import { tokenForTenant, resetSlackConfigCache } from '../functions/shared/slack';
import * as secretsModule from '@aws-sdk/client-secrets-manager';

const NO_TOKEN_TTL_MS = 30 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Counts reads so a cache hit is distinguishable from a repeat lookup. */
function mockSecrets(answer: (id: string) => unknown) {
  const reads: string[] = [];
  jest.spyOn(secretsModule.SecretsManagerClient.prototype, 'send')
    .mockImplementation(((cmd: { input: { SecretId: string } }) => {
      reads.push(cmd.input.SecretId);
      const out = answer(cmd.input.SecretId);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out);
    }) as never);
  return reads;
}

const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-09T09:00:00Z'));
  resetSlackConfigCache();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetSlackConfigCache();
});

describe('a workspace that has Slack', () => {
  it('is read once and then remembered', async () => {
    const reads = mockSecrets(() => ({ SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }));

    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');
    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');
    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');

    // The whole point of caching: one Secrets Manager call per message would
    // put a cost on every digest line.
    expect(reads).toHaveLength(1);
  });

  it('is still remembered well after an install would have settled', async () => {
    const reads = mockSecrets(() => ({ SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }));
    await tokenForTenant('t1');

    jest.advanceTimersByTime(NO_TOKEN_TTL_MS * 5);
    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');
    expect(reads).toHaveLength(1);
  });

  it('is eventually re-read, so a rotated token is picked up', async () => {
    let current = 'xoxb-old';
    const reads = mockSecrets(() => ({ SecretString: JSON.stringify({ botToken: current }) }));

    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-old');
    current = 'xoxb-new';

    jest.advanceTimersByTime(TOKEN_TTL_MS + 1);
    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-new');
    expect(reads).toHaveLength(2);
  });
});

describe('a workspace that has not connected Slack', () => {
  it('is remembered briefly, so one sweep does not ask repeatedly', async () => {
    /*
     * Most tenants have no Slack. Without this, a sweep sending email to
     * twenty of them would make a Secrets Manager call per tenant per send.
     */
    const reads = mockSecrets(() => { throw notFound(); });

    await expect(tokenForTenant('t1')).resolves.toBeNull();
    jest.advanceTimersByTime(NO_TOKEN_TTL_MS - 1);
    await expect(tokenForTenant('t1')).resolves.toBeNull();

    expect(reads).toHaveLength(1);
  });

  it('is forgotten soon enough that an install is noticed', async () => {
    /*
     * The prod failure, in miniature. The page asks, gets "no", the workspace
     * installs, and the very next thing the person does is press Connect.
     */
    let installed = false;
    const reads = mockSecrets(() => {
      if (!installed) throw notFound();
      return { SecretString: JSON.stringify({ botToken: 'xoxb-fresh' }) };
    });

    await expect(tokenForTenant('mobil80')).resolves.toBeNull();

    installed = true;
    jest.advanceTimersByTime(NO_TOKEN_TTL_MS + 1);

    await expect(tokenForTenant('mobil80')).resolves.toBe('xoxb-fresh');
    expect(reads).toHaveLength(2);
  });

  it('does not hold the old answer for the life of the container', async () => {
    // The literal regression. Before the fix this stayed null for as long as
    // the container lived — minutes or hours — with nothing able to clear it
    // from another lambda.
    let installed = false;
    mockSecrets(() => {
      if (!installed) throw notFound();
      return { SecretString: JSON.stringify({ botToken: 'xoxb-fresh' }) };
    });

    await tokenForTenant('mobil80');
    installed = true;

    jest.advanceTimersByTime(60 * 60 * 1000);
    await expect(tokenForTenant('mobil80')).resolves.toBe('xoxb-fresh');
  });
});

describe('what the cache keeps separate', () => {
  it('never hands one tenant the answer belonging to another', async () => {
    mockSecrets((id) => {
      if (id.endsWith('/none')) throw notFound();
      return { SecretString: JSON.stringify({ botToken: `xoxb-${id.split('/').pop()}` }) };
    });

    await expect(tokenForTenant('alpha')).resolves.toBe('xoxb-alpha');
    await expect(tokenForTenant('none')).resolves.toBeNull();
    await expect(tokenForTenant('beta')).resolves.toBe('xoxb-beta');
    // Re-reading alpha must not be disturbed by the miss in between.
    await expect(tokenForTenant('alpha')).resolves.toBe('xoxb-alpha');
  });

  it('expires each tenant on its own clock', async () => {
    const reads = mockSecrets((id) => (id.endsWith('/none')
      ? (() => { throw notFound(); })()
      : { SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }));

    await tokenForTenant('withslack');
    await tokenForTenant('none');
    jest.advanceTimersByTime(NO_TOKEN_TTL_MS + 1);

    // The miss has expired; the hit has not.
    await tokenForTenant('none');
    await tokenForTenant('withslack');
    expect(reads.filter((r) => r.endsWith('/none'))).toHaveLength(2);
    expect(reads.filter((r) => r.endsWith('/withslack'))).toHaveLength(1);
  });

  it('is cleared wholesale by resetSlackConfigCache', async () => {
    const reads = mockSecrets(() => ({ SecretString: JSON.stringify({ botToken: 'xoxb-a' }) }));
    await tokenForTenant('t1');
    resetSlackConfigCache();
    await tokenForTenant('t1');
    expect(reads).toHaveLength(2);
  });
});

describe('a lookup that fails for a reason other than absence', () => {
  it('is not remembered as "no Slack"', async () => {
    /*
     * A permissions problem or a throttle is a fault, not an answer. Caching
     * it the way a genuine absence is cached would turn a blip into half an
     * hour of a workspace appearing unconnected.
     */
    let broken = true;
    const reads = mockSecrets(() => {
      if (broken) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return { SecretString: JSON.stringify({ botToken: 'xoxb-a' }) };
    });

    await expect(tokenForTenant('t1')).resolves.toBeNull();
    broken = false;

    // No clock advance at all: a fault is not cached even briefly, so the very
    // next call asks again.
    await expect(tokenForTenant('t1')).resolves.toBe('xoxb-a');
    expect(reads).toHaveLength(2);
  });

  it('still returns null to the caller, so a sweep is not interrupted', async () => {
    // Email to that tenant must go out regardless; Slack simply has nothing to
    // post with this time round.
    mockSecrets(() => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); });
    await expect(tokenForTenant('t1')).resolves.toBeNull();
  });
});
