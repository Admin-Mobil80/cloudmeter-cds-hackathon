/**
 * Comparing a part-finished month against a whole one.
 *
 * "Spend, month to date" is 16 days of September. Setting that against all 31
 * days of August reports a ~50% fall that is really just the month not being
 * over — a figure that starts catastrophic on the 1st, climbs all month, and
 * only tells the truth on the last day. These helpers pick the matching window
 * out of the previous month instead.
 *
 * Only *complete* days are compared, on both sides. Today is still accruing and
 * provider billing data lags by hours, so weighing a half-finished day against
 * a finished one biases every comparison downward — most visibly first thing in
 * the morning, which is exactly when someone glances at a dashboard.
 */

/** `yyyy-MM-dd` in UTC, matching how DAILY# keys are written. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInMonthOf(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export interface ComparisonWindow {
  /** Complete days of the current month: day 1 .. yesterday. */
  currentFrom: string;
  currentTo: string;
  /** The same span in the previous month. */
  previousFrom: string;
  previousTo: string;
  /** How many complete days each side covers. */
  days: number;
}

/**
 * The two windows to compare, or null on the 1st of the month.
 *
 * On day 1 there is not yet a single complete day to compare, and inventing one
 * from a few hours of data would be worse than saying nothing — the caller
 * shows "no prior period" instead.
 *
 * The previous-month window is clamped to that month's length, so 31 March
 * compares against 1-28 February rather than silently running off the end and
 * reporting a collapse every 31st.
 */
export function comparisonWindow(now = new Date()): ComparisonWindow | null {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = now.getUTCDate();

  const days = today - 1;
  if (days < 1) return null;

  const prevMonthIndex = month - 1;
  const prevLength = daysInMonthOf(year, prevMonthIndex);
  const prevLastDay = Math.min(days, prevLength);

  return {
    currentFrom: isoDay(new Date(Date.UTC(year, month, 1))),
    currentTo: isoDay(new Date(Date.UTC(year, month, days))),
    previousFrom: isoDay(new Date(Date.UTC(year, prevMonthIndex, 1))),
    previousTo: isoDay(new Date(Date.UTC(year, prevMonthIndex, prevLastDay))),
    days,
  };
}

/** Totals the daily rows whose date falls inside `[from, to]`. */
export function sumDaysInRange(
  rows: Array<{ date: string; spend: number }>,
  from: string,
  to: string,
): number {
  return rows
    .filter((r) => r.date >= from && r.date <= to)
    .reduce((sum, r) => sum + (Number(r.spend) || 0), 0);
}

export interface DailyServiceRow {
  date: string;
  services?: Array<{ name: string; spend: number }>;
}

/** Per-service totals for the days inside `[from, to]`. */
export function sumServicesInRange(
  rows: DailyServiceRow[],
  from: string,
  to: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    for (const s of row.services ?? []) {
      totals.set(s.name, (totals.get(s.name) ?? 0) + (Number(s.spend) || 0));
    }
  }
  return totals;
}

/**
 * Percentage change between two windows, or null when there is nothing to
 * compare against.
 *
 * Null rather than zero: a service that did not exist last month has not
 * "stayed flat", and rendering 0% for it is a claim about history that was
 * never measured. Callers show nothing at all in that case.
 */
export function deltaPct(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Scales a part-month up to what it would be at this rate for the whole month.
 *
 * Used where a chart puts the current month beside finished ones, and a stunted
 * final bar reads as a fall rather than as a month still running. It is an
 * estimate, and every caller labels it as one.
 */
export function projectToFullMonth(spendSoFar: number, now = new Date()): number {
  const dayOfMonth = now.getUTCDate();
  if (dayOfMonth < 1) return spendSoFar;
  const total = daysInMonthOf(now.getUTCFullYear(), now.getUTCMonth());
  return (spendSoFar / dayOfMonth) * total;
}

/**
 * How many days of the month the month-to-date figure actually covers.
 *
 * Taken from the newest day any account has a row for, not from a count of
 * rows: a genuinely quiet day in the middle is still a day the figure covers,
 * it just contributed nothing. Counting only days with spend would treat a
 * free Sunday as missing and inflate the projection.
 *
 * Falls back to the calendar day when no account keeps daily rows at all —
 * both of Initech's Azure accounts are like this, with monthly totals and
 * no dailies. For them the behaviour is unchanged rather than guessed at.
 *
 * Capped at the calendar day, because a stored day cannot be ahead of today
 * and a clock skew between a provider's UTC bucket and ours should not divide
 * a month's spend by tomorrow.
 */
export function coveredDaysFrom(dayKeys: string[], dayOfMonth: number): number {
  let newest = 0;
  for (const key of dayKeys) {
    const d = Number(String(key).slice(-2));
    if (Number.isFinite(d) && d > newest) newest = d;
  }
  if (newest === 0) return dayOfMonth;
  return Math.min(newest, dayOfMonth);
}
