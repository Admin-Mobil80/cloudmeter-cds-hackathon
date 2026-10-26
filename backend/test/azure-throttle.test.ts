/**
 * Surviving an Azure rate limit instead of losing the day.
 *
 * `Soylent AZ 01` failed on six of the last eight days with "Too many
 * requests. Please retry." Every hourly sweep made the same two requests — the
 * first cost metric, then the alternate one after the first was rejected — and
 * both were refused, because a throttle says nothing about which metric the
 * subscription uses. The account sat in `status: error` with no fresh data and
 * nothing retried it.
 *
 * Two behaviours matter here, and the second is easy to miss: wait the length
 * Azure asks for, and do not spend a second request trying the other metric
 * when the refusal was about rate rather than correctness.
 */

import { azureRetryAfterMs } from '../functions/shared/providers/azure';

/** Shaped like the RestError the Azure SDK throws. */
function restError(status: number, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.assign(new Error('Too many requests. Please retry.'), {
    name: 'RestError',
    statusCode: status,
    // The SDK's header bag is a Map-like with a lower-casing get.
    response: { headers: { get: (n: string) => lower[n.toLowerCase()] ?? undefined } },
  });
}

describe('how long to wait after an Azure throttle', () => {
  it('uses Retry-After, which is in seconds', () => {
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': '2' }))).toBe(2000);
  });

  it('reads the Cost Management entity header', () => {
    expect(azureRetryAfterMs(restError(429, {
      'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '3',
    }))).toBe(3000);
  });

  it('reads the tenant and consumption headers too', () => {
    // Azure names this differently per resource provider, and the one that
    // arrives depends on which limit was hit.
    expect(azureRetryAfterMs(restError(429, {
      'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after': '4',
    }))).toBe(4000);
    expect(azureRetryAfterMs(restError(429, {
      'x-ms-ratelimit-microsoft.consumption-retry-after': '5',
    }))).toBe(5000);
  });

  it('prefers Retry-After when several are present', () => {
    expect(azureRetryAfterMs(restError(429, {
      'Retry-After': '1',
      'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '9',
    }))).toBe(1000);
  });

  it('refuses a wait longer than the cap', () => {
    /*
     * Azure often asks for a minute on a sustained limit. Waiting that out
     * would hold the Refresh button's HTTP request open past its own timeout
     * and turn a clear error into a hang.
     */
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': '60' }))).toBeNull();
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': '13' }))).toBeNull();
  });

  it('does not invent a delay when nothing says how long', () => {
    expect(azureRetryAfterMs(restError(429))).toBeNull();
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': 'soon' }))).toBeNull();
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': '0' }))).toBeNull();
    expect(azureRetryAfterMs(restError(429, { 'Retry-After': '-3' }))).toBeNull();
  });
});

describe('what is not a throttle', () => {
  it('ignores every other status', () => {
    // 401 and 403 are the adapter's own concern and must keep their existing
    // handling — a credentials problem is not something waiting fixes.
    for (const status of [400, 401, 403, 404, 500, 503]) {
      expect(azureRetryAfterMs(restError(status, { 'Retry-After': '2' }))).toBeNull();
    }
  });

  it('ignores an error that is not a RestError at all', () => {
    expect(azureRetryAfterMs(new Error('network down'))).toBeNull();
    expect(azureRetryAfterMs(undefined)).toBeNull();
    expect(azureRetryAfterMs(null)).toBeNull();
  });

  it('survives a throttle with no response attached', () => {
    const err = Object.assign(new Error('429'), { name: 'RestError', statusCode: 429 });
    expect(azureRetryAfterMs(err)).toBeNull();
  });
});

// ---- behaviour ----------------------------------------------------------

import { queryWithMetricFallback } from '../functions/shared/providers/azure';
import type { CostManagementClient } from '@azure/arm-costmanagement';

/** A client that answers from a queue, recording the metric each call asked for. */
function fakeClient(answers: Array<'ok' | Error>) {
  const asked: string[] = [];
  let i = 0;
  const client = {
    query: {
      usage: async (_scope: string, def: { dataset?: { aggregation?: Record<string, { name?: string }> } }) => {
        asked.push(Object.values(def.dataset?.aggregation ?? {})[0]?.name ?? '?');
        const a = answers[i++];
        if (a instanceof Error) throw a;
        return { columns: [], rows: [] };
      },
    },
  } as unknown as CostManagementClient;
  return { client, asked };
}

const build = (metric: string) => ({
  type: 'ActualCost', timeframe: 'Custom',
  dataset: { aggregation: { totalCost: { name: metric, function: 'Sum' } } },
} as never);

describe('a throttled cost query', () => {
  it('waits the stated time and succeeds on the retry', async () => {
    const { client, asked } = fakeClient([restError(429, { 'Retry-After': '0.01' }), 'ok']);
    const out = await queryWithMetricFallback(client, '/subscriptions/x', build);

    expect(out.result).toBeDefined();
    // Retried the SAME metric — a throttle says nothing about which is right.
    expect(asked).toEqual([asked[0], asked[0]]);
  });

  it('does not spend a request on the other metric when still throttled', async () => {
    /*
     * The six-day failure, in miniature. Before this, a 429 fell through to
     * the alternate metric and was refused again — two requests per sweep
     * against a limit that had just said no.
     */
    const { client, asked } = fakeClient([
      restError(429, { 'Retry-After': '0.01' }),
      restError(429, { 'Retry-After': '0.01' }),
      'ok',
    ]);
    await expect(queryWithMetricFallback(client, '/subscriptions/x', build)).rejects.toThrow();
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(1);
  });

  it('does not retry at all when Azure says nothing about how long', async () => {
    const { client, asked } = fakeClient([restError(429), 'ok']);
    await expect(queryWithMetricFallback(client, '/subscriptions/x', build)).rejects.toThrow();
    expect(asked).toHaveLength(1);
  });
});

describe('the metric fallback still works', () => {
  it('tries the alternate metric when the first is rejected for a real reason', async () => {
    // 400 means this subscription uses the other cost metric — the original
    // purpose of this loop, which must survive the throttle handling.
    const { client, asked } = fakeClient([restError(400), 'ok']);
    const out = await queryWithMetricFallback(client, '/subscriptions/x', build);

    expect(out.result).toBeDefined();
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(2);
  });

  it('throws the first error when every metric fails', async () => {
    const { client, asked } = fakeClient([restError(403), restError(403)]);
    await expect(queryWithMetricFallback(client, '/subscriptions/x', build)).rejects.toThrow();
    expect(asked).toHaveLength(2);
  });
});
