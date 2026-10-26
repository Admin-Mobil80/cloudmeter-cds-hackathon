import { ddb } from '../functions/shared/ddb';
import { persistMonthlySnapshots } from '../functions/shared/persist-cost';

/**
 * A provider that could not be asked for its tag breakdown must not erase the
 * one already stored.
 *
 * Every sync rewrites the whole six-month window, so a single refused call used
 * to blank every month at once — which is how the live Mobil80 OpenAI account
 * lost its project history to one 429. An empty breakdown and an unavailable
 * one look identical in the stored row; only the adapter knows the difference,
 * and it says so with `tagBreakdownUnavailable`.
 */

type Captured = { Key?: Record<string, string>; Item?: Record<string, unknown> };

/** Captures writes; answers reads with `existing`. */
function mockDdb(existing: Record<string, unknown> | null) {
  const writes: Captured[] = [];
  jest.spyOn(ddb, 'send').mockImplementation(((cmd: { input: Record<string, unknown> }) => {
    if ('Item' in cmd.input) {
      writes.push({ Item: cmd.input.Item as Record<string, unknown> });
      return Promise.resolve({});
    }
    return Promise.resolve({ Item: existing ?? undefined });
  }) as never);
  return writes;
}

afterEach(() => jest.restoreAllMocks());

const STORED = { Project: [{ label: 'Luna', spend: 82.46, untagged: false }] };

describe('persistMonthlySnapshots and an unavailable tag breakdown', () => {
  it('keeps the stored breakdown when the provider could not be asked', async () => {
    const writes = mockDdb({ tagBreakdown: STORED });

    await persistMonthlySnapshots('acct-1', [
      { monthKey: '2026-09', totalSpend: 93.4, tagBreakdown: {}, tagBreakdownUnavailable: true } as never,
    ]);

    expect(writes).toHaveLength(1);
    // The six months of project history survive the refused call.
    expect(writes[0].Item!.tagBreakdown).toEqual(STORED);
    // And the marker itself is never written to the table.
    expect(writes[0].Item).not.toHaveProperty('tagBreakdownUnavailable');
  });

  it('writes the empty breakdown when the provider genuinely has no tags', async () => {
    const writes = mockDdb({ tagBreakdown: STORED });

    await persistMonthlySnapshots('acct-1', [
      { monthKey: '2026-09', totalSpend: 93.4, tagBreakdown: {} } as never,
    ]);

    // No marker means the provider answered: an account whose tags really were
    // deactivated must clear, or the table keeps figures that no longer exist.
    expect(writes[0].Item!.tagBreakdown).toEqual({});
  });

  it('writes the fresh breakdown when one was fetched successfully', async () => {
    const fresh = { Project: [{ label: 'Twick', spend: 4, untagged: false }] };
    const writes = mockDdb({ tagBreakdown: STORED });

    await persistMonthlySnapshots('acct-1', [
      { monthKey: '2026-09', totalSpend: 4, tagBreakdown: fresh } as never,
    ]);

    expect(writes[0].Item!.tagBreakdown).toEqual(fresh);
  });

  it('still writes the row when there is nothing stored to keep', async () => {
    const writes = mockDdb(null);

    await persistMonthlySnapshots('acct-1', [
      { monthKey: '2026-09', totalSpend: 93.4, tagBreakdown: {}, tagBreakdownUnavailable: true } as never,
    ]);

    // A first-ever sync that is rate-limited has no history to protect; the
    // spend figures must still land.
    expect(writes).toHaveLength(1);
    expect(writes[0].Item!.totalSpend).toBe(93.4);
    expect(writes[0].Item!.tagBreakdown).toEqual({});
  });
});
