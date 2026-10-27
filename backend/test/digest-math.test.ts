import { daysInMonth } from '../functions/shared/digest';

/**
 * The arithmetic buildDigest performs over stored daily rows, exercised without
 * DynamoDB. Kept deliberately as a mirror of the loop in buildDigest: these
 * tests exist to pin the *rules* — one day is one day, month-to-date is the
 * real month-to-date, and the percentage compares equal spans — so that a
 * future edit to that loop has to justify itself against them.
 */

interface Row { dayKey: string; totalSpend: number }

function summarise(rows: Row[], dayKey: string) {
  const month = dayKey.slice(0, 7);
  const dayOfMonth = Number(dayKey.slice(8, 10));
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const comparableDays = Math.min(dayOfMonth, daysInMonth(prevMonth));

  let daySpend = 0, monthToDate = 0, currentToSamePoint = 0, lastMonth = 0, sawLast = false;
  for (const r of rows) {
    if (r.dayKey === dayKey) daySpend += r.totalSpend;
    if (r.dayKey.startsWith(month) && r.dayKey <= dayKey) {
      monthToDate += r.totalSpend;
      if (Number(r.dayKey.slice(8, 10)) <= comparableDays) currentToSamePoint += r.totalSpend;
    }
    if (r.dayKey.startsWith(prevMonth) && Number(r.dayKey.slice(8, 10)) <= comparableDays) {
      lastMonth += r.totalSpend;
      sawLast = true;
    }
  }
  return {
    daySpend, monthToDate, comparableDays,
    lastMonthToSamePoint: sawLast ? lastMonth : null,
    monthDeltaPct: sawLast && lastMonth > 0
      ? ((currentToSamePoint - lastMonth) / lastMonth) * 100
      : null,
  };
}

/** `count` days of `perDay` starting at day 1 of `month`. */
function flat(month: string, count: number, perDay: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    dayKey: `${month}-${String(i + 1).padStart(2, '0')}`,
    totalSpend: perDay,
  }));
}

describe('31 August daily spend', () => {
  const rows = [...flat('2026-07', 31, 6), ...flat('2026-08', 30, 6.7), { dayKey: '2026-08-31', totalSpend: 5.03 }];

  it('is that one day only, never the month', () => {
    const s = summarise(rows, '2026-08-31');
    expect(s.daySpend).toBeCloseTo(5.03, 2);
  });

  it('does not leak into month-to-date as a substitute for the month', () => {
    const s = summarise(rows, '2026-08-31');
    // 30 days at 6.7 plus the 31st — emphatically not 5.03, and not one day
    // treated as a monthly total.
    expect(s.monthToDate).toBeCloseTo(206.03, 2);
    expect(s.monthToDate).not.toBeCloseTo(s.daySpend, 2);
  });
});

describe('month-to-date and the previous-period comparison', () => {
  it('compares equal spans when both months are 31 days', () => {
    const rows = [...flat('2026-07', 31, 10), ...flat('2026-08', 31, 12)];
    const s = summarise(rows, '2026-08-31');
    expect(s.comparableDays).toBe(31);
    expect(s.monthToDate).toBeCloseTo(372, 2);
    expect(s.lastMonthToSamePoint).toBeCloseTo(310, 2);
    expect(s.monthDeltaPct).toBeCloseTo(20, 5);
  });

  it('clamps to the shorter previous month instead of inventing a rise', () => {
    // Identical daily spend in both months. February is shorter, so an
    // unclamped comparison would count 31 March days against 28 February ones
    // and report roughly +10.7% for a business that changed nothing.
    const rows = [...flat('2026-02', 28, 10), ...flat('2026-03', 31, 10)];
    const s = summarise(rows, '2026-03-31');
    expect(s.comparableDays).toBe(28);
    expect(s.monthToDate).toBeCloseTo(310, 2);   // real MTD is still 31 days
    expect(s.monthDeltaPct).toBeCloseTo(0, 5);   // like-for-like: no change
  });

  it('does not clamp when the previous month is longer', () => {
    const rows = [...flat('2026-01', 31, 10), ...flat('2026-02', 28, 10)];
    const s = summarise(rows, '2026-02-28');
    expect(s.comparableDays).toBe(28);
    expect(s.monthDeltaPct).toBeCloseTo(0, 5);
  });

  it('handles a leap February', () => {
    const rows = [...flat('2028-01', 31, 10), ...flat('2028-02', 29, 10)];
    const s = summarise(rows, '2028-02-29');
    expect(s.comparableDays).toBe(29);
    expect(s.monthDeltaPct).toBeCloseTo(0, 5);
  });
});

