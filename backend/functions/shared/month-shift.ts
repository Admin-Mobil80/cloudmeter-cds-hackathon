/**
 * The same stretch of days, one calendar month earlier.
 *
 * "Around the same time last month" is how people ask whether this week is
 * normal — the immediately preceding window answers "has it changed since
 * last week", which is a different question and the one the Previous column
 * already answers.
 *
 * Two rules, both deliberate.
 *
 * The window keeps its length rather than keeping both end dates. Shifting
 * each end independently gives 31 days against 30 when the months differ, and
 * a comparison window longer than what it is compared with is simply wrong —
 * the same reason the current and previous windows are cut to equal size.
 *
 * A day that does not exist in the earlier month is clamped to that month's
 * last day: there is no 31 September, and 31 October belongs against 30
 * September rather than drifting into October.
 */

/** `2026-10-11` → `2026-09-11`; `2026-03-31` → `2026-02-28`. */
export function shiftBackOneMonth(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `2026-10-11`, 3 → `2026-10-14`. */
export function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  // UTC throughout: day keys are calendar dates with no timezone, and local
  // arithmetic would shift them by a day either side of midnight.
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/**
 * The day keys of a window of `length` days starting one month before
 * `startDay`, in order.
 *
 * Returned as keys rather than as a range so the caller can take only the days
 * it actually holds — an account with gaps must compare the days it has, not
 * assume a span.
 */
export function sameWindowLastMonth(startDay: string, length: number): string[] {
  const from = shiftBackOneMonth(startDay);
  return Array.from({ length }, (_, i) => addDays(from, i));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');
