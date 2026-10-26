import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import type { ServiceBreakdownItem } from '../../../shared/providers';
import { dayServices } from '../../../shared/day-services';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

// Per-account daily spend. `service=` narrows to one service's daily series,
// mirroring how the monthly history endpoint supports service drill-down.
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
  const service = event.queryStringParameters?.service;

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'DAILY#' },
    // Newest first so `days` trims the oldest, then flip to chronological.
    ScanIndexForward: false,
    Limit: days,
  }));

  const rows = (Items ?? []).slice().reverse();

  // Today is always incomplete — providers post cost data hours behind, so a
  // low or zero value for today means "not reported yet", not "spend stopped".
  // Flagged so the UI can distinguish it instead of drawing a cliff to zero.
  const todayKey = new Date().toISOString().slice(0, 10);

  const series = rows.map((d) => {
    let spend = (d.totalSpend as number) ?? 0;
    if (service) {
      const match = (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
        ?.find((s) => s.name === service);
      spend = match?.spend ?? 0;
    }
    const dayKey = d.dayKey as string;
    /*
     * What that single day was spent on.
     *
     * Omitted when the caller asked for one service's series, where a
     * breakdown of the same day would be a list containing only itself.
     */
    const services = service
      ? undefined
      : dayServices(d.serviceBreakdown as ServiceBreakdownItem[] | undefined, spend);

    return {
      dayKey, label: d.label as string, spend, partial: dayKey >= todayKey, services,
    };
  });

  // Averages and totals use complete days only, so a partial today doesn't
  // drag the average down and make spend look like it fell.
  const complete = series.filter((d) => !d.partial);
  const total = complete.reduce((s, d) => s + d.spend, 0);

  return json(200, {
    days: series.length,
    // Absent for accounts connected before daily ingestion existed, so the UI
    // can prompt a refresh rather than implying the account has zero spend.
    available: series.length > 0,
    series,
    total,
    completeDays: complete.length,
    average: complete.length ? total / complete.length : 0,
    // Today's spend so far, reported separately since it isn't comparable to
    // a full day.
    partialToday: series.find((d) => d.partial)?.spend ?? null,
    // Top services over the window, for a daily-scoped breakdown.
    topServices: service ? [] : aggregateServices(rows.filter((d) => (d.dayKey as string) < todayKey)),
  });
};

function aggregateServices(rows: Record<string, unknown>[]) {
  const totals = new Map<string, number>();
  rows.forEach((d) => {
    (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      totals.set(s.name, (totals.get(s.name) ?? 0) + s.spend);
    });
  });
  const grand = Array.from(totals.values()).reduce((a, b) => a + b, 0);
  return Array.from(totals.entries())
    .map(([name, spend]) => ({ name, spend, pct: grand > 0 ? (spend / grand) * 100 : 0 }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
}
