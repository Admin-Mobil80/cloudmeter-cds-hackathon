/**
 * What the month-end projection divides by.
 *
 * It divided month-to-date spend by today's date. But month-to-date only
 * contains days the providers have actually reported, and they report a day
 * behind — so every morning before the 13:05 sync, today sat in the divisor
 * and contributed nothing to the numerator, and the projection read low by a
 * whole day's worth.
 *
 * ACME on 6 October: $53.48 across five reported days (1–5 Oct) was shown as
 * $276 rather than $332, because it was divided by six.
 *
 * Worst early in the month — one missing day of five is 20% of the answer, the
 * same day on the 25th is 4% — and it never self-corrected, being wrong in the
 * same direction every single day.
 */

import { coveredDaysFrom } from '../functions/shared/period';

const keys = (...days: number[]) =>
  days.map((d) => `DAILY#2026-10-${String(d).padStart(2, '0')}`);

describe('days the figure actually covers', () => {
  it('uses the newest reported day, not the calendar', () => {
    // The ACME case: rows for 1–5 October, read on the 6th.
    expect(coveredDaysFrom(keys(1, 2, 3, 4, 5), 6)).toBe(5);
  });

  it('matches the calendar once today has been reported', () => {
    expect(coveredDaysFrom(keys(1, 2, 3, 4, 5, 6), 6)).toBe(6);
  });

  it('counts a quiet day in the middle as covered', () => {
    /*
     * The distinction that stops this inflating the projection. A day with no
     * spend is still a day the month-to-date figure covers — it contributed
     * zero, which is a fact about the account, not a gap in the data.
     * Counting only days with spend would treat a free Sunday as missing and
     * divide by too little.
     */
    expect(coveredDaysFrom(keys(1, 2, 3, 4, 5), 6)).toBe(5);
  });

  it('is unmoved by the order the keys arrive in', () => {
    expect(coveredDaysFrom(keys(3, 1, 5, 2, 4), 6)).toBe(5);
  });

  it('takes the furthest day across several accounts', () => {
    // One account synced further ahead than another; the figure covers up to
    // the newest day any of them reported.
    expect(coveredDaysFrom([...keys(1, 2, 3), ...keys(1, 2, 3, 4, 5)], 6)).toBe(5);
  });
});

describe('when there is nothing to go on', () => {
  it('falls back to the calendar day with no daily rows at all', () => {
    /*
     * Both of Initech's Azure accounts are exactly this: real monthly
     * totals, no daily rows ever. Their projection behaves as it always did
     * rather than being guessed at from data that does not exist.
     */
    expect(coveredDaysFrom([], 6)).toBe(6);
  });

  it('ignores a key it cannot read rather than counting it as day zero', () => {
    expect(coveredDaysFrom(['DAILY#', 'rubbish', ...keys(1, 2, 3)], 6)).toBe(3);
  });

  it('falls back when every key is unreadable', () => {
    expect(coveredDaysFrom(['rubbish', 'DAILY#'], 6)).toBe(6);
  });
});

describe('a stored day cannot be ahead of today', () => {
  it('caps at the calendar day', () => {
    /*
     * Daily rows are bucketed on UTC days while the cap is the server's own
     * date, so east of UTC a row can legitimately look like tomorrow. Dividing
     * a month's spend by a day that has not happened would understate the
     * projection — the exact bug being fixed, in the other direction.
     */
    expect(coveredDaysFrom(keys(1, 2, 3, 4, 5, 6, 7), 6)).toBe(6);
  });

  it('still works on the first of the month', () => {
    expect(coveredDaysFrom([], 1)).toBe(1);
    expect(coveredDaysFrom(keys(1), 1)).toBe(1);
  });
});

describe('the projection itself', () => {
  const project = (mtd: number, dayKeys: string[], dayOfMonth: number, daysInMonth: number) => {
    const covered = coveredDaysFrom(dayKeys, dayOfMonth);
    return covered > 0 ? (mtd / covered) * daysInMonth : mtd;
  };

  it('reproduces ACME on 6 October', () => {
    // $53.48 over 1–5 Oct. Was $276.30 divided by six; is $331.58 divided by
    // the five days that figure is actually made of.
    const shown = project(53.48, keys(1, 2, 3, 4, 5), 6, 31);
    expect(shown).toBeCloseTo(331.58, 1);
    expect((53.48 / 6) * 31).toBeCloseTo(276.30, 1);
  });

  it('is unchanged for an account whose data is up to date', () => {
    expect(project(53.48, keys(1, 2, 3, 4, 5, 6), 6, 31)).toBeCloseTo((53.48 / 6) * 31, 6);
  });
});
