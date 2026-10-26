import { openaiAdapter, __resetProjectNameCache } from '../functions/shared/providers/openai';

/**
 * The project breakdown labels rows with a project's name where one can be
 * read, and with its raw id where one cannot.
 *
 * The name comes from a second endpoint needing a scope (api.management.read)
 * that the cost scope (api.usage.read) does not imply, so a perfectly good key
 * can read costs and be refused the names. That case must be invisible: the
 * breakdown keeps working and shows ids, exactly as it did before names
 * existed. These tests pin that down, because it is the failure mode nobody
 * will notice going wrong.
 */

const CREDS = { admin_api_key: 'sk-admin-test', organization_name: 'Test Org' };

// Names are cached per credential for a day; clear it so each case starts cold.
beforeEach(() => __resetProjectNameCache());

const COSTS = 'https://api.openai.com/v1/organization/costs';
const PROJECTS = 'https://api.openai.com/v1/organization/projects';

/** One day's bucket, split across projects. */
function bucket(startTime: number, rows: Array<[string | null, number]>) {
  return {
    start_time: startTime,
    results: rows.map(([project_id, value]) => ({ project_id, amount: { value } })),
  };
}

const DAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

/**
 * Stands in for the two endpoints. `projects` of `null` makes the Projects
 * endpoint fail the way a key without the management scope does.
 */
function mockFetch(opts: {
  projects: Array<{ id: string; name: string }> | null;
  projectStatus?: number;
  costRows: Array<[string | null, number]>;
}) {
  return jest.fn(async (url: string) => {
    const href = String(url);

    if (href.startsWith(PROJECTS)) {
      if (opts.projects === null) {
        return { ok: false, status: opts.projectStatus ?? 403, json: async () => ({}) } as never;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: opts.projects, has_more: false }),
      } as never;
    }

    if (href.startsWith(COSTS)) {
      const grouped = new URL(href).searchParams.get('group_by');
      // Only the project_id pull feeds the breakdown under test; the line_item
      // pull just has to return something well-formed.
      const data = grouped === 'project_id' ? [bucket(DAY, opts.costRows)] : [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data, has_more: false }),
      } as never;
    }

    throw new Error(`unexpected fetch: ${href}`);
  });
}

/** The Project rows of the most recent month. */
async function projectRows(fetchImpl: jest.Mock) {
  const realFetch = global.fetch;
  (global as { fetch: unknown }).fetch = fetchImpl;
  try {
    const snapshots = await openaiAdapter.fetchMonthlySnapshots(CREDS, 6);
    const current = snapshots[snapshots.length - 1];
    return (current.tagBreakdown ?? {}).Project ?? [];
  } finally {
    (global as { fetch: unknown }).fetch = realFetch;
  }
}

describe('OpenAI project breakdown labels', () => {
  it('uses the project name when the names can be read', async () => {
    const rows = await projectRows(mockFetch({
      projects: [
        { id: 'proj_luna', name: 'Luna' },
        { id: 'proj_twick', name: 'Twick RevenueCat' },
      ],
      costRows: [['proj_luna', 82.46], ['proj_twick', 4]],
    }));

    expect(rows.map((r) => r.label)).toEqual(['Luna', 'Twick RevenueCat']);
    expect(rows.map((r) => r.spend)).toEqual([82.46, 4]);
  });

  it('falls back to the raw id when the key cannot read project names', async () => {
    const rows = await projectRows(mockFetch({
      projects: null,          // 403: costs scope only
      costRows: [['proj_luna', 82.46], ['proj_twick', 4]],
    }));

    // Unchanged from the behaviour before names existed — the sync must not
    // fail, and no row may go missing.
    expect(rows.map((r) => r.label)).toEqual(['proj_luna', 'proj_twick']);
    expect(rows.map((r) => r.spend)).toEqual([82.46, 4]);
  });

  it('falls back to the id for a project missing from the name list', async () => {
    // A project created after the names were read, or one the endpoint omits.
    const rows = await projectRows(mockFetch({
      projects: [{ id: 'proj_luna', name: 'Luna' }],
      costRows: [['proj_luna', 82.46], ['proj_unlisted', 4]],
    }));

    expect(rows.map((r) => r.label)).toEqual(['Luna', 'proj_unlisted']);
  });

  it('keeps two projects apart when they share a display name', async () => {
    // Aggregating by label rather than by id would total these into one row.
    const rows = await projectRows(mockFetch({
      projects: [
        { id: 'proj_a', name: 'Shared' },
        { id: 'proj_b', name: 'Shared' },
      ],
      costRows: [['proj_a', 10], ['proj_b', 4]],
    }));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.spend)).toEqual([10, 4]);
  });

  it('still marks spend outside any project as untagged', async () => {
    const rows = await projectRows(mockFetch({
      projects: [{ id: 'proj_luna', name: 'Luna' }],
      costRows: [['proj_luna', 82.46], [null, 5]],
    }));

    const outside = rows.find((r) => r.untagged);
    expect(outside).toBeDefined();
    expect(outside!.label).toBe('No project');
    // A real project named "No project" must not be mistaken for it.
    expect(rows.filter((r) => r.untagged)).toHaveLength(1);
  });
});
