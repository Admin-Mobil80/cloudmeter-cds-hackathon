/**
 * One day's spend, split by service, trimmed to what a reader can take in.
 *
 * The daily rows have carried `serviceBreakdown` since daily ingestion was
 * written, and until now every reader collapsed it: the chart used the day's
 * total, and the service list summed the whole window. So the question people
 * actually ask of a spike — *what was it spent on, that day* — was answerable
 * from the stored data and not from the product.
 *
 * Trimming matters because this ships per day. A 90-day window with a dozen
 * services each would put a thousand rows on the wire for a tooltip, most of
 * them fractions of a cent. The long tail is folded into one "Other" line
 * rather than dropped, so the parts still sum to the day's total — a
 * breakdown that silently loses money is worse than no breakdown.
 */

import type { ServiceBreakdownItem } from './providers';

/** How many services a day shows before the rest become "Other". */
export const TOP_SERVICES_PER_DAY = 8;

/** The label the tail is folded into. Matches the monthly breakdown's wording. */
export const OTHER_LABEL = 'Other';

export interface DayService {
  name: string;
  spend: number;
  /** Share of that day's spend, 0–100. */
  pct: number;
  /**
   * Percentage change against the previous day, as the provider adapter
   * calculated it. Null on the "Other" line, where a single figure would be
   * an average of unrelated services and mean nothing, and on any service the
   * adapter did not supply one for.
   */
  trend: number | null;
}

/**
 * The services behind one day, largest first.
 *
 * `pct` is recomputed here rather than taken from the stored row: the stored
 * percentage is of the provider's own total, and a day whose tail is folded
 * needs shares that still add to a hundred.
 */
export function dayServices(
  breakdown: ServiceBreakdownItem[] | undefined,
  dayTotal: number,
  limit: number = TOP_SERVICES_PER_DAY,
): DayService[] {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return [];

  const share = (spend: number) => (dayTotal > 0 ? (spend / dayTotal) * 100 : 0);

  const sorted = breakdown
    .filter((s) => s && typeof s.spend === 'number' && Number.isFinite(s.spend))
    .slice()
    .sort((a, b) => b.spend - a.spend);

  const head = sorted.slice(0, limit).map((s) => ({
    name: s.name,
    spend: s.spend,
    pct: share(s.spend),
    trend: typeof (s as { trend?: unknown }).trend === 'number'
      ? (s as { trend: number }).trend
      : null,
  }));

  const tail = sorted.slice(limit);
  if (tail.length === 0) return head;

  /*
   * One line for the rest, never a dropped remainder.
   *
   * Without this the listed services would fall short of the day's total and
   * the reader would have no way to tell whether the gap is rounding or
   * something missing.
   */
  const rest = tail.reduce((sum, s) => sum + s.spend, 0);
  return [...head, { name: OTHER_LABEL, spend: rest, pct: share(rest), trend: null }];
}
