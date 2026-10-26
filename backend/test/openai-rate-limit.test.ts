import { openaiAdapter, __resetProjectNameCache } from '../functions/shared/providers/openai';

/**
 * A rate-limited project call must not erase the project history.
 *
 * OpenAI allows 30 Costs requests a minute for the whole organization. Once the
 * project breakdown was added, each sync of an account made three calls, and
 * the hourly sweep plus the account page's own refresh were enough to trip it.
 * The 429 was swallowed by a bare `.catch(() => [])`, so the sync stored
 * services normally and an empty tag breakdown — and because every sync
 * rewrites the whole six-month window, one refused call blanked every month at
 * once. On the live Mobil80 account that is exactly what happened:
 *
 *   ERROR OpenAI costs request failed { status: 429,
 *     body: "You've exceeded the 30 request(s) every 1 minute(s) rate limit" }
 *
 * "No projects exist" and "we could not ask" must stay distinguishable.
 */

const CREDS = { admin_api_key: 'sk-admin-test', organization_name: 'Test Org' };
const COSTS = 'https://api.openai.com/v1/organization/costs';
const PROJECTS = 'https://api.openai.com/v1/organization/projects';
const DAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

beforeEach(() => __resetProjectNameCache());

/** `projectStatus` of 429 makes only the project_id cost call fail. */
function mockFetch(opts: { projectCostStatus?: number; calls?: string[] }) {
  return jest.fn(async (url: string) => {
    const href = String(url);
    opts.calls?.push(href.split('?')[0] + (href.includes('group_by=') ? `?${href.split('group_by=')[1]}` : ''));

    if (href.startsWith(PROJECTS)) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'proj_a', name: 'Luna' }], has_more: false }) } as never;
    }

    const grouped = new URL(href).searchParams.get('group_by');
    if (grouped === 'project_id' && opts.projectCostStatus && opts.projectCostStatus !== 200) {
      return {
        ok: false,
        status: opts.projectCostStatus,
        text: async () => JSON.stringify({
          error: { message: "You've exceeded the 30 request(s) every 1 minute(s) rate limit" },
        }),
      } as never;
    }

    const data = grouped === 'project_id'
      ? [{ start_time: DAY, results: [{ project_id: 'proj_a', amount: { value: 12 } }] }]
      : [{ start_time: DAY, results: [{ line_item: 'gpt-5.6-sol, input', amount: { value: 12 } }] }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ data, has_more: false }) } as never;
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

describe('OpenAI project breakdown under rate limiting', () => {
  it('flags the breakdown unavailable when the project call is rate-limited', async () => {
    const snaps = await run(mockFetch({ projectCostStatus: 429 }));
    const current = snaps[snaps.length - 1] as typeof snaps[0] & { tagBreakdownUnavailable?: boolean };

    // The sync itself must still succeed — services are unaffected.
    expect(current.serviceBreakdown.length).toBeGreaterThan(0);
    // And it must say it could not ask, rather than reporting "no projects".
    expect(current.tagBreakdownUnavailable).toBe(true);
  });

  it('does not flag unavailable when the call simply returns no projects', async () => {
    const snaps = await run(mockFetch({}));
    const current = snaps[snaps.length - 1] as typeof snaps[0] & { tagBreakdownUnavailable?: boolean };

    expect(current.tagBreakdownUnavailable).toBeUndefined();
    expect(current.tagBreakdown.Project).toBeDefined();
  });

  it('skips the names lookup entirely when there is no project data to label', async () => {
    // One fewer request against the same 30/minute allowance, on exactly the
    // syncs that are already failing for want of headroom.
    const calls: string[] = [];
    await run(mockFetch({ projectCostStatus: 429, calls }));
    expect(calls.some((c) => c.startsWith(PROJECTS))).toBe(false);
  });

  it('makes the cost calls one at a time rather than in a burst', async () => {
    // Three concurrent calls per account is what tripped the limit.
    let inFlight = 0;
    let peak = 0;
    const base = mockFetch({});
    const counting = jest.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await base(url);
      } finally {
        inFlight -= 1;
      }
    });

    await run(counting as unknown as jest.Mock);
    expect(peak).toBe(1);
  });
});
