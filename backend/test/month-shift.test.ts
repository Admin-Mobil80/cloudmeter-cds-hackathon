/**
 * Finding the same stretch of days a month earlier.
 *
 * Month lengths are the whole difficulty. Shifting both ends of a window
 * independently gives 31 days against 30 whenever the months differ, which
 * quietly hands the comparison window extra spend; and a date that does not
 * exist in the earlier month has to go somewhere deliberate rather than
 * rolling forward into the month after.
 */

import { shiftBackOneMonth, addDays, sameWindowLastMonth } from '../functions/shared/month-shift';

describe('one calendar month back', () => {
  it('keeps the day of the month where it exists', () => {
    expect(shiftBackOneMonth('2026-10-11')).toBe('2026-09-11');
    expect(shiftBackOneMonth('2026-09-05')).toBe('2026-08-05');
  });

  it('crosses the new year', () => {
    expect(shiftBackOneMonth('2026-01-15')).toBe('2025-12-15');
    expect(shiftBackOneMonth('2026-01-01')).toBe('2025-12-01');
  });

  it('clamps a day the earlier month does not have', () => {
    // There is no 31 September. Rolling forward would land in October and
    // compare a day against itself a month later.
    expect(shiftBackOneMonth('2026-10-31')).toBe('2026-09-30');
    expect(shiftBackOneMonth('2026-05-31')).toBe('2026-04-30');
  });

  it('clamps into February, leap year and not', () => {
    expect(shiftBackOneMonth('2026-03-30')).toBe('2026-02-28');
    expect(shiftBackOneMonth('2026-03-31')).toBe('2026-02-28');
    expect(shiftBackOneMonth('2028-03-31')).toBe('2028-02-29');
  });

  it('never rolls forward past the earlier month', () => {
    // The failure clamping exists to prevent: 31 March becoming 3 March.
    for (const day of ['2026-03-29', '2026-03-30', '2026-03-31']) {
      expect(shiftBackOneMonth(day).startsWith('2026-02')).toBe(true);
    }
  });
});

describe('counting days forward', () => {
  it('walks across a month end', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
  });

  it('walks across a year end', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('handles February in a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('stays on the same day for zero', () => {
    expect(addDays('2026-10-11', 0)).toBe('2026-10-11');
  });
});

describe('the window a month earlier', () => {
  it('is the same length as the one it mirrors', () => {
    /*
     * The point of returning a length rather than two shifted ends. 12 Sep to
     * 11 Oct is 30 days; shifting both ends gives 12 Aug to 11 Sep, which is
     * 31 — a free extra day of spend in the column being compared against.
     */
    expect(sameWindowLastMonth('2026-09-12', 30)).toHaveLength(30);
    expect(sameWindowLastMonth('2026-10-05', 7)).toHaveLength(7);
  });

  it('starts one month before the window it mirrors', () => {
    const week = sameWindowLastMonth('2026-10-05', 7);
    expect(week[0]).toBe('2026-09-05');
    expect(week[6]).toBe('2026-09-11');
  });

  it('runs consecutively with no gaps', () => {
    const days = sameWindowLastMonth('2026-09-12', 30);
    days.forEach((d, i) => { if (i > 0) expect(d).toBe(addDays(days[i - 1], 1)); });
  });

  it('runs on past the clamped start rather than stopping at the month end', () => {
    // Starting 31 Oct clamps to 30 Sep, and the week continues into October.
    const week = sameWindowLastMonth('2026-10-31', 7);
    expect(week[0]).toBe('2026-09-30');
    expect(week[6]).toBe('2026-10-06');
  });

  it('handles a single-day window', () => {
    expect(sameWindowLastMonth('2026-10-11', 1)).toEqual(['2026-09-11']);
  });
});
