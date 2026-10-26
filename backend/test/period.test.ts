import {
  comparisonWindow, sumDaysInRange, sumServicesInRange, deltaPct, projectToFullMonth,
} from '../functions/shared/period';

/**
 * Date arithmetic nobody checks by hand. A wrong window here doesn't throw or
 * look broken — it quietly reports a spend change that never happened, which is
 * the whole reason this module exists.
 */

describe('comparisonWindow', () => {
  it('matches the elapsed days against the same span last month', () => {
    // 17 September: 16 complete days behind us, so 1-16 Sep vs 1-16 Aug.
    const w = comparisonWindow(new Date('2026-09-17T10:00:00Z'))!;
    expect(w).toMatchObject({
      currentFrom: '2026-09-01', currentTo: '2026-09-16',
      previousFrom: '2026-08-01', previousTo: '2026-08-16',
      days: 16,
    });
  });

  it('excludes today, which is still accruing', () => {
    // Billing data lags by hours; a part-day against a whole one reads as a
    // fall every morning.
    const w = comparisonWindow(new Date('2026-09-17T23:59:00Z'))!;
    expect(w.currentTo).toBe('2026-09-16');
  });

  it('gives nothing on the 1st, when no day is complete', () => {
    expect(comparisonWindow(new Date('2026-09-01T12:00:00Z'))).toBeNull();
  });

  it('compares a single day on the 2nd', () => {
    const w = comparisonWindow(new Date('2026-09-02T12:00:00Z'))!;
    expect(w).toMatchObject({ currentTo: '2026-09-01', previousTo: '2026-08-01', days: 1 });
  });

  it('clamps to a shorter previous month rather than running off the end', () => {
    // 31 March has 30 complete days behind it; February has only 28. Without
    // the clamp the tail of the window matches nothing and every 31st reports
    // a collapse.
    const w = comparisonWindow(new Date('2026-03-31T12:00:00Z'))!;
    expect(w.currentTo).toBe('2026-03-30');
    expect(w.previousTo).toBe('2026-02-28');
  });

  it('handles a leap February', () => {
    const w = comparisonWindow(new Date('2028-03-31T12:00:00Z'))!;
    expect(w.previousTo).toBe('2028-02-29');
  });

  it('steps back across a year boundary', () => {
    const w = comparisonWindow(new Date('2026-01-10T12:00:00Z'))!;
    expect(w.previousFrom).toBe('2025-12-01');
    expect(w.previousTo).toBe('2025-12-09');
  });
});

describe('sumDaysInRange', () => {
  const rows = [
    { date: '2026-08-31', spend: 99 },
    { date: '2026-09-01', spend: 10 },
    { date: '2026-09-02', spend: 20 },
    { date: '2026-09-03', spend: 30 },
  ];

  it('totals only the days inside the window', () => {
    expect(sumDaysInRange(rows, '2026-09-01', '2026-09-02')).toBe(30);
  });

  it('includes both endpoints', () => {
    expect(sumDaysInRange(rows, '2026-09-01', '2026-09-03')).toBe(60);
  });

  it('is zero when the window holds no data', () => {
    // A newly connected account has no history; that must read as "nothing to
    // compare", never as a divide-by-zero or a NaN on the tile.
    expect(sumDaysInRange(rows, '2026-07-01', '2026-07-31')).toBe(0);
  });
});

describe('sumServicesInRange', () => {
  const rows = [
    { date: '2026-08-15', services: [{ name: 'EC2', spend: 5 }, { name: 'S3', spend: 1 }] },
    { date: '2026-09-01', services: [{ name: 'EC2', spend: 10 }] },
    { date: '2026-09-02', services: [{ name: 'EC2', spend: 12 }, { name: 'Lambda', spend: 3 }] },
  ];

  it('totals each service across the window', () => {
    const t = sumServicesInRange(rows, '2026-09-01', '2026-09-02');
    expect(t.get('EC2')).toBe(22);
    expect(t.get('Lambda')).toBe(3);
  });

  it('leaves out services outside the window', () => {
    expect(sumServicesInRange(rows, '2026-09-01', '2026-09-02').has('S3')).toBe(false);
  });

  it('copes with a day that has no breakdown', () => {
    // A sync that failed part-way leaves the row without services; that must
    // not take the whole comparison down with it.
    expect(sumServicesInRange([{ date: '2026-09-01' }], '2026-09-01', '2026-09-01').size).toBe(0);
  });
});

describe('deltaPct', () => {
  it('gives the percentage change', () => {
    expect(deltaPct(110, 100)).toBeCloseTo(10);
    expect(deltaPct(90, 100)).toBeCloseTo(-10);
  });

  it('gives null when there is nothing to compare against', () => {
    // A service that did not exist last month has not "stayed flat", and 0%
    // would be a claim about history nobody measured.
    expect(deltaPct(50, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});

describe('projectToFullMonth', () => {
  it('scales a part month to the whole', () => {
    // $160 over 16 of 30 days -> $300.
    expect(projectToFullMonth(160, new Date('2026-09-16T12:00:00Z'))).toBeCloseTo(300, 6);
  });

  it('leaves a finished month alone', () => {
    expect(projectToFullMonth(500, new Date('2026-09-30T12:00:00Z'))).toBeCloseTo(500, 6);
  });
});

describe('the bug this replaces', () => {
  it('reports the real change, not the month being unfinished', () => {
    // Taken from prod: 16 days of September against August.
    const daily = [
      ...Array.from({ length: 16 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`, spend: 276.79 / 16,
      })),
      ...Array.from({ length: 31 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, '0')}`,
        // 301.38 fell in the first 16 days, 547.03 across the whole month.
        spend: i < 16 ? 301.38 / 16 : (547.03 - 301.38) / 15,
      })),
    ];

    const w = comparisonWindow(new Date('2026-09-17T10:00:00Z'))!;
    const current = sumDaysInRange(daily, w.currentFrom, w.currentTo);
    const previous = sumDaysInRange(daily, w.previousFrom, w.previousTo);
    const pct = ((current - previous) / previous) * 100;

    // The old code compared 276.79 against the full 547.03 and said -49.4%.
    expect(pct).toBeCloseTo(-8.2, 1);
  });
});