describe('early in a new month', () => {
  const rows = [...flat('2026-08', 31, 10), ...flat('2026-09', 2, 20)];

  it('1 September reports one day, not the whole of August', () => {
    const s = summarise(rows, '2026-09-01');
    expect(s.daySpend).toBeCloseTo(20, 2);
    expect(s.monthToDate).toBeCloseTo(20, 2);
    expect(s.lastMonthToSamePoint).toBeCloseTo(10, 2);  // 1 Aug alone
    expect(s.monthDeltaPct).toBeCloseTo(100, 5);
  });

  it('2 September compares two days against two days', () => {
    const s = summarise(rows, '2026-09-02');
    expect(s.comparableDays).toBe(2);
    expect(s.monthToDate).toBeCloseTo(40, 2);
    expect(s.lastMonthToSamePoint).toBeCloseTo(20, 2);
    expect(s.monthDeltaPct).toBeCloseTo(100, 5);
  });
});

describe('incomplete and missing data', () => {
  it('yields no percentage when the previous month is absent', () => {
    const s = summarise(flat('2026-08', 31, 10), '2026-08-31');
    expect(s.lastMonthToSamePoint).toBeNull();
    expect(s.monthDeltaPct).toBeNull();
  });

  it('does not divide by a zero previous month', () => {
    const rows = [...flat('2026-07', 31, 0), ...flat('2026-08', 31, 10)];
    expect(summarise(rows, '2026-08-31').monthDeltaPct).toBeNull();
  });

  it('excludes days after the reported day, so a partial today cannot leak in', () => {
    // 2 Sep is present and still accruing; a digest for 1 Sep must ignore it.
    const rows = [...flat('2026-08', 31, 10), { dayKey: '2026-09-01', totalSpend: 20 },
                  { dayKey: '2026-09-02', totalSpend: 3 }];
    const s = summarise(rows, '2026-09-01');
    expect(s.monthToDate).toBeCloseTo(20, 2);
  });

  it('treats a zero-spend day as reported, not missing', () => {
    const rows = [...flat('2026-07', 31, 10), ...flat('2026-08', 30, 10),
                  { dayKey: '2026-08-31', totalSpend: 0 }];
    const s = summarise(rows, '2026-08-31');
    expect(s.daySpend).toBe(0);
    expect(s.monthToDate).toBeCloseTo(300, 2);
  });
});

describe('regression: real prod figures for 31 Aug 2026', () => {
  // Guards the reported bug directly. These are the actual stored totals for
  // two prod tenants; the alerts quoted $5/$213/+13% and $10/$236/-40%, and
  // the arithmetic must keep reproducing exactly that from the same inputs.
  it('WONKA: $5.03 day, $212.83 MTD, +13%', () => {
    const rows = [...flat('2026-07', 31, 188.55 / 31), ...flat('2026-08', 30, (212.83 - 5.03) / 30),
                  { dayKey: '2026-08-31', totalSpend: 5.03 }];
    const s = summarise(rows, '2026-08-31');
    expect(s.daySpend).toBeCloseTo(5.03, 2);
    expect(s.monthToDate).toBeCloseTo(212.83, 2);
    expect(s.monthDeltaPct!).toBeCloseTo(12.88, 1);
  });

  it('RCS Health: $9.84 day, $236.13 MTD, -40%', () => {
    const rows = [...flat('2026-07', 31, 394.36 / 31), ...flat('2026-08', 30, (236.13 - 9.84) / 30),
                  { dayKey: '2026-08-31', totalSpend: 9.84 }];
    const s = summarise(rows, '2026-08-31');
    expect(s.daySpend).toBeCloseTo(9.84, 2);
    expect(s.monthToDate).toBeCloseTo(236.13, 2);
    expect(s.monthDeltaPct!).toBeCloseTo(-40.12, 1);
  });
});
