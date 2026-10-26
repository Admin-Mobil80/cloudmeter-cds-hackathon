import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import type { ServiceBreakdownItem } from '../../../shared/providers';
import { sameWindowLastMonth } from '../../../shared/month-shift';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 45;

interface ComparisonRow {
  name: string;
  current: number;
  previous: number;
  delta: number;
  /** % change; null when there's no prior spend to compare against. */
  deltaPct: number | null;
  /** Appeared in this window with no spend in the previous one. */
  isNew: boolean;
  /** Had spend last window and none this one. */
  stopped: boolean;
  /**
   * The same stretch of days one calendar month earlier, for "is this week
   * normal" rather than "has it changed since last week". Null when that
   * period is not covered by stored data — a blank is honest where a zero
   * would read as "it cost nothing then".
   */
  lastMonth: number | null;
}

/**
 * Per-service comparison of the last N complete days against the N before
 * them, so a service that is spiking stands out by name.
 *
 * Built entirely from stored daily rows — no additional metered provider call.
 *
 * Today is excluded from both windows. Providers post cost hours behind, so a
 * window containing today is always short a partial day; comparing it against
 * a complete window would show a fake across-the-board decrease.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  const requested = Number(event.queryStringParameters?.days ?? DEFAULT_DAYS);
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_DAYS)
    : DEFAULT_DAYS;

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'DAILY#' },
    // Newest first, and one extra to absorb today being dropped below.
    ScanIndexForward: false,
    /*
     * Enough rows to reach back past the same window a month earlier.
     *
     * The two adjacent windows need `days * 2`; the month-ago window starts
     * another calendar month before the current one, so the furthest day
     * wanted is about `days + 31` back. 35 covers the longest month with room
     * for the day today's exclusion shifts everything by.
     */
    Limit: days * 2 + 35,
  }));

  const todayKey = new Date().toISOString().slice(0, 10);
  const complete = (Items ?? []).filter((d) => (d.dayKey as string) < todayKey);

  if (complete.length === 0) {
    return json(200, { available: false, rows: [] });
  }

  // Still newest-first here, so the first slice is the recent window.
  const currentRows = complete.slice(0, days);
  const previousRows = complete.slice(days, days * 2);

  const current = sumByService(currentRows);
  const previous = sumByService(previousRows);

  /*
   * The same stretch of days one calendar month earlier.
   *
   * A different question from the previous window: that one asks "has this
   * changed since last week", this one asks "is this week normal". On a 7-day
   * view they are weeks apart; on a 30-day view they very nearly coincide,
   * which is honest — a month-long window compared against the month before
   * it is already roughly last month.
   *
   * Selected by date rather than by position, because these days are not
   * adjacent to the other two windows and an account with gaps must compare
   * the days it actually has.
   */
  const byDay = new Map(complete.map((d) => [d.dayKey as string, d]));
  const currentFrom = currentRows.length
    ? (currentRows[currentRows.length - 1].dayKey as string)
    : null;
  const lastMonthRows = currentFrom
    ? sameWindowLastMonth(currentFrom, currentRows.length)
      .map((key) => byDay.get(key))
      .filter((d): d is Record<string, unknown> => !!d)
    : [];
  const lastMonth = sumByService(lastMonthRows);

  const haveLastMonth = lastMonthRows.length > 0;

  const rows: ComparisonRow[] = Array.from(new Set([...current.keys(), ...previous.keys(), ...lastMonth.keys()]))
    .map((name) => {
      const cur = current.get(name) ?? 0;
      const prev = previous.get(name) ?? 0;
      return {
        name,
        current: cur,
        previous: prev,
        delta: cur - prev,
        // A jump from zero isn't "infinity percent" — it's a new service, which
        // the flag says more usefully than any number could.
        deltaPct: prev > 0 ? ((cur - prev) / prev) * 100 : null,
        isNew: prev === 0 && cur > 0,
        stopped: prev > 0 && cur === 0,
        // Zero is a real answer once the period is covered; null only means
        // the days themselves are missing.
        lastMonth: haveLastMonth ? (lastMonth.get(name) ?? 0) : null,
      };
    })
    // Highest current cost first. The change column carries the "what's
    // spiking" signal on its own, and ranking by spend keeps this list in the
    // same order as every other cost list in the product — so a service sits
    // in the position the reader already expects. Ties break on movement.
    .sort((a, b) => (b.current - a.current) || (b.delta - a.delta));

  const currentTotal = sumAll(current);
  const previousTotal = sumAll(previous);

  return json(200, {
    available: true,
    days,
    // The previous window is short until an account has enough history. Saying
    // so lets the UI warn rather than present an unfair comparison as fact.
    currentDays: currentRows.length,
    previousDays: previousRows.length,
    comparable: previousRows.length === currentRows.length,
    currentRange: rangeOf(currentRows),
    previousRange: rangeOf(previousRows),
    // rangeOf reads newest-first, which is how the query returns rows; these
    // were built ascending from the shifted start date, so they are flipped
    // to match rather than silently reporting from and to the wrong way round.
    lastMonthRange: rangeOf(lastMonthRows.slice().reverse()),
    // Shorter than the current window when the account's history does not
    // reach back that far, so the UI can say so rather than present a partial
    // period as a like-for-like.
    lastMonthDays: lastMonthRows.length,
    lastMonthTotal: haveLastMonth ? sumAll(lastMonth) : null,
    currentTotal,
    previousTotal,
    totalDelta: currentTotal - previousTotal,
    totalDeltaPct: previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null,
    rows,
  });
};

function sumByService(rows: Record<string, unknown>[]): Map<string, number> {
  const totals = new Map<string, number>();
  rows.forEach((d) => {
    (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      totals.set(s.name, (totals.get(s.name) ?? 0) + s.spend);
    });
  });
  return totals;
}

function sumAll(totals: Map<string, number>): number {
  return Array.from(totals.values()).reduce((a, b) => a + b, 0);
}

/** Oldest and newest day in a newest-first slice, for labelling the window. */
function rangeOf(rows: Record<string, unknown>[]): { from: string; to: string } | null {
  if (rows.length === 0) return null;
  return {
    from: rows[rows.length - 1].dayKey as string,
    to: rows[0].dayKey as string,
  };
}
