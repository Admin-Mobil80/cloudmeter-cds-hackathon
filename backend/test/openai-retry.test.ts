/**
 * Surviving a rate limit instead of failing the sync for an hour.
 *
 * OpenAI allows thirty Costs requests a minute for the whole organisation, and
 * one sync of a busy account makes several — following pagination, grouping by
 * line item and by project, for six months and for ninety days. On the live
 * Mobil80 account that is enough to exhaust the allowance inside a single
 * sweep: every 429 in a three-day sample happened within one invocation,
 * twelve of them in one.
 *
 * Until now a 429 failed the whole sync and waited for the next hour, leaving
 * a red banner on an account whose figures were usually fine. OpenAI says in a
 * header how long to wait — normally a second or two — and that is now
 * honoured, once.
 *
 * The wait is capped because this code runs behind the Refresh button as well
 * as in the sweep. The sweep has fifteen minutes; the button is an HTTP
 * request, and a long wait would turn a rate limit into a hang.
 */

import { retryAfterMs, openaiAdapter, __resetProjectNameCache } from '../functions/shared/providers/openai';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe('how long to wait after a 429', () => {
  it('uses Retry-After, which is in seconds', () => {
    expect(retryAfterMs(headers({ 'retry-after': '2' }))).toBe(2000);
  });

  it('reads the reset header when Retry-After is absent', () => {
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-requests': '1.5s' }))).toBe(1500);
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-requests': '800ms' }))).toBe(800);
  });

  it('prefers Retry-After when both are present', () => {
    expect(retryAfterMs(headers({
      'retry-after': '3', 'x-ratelimit-reset-requests': '10s',
    }))).toBe(3000);
  });

  it('refuses to wait longer than the cap', () => {
    /*
     * A limit asking for a minute is a sustained problem, not a burst. Waiting
     * it out would block the Refresh button past its own timeout and turn a
     * clear error into a hang.
     */
    expect(retryAfterMs(headers({ 'retry-after': '60' }))).toBeNull();
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-requests': '1m' }))).toBeNull();
  });

  it('does not invent a delay when it has nothing to go on', () => {
    // Backing off for a guessed interval is how one rate limit becomes a queue
    // of them. No header, no retry.
    expect(retryAfterMs(headers({}))).toBeNull();
    expect(retryAfterMs(headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(retryAfterMs(headers({ 'retry-after': '0' }))).toBeNull();
    expect(retryAfterMs(headers({ 'retry-after': '-5' }))).toBeNull();
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-requests': 'weird' }))).toBeNull();
  });
});

const CREDS = { admin_api_key: 'sk-admin-test', organization_name: 'Test Org' };
const PROJECTS = 'https://api.openai.com/v1/organization/projects';
const DAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

beforeEach(() => __resetProjectNameCache());

function ok(grouped: string | null) {
  const data = grouped === 'project_id'
    ? [{ start_time: DAY, results: [{ project_id: 'proj_a', amount: { value: 12 } }] }]
    : [{ start_time: DAY, results: [{ line_item: 'gpt-5.6-sol, input', amount: { value: 12 } }] }];
  return { ok: true, status: 200, headers: headers({}), text: async () => JSON.stringify({ data, has_more: false }) };
}

const limited = (h: Record<string, string>) => ({
  ok: false,
  status: 429,
  headers: headers(h),
  text: async () => JSON.stringify({
    error: { message: "You've exceeded the 30 request(s) every 1 minute(s) rate limit" },
  }),
});

/** Rate-limits the first `n` cost calls, then serves them normally. */
function mockFetch(n: number, h: Record<string, string>, calls: string[]) {
  let limitedSoFar = 0;
  return jest.fn(async (url: string) => {
    const href = String(url);
    if (href.startsWith(PROJECTS)) {
      return { ok: true, status: 200, headers: headers({}), json: async () => ({ data: [], has_more: false }) } as never;
    }
    calls.push(href);
    if (limitedSoFar < n) { limitedSoFar += 1; return limited(h) as never; }
    return ok(new URL(href).searchParams.get('group_by')) as never;
  });
}

async function run(fetchImpl: jest.Mock) {
  const real = global.fetch;
  (global as { fetch: unknown }).fetch = fetchImpl;
  try {
    return await openaiAdapter.fetchMonthlySnapshots(CREDS, 6);
  } finally {
    (global as { fetch: unknown }).fetch = real;
  }
}

describe('a rate-limited sync', () => {
  it('retries once and succeeds, instead of losing the hour', async () => {
    const calls: string[] = [];
    const snapshots = await run(mockFetch(1, { 'retry-after': '0.01' }, calls));

    // The first call was refused and the second served: two requests for one
    // page, and real data at the end of it.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('retries at most once, so a saturated limit is not queued against', async () => {
    /*
     * Two refusals in a row means the allowance is genuinely gone. Looping
     * would spend the lambda's budget making the limit worse, and on the
     * interactive path it would hold an HTTP request open to do it.
     */
    const calls: string[] = [];
    await expect(run(mockFetch(99, { 'retry-after': '0.01' }, calls)))
      .rejects.toThrow(/rate-limited/i);
    expect(calls.length).toBe(2);
  });

  it('does not retry when the wait would be too long', async () => {
    const calls: string[] = [];
    await expect(run(mockFetch(99, { 'retry-after': '600' }, calls)))
      .rejects.toThrow(/rate-limited/i);
    expect(calls.length).toBe(1);
  });

  it('does not retry when no header says how long', async () => {
    const calls: string[] = [];
    await expect(run(mockFetch(99, {}, calls))).rejects.toThrow(/rate-limited/i);
    expect(calls.length).toBe(1);
  });

  it('still reports the rate limit in the customer-facing wording', async () => {
    // The message on the account page is unchanged for the cases a retry
    // cannot save, so nothing a reader has learned to recognise moves.
    await expect(run(mockFetch(99, {}, []))).rejects
      .toThrow(/retried on the next sync/);
  });
});
