import { openaiAdapter } from '../functions/shared/providers/openai';

/**
 * The daily fetch against a fake OpenAI, so the project split can be checked
 * without an admin key. Dev has no OpenAI account to run this against.
 */

const DAY = 86400;
// 21 Sep 2026 00:00 UTC, the day this was built for.
const SEP_21 = Date.UTC(2026, 8, 21) / 1000;

/** A Response-alike offering both readers, since the adapter uses each in places. */
function reply(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body };
}

function costsResponse(buckets: unknown[]) {
  return reply(200, { data: buckets, has_more: false });
}

function projectsResponse() {
  return reply(200, {
    data: [
      { id: 'proj_rehearse', name: 'Rehearse RevenueCat' },
      { id: 'proj_luna', name: 'Luna' },
    ],
    has_more: false,
  });
}

const IMAGE = 'gpt-image-1 image, output';
const TEXT = 'gpt-image-1 text, input';

/** What the two calls answer: by line item, and by line item × project. */
function fakeFetch(opts: { projectCallFails?: boolean } = {}) {
  return jest.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/organization/projects')) return projectsResponse();

    const groups = u.searchParams.getAll('group_by');
    const byProject = groups.includes('project_id');
    if (byProject && opts.projectCallFails) {
      return reply(429, { error: { message: 'rate limited' } });
    }

    const bucket = (results: unknown[]) => ({ start_time: SEP_21, end_time: SEP_21 + DAY, results });
    if (!byProject) {
      return costsResponse([bucket([
        { line_item: IMAGE, amount: { value: 16.598 + 0.011 } },
        { line_item: TEXT, amount: { value: 0.08 } },
      ])]);
    }
    return costsResponse([bucket([
      { line_item: IMAGE, project_id: 'proj_rehearse', amount: { value: 16.598 } },
      { line_item: IMAGE, project_id: 'proj_initrode', amount: { value: 0.011 } },
      { line_item: TEXT, project_id: 'proj_luna', amount: { value: 0.08 } },
      // OpenAI reports every line item it has ever seen, most of them at $0.
      { line_item: 'whisper audio, input', project_id: 'proj_luna', amount: { value: 0 } },
      { line_item: 'o3 text, input', project_id: 'proj_luna', amount: { value: 0 } },
    ])]);
  });
}

const creds = { admin_api_key: 'sk-admin-test' } as never;
// Optional on the adapter interface; OpenAI always implements it.
const fetchDaily = (days: number) => openaiAdapter.fetchDailySnapshots!(creds, days);

describe('OpenAI daily project split', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    // Freeze "today" at 22 Sep. A two-day window is then [21st, 22nd], and
    // the first entry is the complete day the fake API answers for.
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 22, 6)));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('attributes each service to its projects, names resolved', async () => {
    global.fetch = fakeFetch() as never;
    const [day] = await fetchDaily(2);

    expect(day.dayKey).toBe('2026-09-21');
    expect(day.projectBreakdown).toBeDefined();
    const image = day.projectBreakdown![IMAGE];
    expect(image[0]).toEqual({ label: 'Rehearse RevenueCat', spend: 16.598 });
    // An id with no name known falls back to the id, as the monthly view does.
    expect(image[1]).toEqual({ label: 'proj_initrode', spend: 0.011 });
    expect(day.projectBreakdown![TEXT]).toEqual([{ label: 'Luna', spend: 0.08 }]);
  });

  it('leaves the service totals exactly as the line-item call reported them', async () => {
    // The split is a second call; it must not alter what every chart and
    // baseline is built from.
    global.fetch = fakeFetch() as never;
    const [day] = await fetchDaily(2);
    const image = day.serviceBreakdown.find((s) => s.name === IMAGE);
    expect(image?.spend).toBeCloseTo(16.609, 6);
    expect(day.totalSpend).toBeCloseTo(16.689, 6);
  });

  it('survives the project call failing, and simply carries no split', async () => {
    // A rate limit on the second call must not take the numbers down with it.
    global.fetch = fakeFetch({ projectCallFails: true }) as never;
    const [day] = await fetchDaily(2);
    expect(day.totalSpend).toBeCloseTo(16.689, 6);
    expect(day.projectBreakdown).toBeUndefined();
    expect('projectBreakdown' in day).toBe(false);
  });

  it('drops line items that cost nothing that day', async () => {
    // Thirty of fifty names on one real day pointed at nothing. The split
    // should list the same services the spend breakdown does, and no more.
    global.fetch = fakeFetch() as never;
    const [day] = await fetchDaily(2);
    expect(Object.keys(day.projectBreakdown!).sort()).toEqual([IMAGE, TEXT].sort());
    expect(day.projectBreakdown!['whisper audio, input']).toBeUndefined();
    expect(day.projectBreakdown!['o3 text, input']).toBeUndefined();
  });

  it('asks for both dimensions in one call', async () => {
    const f = fakeFetch();
    global.fetch = f as never;
    await fetchDaily(2);
    const urls = f.mock.calls.map((c) => new URL(c[0] as string));
    const split = urls.find((u) => u.searchParams.getAll('group_by').includes('project_id'));
    expect(split?.searchParams.getAll('group_by')).toEqual(['line_item', 'project_id']);
  });
});
