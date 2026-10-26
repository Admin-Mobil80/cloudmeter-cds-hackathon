import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * What an alert actually cost, once the days after it have arrived.
 *
 * An alert's stored `impact` is a forecast made from a single day: the excess
 * over baseline, multiplied by the days left in the month. It is written once
 * and never revisited, so it kept advertising a number the data had already
 * disproved — Amazon Registrar was reported as "+$414" for three days while
 * the account spent $0 on it each of those days.
 *
 * This reads the daily rows that have landed since and answers two questions
 * the stored figure cannot: what has this actually added so far, and — given
 * the rate we have now *observed* rather than assumed — what is it still on
 * course to add. A forecast that corrects itself as evidence arrives is worth
 * showing; one frozen at its most uncertain moment is not.
 */

export interface AlertActuals {
  /** Complete days observed since the alert's own day, excluding that day. */
  daysObserved: number;
  /** Money above baseline that has genuinely accrued since the alert day, inclusive. */
  accrued: number;
  /**
   * Still to come this month at the observed rate, or null when there is not
   * enough evidence to project — either no days have passed yet, or the alert
   * was a one-off charge with no baseline to project from.
   */
  projected: number | null;
}

interface DailyRow {
  SK: string;
  serviceBreakdown?: Array<{ name: string; spend: number }>;
}

/**
 * Loads one account's daily rows from `fromDay` onward, once, so several
 * alerts on the same account share a single read.
 */
export async function dailyRowsSince(accountId: string, fromDay: string): Promise<DailyRow[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK >= :from',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':from': `DAILY#${fromDay}` },
  }));
  // The key condition also catches MONTHLY# rows, which sort after DAILY#.
  return ((Items ?? []) as DailyRow[]).filter((r) => String(r.SK).startsWith('DAILY#'));
}

/**
 * @param todayKey the tenant's local date, so a day still in progress is not
 *   counted as evidence — a partial day looks like a collapse in spend.
 */
export function actualsFor(
  alert: { service?: string; baseline?: number; dayKey?: string; impact?: number | null },
  rows: DailyRow[],
  todayKey: string,
): AlertActuals {
  const service = alert.service ?? '';
  const baseline = Number(alert.baseline ?? 0);
  const from = alert.dayKey ?? '';

  const days = rows
    .map((r) => ({ day: String(r.SK).replace('DAILY#', ''), row: r }))
    // Complete days only, from the alert's day up to yesterday.
    .filter((d) => d.day >= from && d.day < todayKey)
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  let accrued = 0;
  for (const d of days) {
    const spend = d.row.serviceBreakdown?.find((x) => x.name === service)?.spend ?? 0;
    // Only the excess counts as the anomaly's cost; the baseline was always
    // going to be spent. Floored at zero so a quiet day cannot credit back
    // spend the anomaly never caused.
    accrued += Math.max(0, spend - baseline);
  }

  // The alert's own day is day one, so days *after* it are what constitute
  // evidence about whether the excess repeats.
  const daysObserved = Math.max(0, days.length - 1);

  return {
    daysObserved,
    accrued,
    projected: projectRemaining(accrued, days.length, from, todayKey, alert.impact),
  };
}

function projectRemaining(
  accrued: number,
  daysCounted: number,
  fromDay: string,
  todayKey: string,
  storedImpact: number | null | undefined,
): number | null {
  // A one-off charge was never projected and still isn't. Evidence that it did
  // not repeat is not a reason to start forecasting it.
  if (storedImpact === null || storedImpact === undefined) return null;
  // Only the alert's own day so far — no more evidence than at detection, so
  // the stored forecast is still the best available answer.
  if (daysCounted <= 1) return storedImpact;

  const perDay = accrued / daysCounted;
  const daysLeft = daysLeftInMonth(todayKey);
  return perDay * daysLeft;
}

/** Whole days remaining in the month after `dayKey` (yyyy-MM-dd, UTC). */
function daysLeftInMonth(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.max(0, inMonth - d);
}
