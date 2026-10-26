import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, requireOrgScope, json } from '../../shared/authz';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

// Tenant-wide daily spend, split by provider, for the dashboard's daily view.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const outOfScope = requireOrgScope(caller);
  if (outOfScope) return outOfScope;

  const requested = Number(event.queryStringParameters?.days ?? DEFAULT_DAYS);
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_DAYS)
    : DEFAULT_DAYS;

  const { Items: accounts } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ACCOUNT#' },
  }));

  const accountList = accounts ?? [];

  const perAccount = await Promise.all(accountList.map(async (a) => {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':sk': 'DAILY#' },
      ScanIndexForward: false,
      Limit: days,
    }));
    return { provider: a.provider as string, rows: Items ?? [] };
  }));

  // Union of days present, so an account connected mid-window doesn't shorten
  // the axis for everyone else.
  const dayMeta = new Map<string, string>();
  const byProvider = new Map<string, Map<string, number>>();

  perAccount.forEach(({ provider, rows }) => {
    rows.forEach((d) => {
      const key = d.dayKey as string;
      if (!key) return;
      dayMeta.set(key, (d.label as string) ?? key);
      const per = byProvider.get(provider) ?? new Map<string, number>();
      per.set(key, (per.get(key) ?? 0) + ((d.totalSpend as number) ?? 0));
      byProvider.set(provider, per);
    });
  });

  const dayKeys = Array.from(dayMeta.keys()).sort();

  const series = Array.from(byProvider.entries())
    .map(([provider, per]) => ({
      provider,
      values: dayKeys.map((k) => per.get(k) ?? 0),
    }))
    .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));

  const dailyTotals = dayKeys.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));

  // Today is always incomplete — providers post cost hours behind, so today's
  // low/zero figure means "not reported yet". Flagged so the chart can render
  // it distinctly rather than showing a drop to zero, and excluded from
  // totals and averages so it can't skew them.
  const todayKey = new Date().toISOString().slice(0, 10);
  const partialFlags = dayKeys.map((k) => k >= todayKey);

  const completeTotals = dailyTotals.filter((_, i) => !partialFlags[i]);
  const total = completeTotals.reduce((a, b) => a + b, 0);

  // Yesterday vs the preceding 7-day average — the comparison that actually
  // tells you whether spend moved.
  const latestComplete = completeTotals.length ? completeTotals[completeTotals.length - 1] : null;
  const priorWindow = completeTotals.slice(-8, -1);
  const priorAvg = priorWindow.length
    ? priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length
    : null;

  return json(200, {
    granularity: 'daily' as const,
    available: dayKeys.length > 0,
    labels: dayKeys.map((k) => dayMeta.get(k)!),
    dayKeys,
    partialFlags,
    series,
    total,
    completeDays: completeTotals.length,
    average: completeTotals.length ? total / completeTotals.length : 0,
    partialToday: partialFlags[partialFlags.length - 1]
      ? dailyTotals[dailyTotals.length - 1]
      : null,
    latestComplete,
    latestCompleteDeltaPct:
      latestComplete !== null && priorAvg !== null && priorAvg > 0
        ? ((latestComplete - priorAvg) / priorAvg) * 100
        : null,
  });
};
