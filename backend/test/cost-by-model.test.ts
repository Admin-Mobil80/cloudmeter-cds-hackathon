import { costByModel, projectModelHistory } from '../functions/shared/cost-by-model';
import { comparisonWindow } from '../functions/shared/period';

/**
 * The join the monthly row cannot make: which models each project used,
 * and how that compares to the same days last month.
 */

const IMAGE = 'gpt-image-1 image, output';
const SOL_IN = 'gpt-5.6-sol, input';

function day(dayKey: string, totalSpend: number, split?: Record<string, Array<{ label: string; spend: number }>>) {
  return split ? { dayKey, totalSpend, projectBreakdown: split } : { dayKey, totalSpend };
}

// 22 Sep: the window is 1–21 Sep against 1–21 Aug.
const NOW = new Date('2026-09-22T06:00:00Z');
const WINDOW = comparisonWindow(NOW)!;

const SEPTEMBER = [
  day('2026-09-20', 3.12, { [IMAGE]: [{ label: 'Luna', spend: 0.12 }], [SOL_IN]: [{ label: 'Luna', spend: 2 }, { label: 'Expenze', spend: 1 }] }),
  day('2026-09-21', 17.74, { [IMAGE]: [{ label: 'Rehearse RevenueCat', spend: 16.24 }], [SOL_IN]: [{ label: 'Expenze', spend: 1.5 }] }),
  day('2026-09-19', 0),                        // a $0 day: nothing to split, NOT a gap
  day('2026-09-22', 5),                        // today, beyond the window: counts to the month, not the trend
  day('2026-08-31', 99, { [IMAGE]: [{ label: 'Luna', spend: 99 }] }),  // wrong month, must be ignored
];

const AUGUST = [
  day('2026-08-10', 4, { [IMAGE]: [{ label: 'Luna', spend: 0.24 }], [SOL_IN]: [{ label: 'Luna', spend: 1 }, { label: 'Expenze', spend: 2.5 }] }),
  day('2026-08-25', 8, { [IMAGE]: [{ label: 'Luna', spend: 8 }] }),  // past 21 Aug: outside the window
];

describe('costByModel', () => {
  it('sums each project’s spend per model across the month', () => {
    const r = costByModel(SEPTEMBER, '2026-09')!;
    const luna = r.projects.find((p) => p.label === 'Luna')!;
    expect(luna.spend).toBeCloseTo(2.12);
    expect(luna.models.map((m) => [m.name, m.spend])).toEqual([[SOL_IN, 2], [IMAGE, 0.12]]);
  });

  it('orders projects and models most expensive first', () => {
    const r = costByModel(SEPTEMBER, '2026-09')!;
    expect(r.projects.map((p) => p.label)).toEqual(['Rehearse RevenueCat', 'Expenze', 'Luna']);
  });

  it('counts only a day that had spend and no split as a gap', () => {
    // Two days with spend and a split, one $0 day with no split, one day
    // with spend and no split. The $0 day is not a gap — there was nothing
    // to split — and the first version wrongly reported it as one.
    const r = costByModel(SEPTEMBER, '2026-09')!;
    expect(r.daysWithSpend).toBe(3);   // 20th, 21st, 22nd
    expect(r.daysUnsplit).toBe(1);     // the 22nd only
  });

  it('ignores days from other months', () => {
    const r = costByModel(SEPTEMBER, '2026-09')!;
    expect(r.projects.find((p) => p.label === 'Luna')!.models.find((m) => m.name === IMAGE)!.spend).toBeCloseTo(0.12);
  });

  it('is null for a month with nothing stored, or with no split at all', () => {
    expect(costByModel(SEPTEMBER, '2026-07')).toBeNull();
    expect(costByModel([day('2026-09-20', 5), day('2026-09-21', 6)], '2026-09')).toBeNull();
  });

  describe('trend vs the same days last month', () => {
    const r = costByModel(SEPTEMBER, '2026-09', { window: WINDOW, previousRows: AUGUST })!;

    it('reports the window it measured over', () => {
      expect(r.comparison).toEqual({ days: 21 });
    });

    it('compares a model within its project, windowed both sides', () => {
      // Luna on SOL_IN: $2 (20 Sep) vs $1 (10 Aug) -> +100%.
      const luna = r.projects.find((p) => p.label === 'Luna')!;
      expect(luna.models.find((m) => m.name === SOL_IN)!.trend).toBeCloseTo(100);
      // Luna on IMAGE: $0.12 vs $0.24 -> -50%. The $8 on 25 Aug is past the
      // window and must not count, or this would read as a 98% fall.
      expect(luna.models.find((m) => m.name === IMAGE)!.trend).toBeCloseTo(-50);
    });

    it('leaves today out of the current side', () => {
      // 22 Sep is stored but beyond the window; the trend is over 1–21 only.
      const expenze = r.projects.find((p) => p.label === 'Expenze')!;
      // Expenze SOL_IN: 1 + 1.5 = 2.5 this window vs 2.5 last -> 0%.
      expect(expenze.models.find((m) => m.name === SOL_IN)!.trend).toBeCloseTo(0);
    });

    it('is null for a model with nothing to compare to', () => {
      // Rehearse had no spend in the August window: a new line, not +∞.
      const rehearse = r.projects.find((p) => p.label === 'Rehearse RevenueCat')!;
      expect(rehearse.trend).toBeNull();
      expect(rehearse.models[0].trend).toBeNull();
    });

    it('rolls up to a project trend', () => {
      // Luna: 2.12 this window vs 1.24 last -> +71%.
      const luna = r.projects.find((p) => p.label === 'Luna')!;
      expect(luna.trend).toBeCloseTo(((2.12 - 1.24) / 1.24) * 100, 1);
    });

    it('has no trends without a window (the 1st of the month)', () => {
      const first = costByModel(SEPTEMBER, '2026-09', { window: null, previousRows: AUGUST })!;
      expect(first.comparison).toBeNull();
      expect(first.projects.every((p) => p.trend === null && p.models.every((m) => m.trend === null))).toBe(true);
    });
  });
});

describe('projectModelHistory', () => {
  const rows = [...SEPTEMBER, ...AUGUST, day('2026-07-05', 3, { [IMAGE]: [{ label: 'Luna', spend: 3 }] })];
  const keys = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

  it('sums one project’s spend on one model per month', () => {
    const h = projectModelHistory(rows, 'Luna', IMAGE, keys);
    expect(h.map((m) => [m.monthKey, Number(m.spend.toFixed(2))])).toEqual([
      // August is 0.24 + 8 + the 99 on the 31st that the September fixture plants.
      ['2026-04', 0], ['2026-05', 0], ['2026-06', 0], ['2026-07', 3], ['2026-08', 107.24], ['2026-09', 0.12],
    ]);
  });

  it('marks months before the first split as having no data, not zero', () => {
    const h = projectModelHistory(rows, 'Luna', IMAGE, keys);
    expect(h.map((m) => m.hasData)).toEqual([false, false, false, true, true, true]);
  });

  it('does not bleed one project’s spend into another', () => {
    const h = projectModelHistory(rows, 'Expenze', IMAGE, keys);
    expect(h.every((m) => m.spend === 0)).toBe(true);
  });
});
