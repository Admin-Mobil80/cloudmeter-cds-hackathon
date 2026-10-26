import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import type { ServiceBreakdownItem } from './seed-cost-data';
import {
  comparisonWindow, sumDaysInRange, sumServicesInRange, deltaPct, coveredDaysFrom,
} from './period';

/**
 * The roll-up behind the dashboard: month-to-date spend, its comparison, the
 * projection, and the per-service and per-provider breakdowns.
 *
 * Lifted out of the dashboard-summary handler unchanged so the WhatsApp
 * assistant quotes exactly the figures the dashboard shows. `accountIds`
 * narrows it to those accounts (a Member's mapping); null means all of them.
 * All amounts are USD, the storage currency.
 */
export async function buildDashboardSummary(tenantId: string, accountIds: string[] | null = null) {
  const { Items: accounts } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
  }));

  const { Items: alerts } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ALERT#' },
    ScanIndexForward: false,
  }));

  const accountList = (accounts ?? []).filter((a) => accountIds === null || accountIds.includes(a.accountId as string));
  const alertList = (alerts ?? []).filter((a) => accountIds === null || accountIds.includes(a.accountId as string));

  // yyyy-MM for the month the projection is about.
  const thisMonthKey = new Date().toISOString().slice(0, 7);

  const monthlyByAccount = await Promise.all(accountList.map(async (a) => {
    const [{ Items }, { Items: dayRows }] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':sk': 'MONTHLY#' },
        // Newest first for the stat tiles; the full set also feeds the trend
        // chart below, so fetch all of them rather than just the last two.
        ScanIndexForward: false,
      })),
      // Only this month's keys, and only the key — enough to tell how many
      // days the month-to-date figure covers, without reading the rows.
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':sk': `DAILY#${thisMonthKey}` },
        ProjectionExpression: 'SK',
      })),
    ]);
    const all = Items ?? [];
    return {
      account: a,
      current: all[0],
      previous: all[1],
      all,
      dayKeys: (dayRows ?? []).map((r) => String(r.SK)),
    };
  }));

  const dailyKeysThisMonth = monthlyByAccount.flatMap((m) => m.dayKeys);

  const mtdSpend = monthlyByAccount.reduce((s, m) => s + (m.current?.totalSpend ?? 0), 0);

  // The headline figure above is the whole month so far, today included —
  // that is what "month to date" means and it stays as it is. The comparison
  // below is a different question, and answering it with the same number is
  // what made this tile wrong: 16 days of September were being set against all
  // 31 days of August, reporting a ~50% fall that was only the month not being
  // over yet.
  //
  // One Query per account covering both windows at once, rather than two. The
  // daily rows are already there; nothing new has to be collected.
  const window = comparisonWindow();
  let mtdSpendDeltaPct: number | null = null;
  let comparisonDays: number | null = null;
  // Per-service totals over the same two windows, feeding the "vs last month"
  // column further down. Built from this one pass over the daily rows rather
  // than a second round of queries.
  let servicesNow = new Map<string, number>();
  let servicesThen = new Map<string, number>();

  if (window) {
    const dailyByAccount = await Promise.all(accountList.map(async (a) => {
      const { Items } = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `ACCOUNT#${a.accountId}`,
          ':from': `DAILY#${window.previousFrom}`,
          ':to': `DAILY#${window.currentTo}`,
        },
      }));
      return (Items ?? []).map((d) => ({
        date: String(d.SK).replace('DAILY#', ''),
        spend: (d.totalSpend as number) ?? 0,
        services: (d.serviceBreakdown ?? []) as Array<{ name: string; spend: number }>,
      }));
    }));

    const rows = dailyByAccount.flat();
    const currentWindow = sumDaysInRange(rows, window.currentFrom, window.currentTo);
    const previousWindow = sumDaysInRange(rows, window.previousFrom, window.previousTo);
    servicesNow = sumServicesInRange(rows, window.currentFrom, window.currentTo);
    servicesThen = sumServicesInRange(rows, window.previousFrom, window.previousTo);

    // Only claim a comparison when there is something on both sides. A tenant
    // connected mid-month has no previous window, and 0 there would otherwise
    // render as an infinite rise.
    if (previousWindow > 0) {
      mtdSpendDeltaPct = ((currentWindow - previousWindow) / previousWindow) * 100;
      comparisonDays = window.days;
    }
  }

  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  /*
   * Spread across the days the figure actually covers, not the calendar.
   *
   * `mtdSpend` only contains days the providers have reported. Dividing it by
   * today's date counts days that contributed nothing to it — every morning
   * before the 13:05 sync, today is in the divisor and not in the numerator,
   * and the projection reads low by a whole day's worth. ACME on 6 October:
   * $53.48 over five reported days was being shown as $276 rather than $332,
   * because it was divided by six.
   *
   * Worst early in the month, where one missing day of five is 20% of the
   * answer; by the 25th the same day is 4%. It never self-corrects — it is
   * wrong in the same direction every day.
   */
  const coveredDays = coveredDaysFrom(dailyKeysThisMonth, dayOfMonth);
  const projectedMonthEnd = coveredDays > 0 ? (mtdSpend / coveredDays) * daysInMonth : mtdSpend;

  // No acknowledge/snooze/escalate concept any more — every raised alert counts.
  const activeAlerts = alertList;
  const criticalAlerts = activeAlerts.filter((a) => a.severity === 'critical');
  const criticalImpact = criticalAlerts.reduce((s, a) => s + (a.impact ?? 0), 0);

  // A count per severity, so the tile can say what the four anomalies are
  // rather than only whether any of them are critical. Counted here because
  // the page is only sent `recentAlerts` — a slice — and counting a slice
  // would quietly under-report the moment there were more than a handful.
  const severityCounts = activeAlerts.reduce<Record<string, number>>((acc, a) => {
    const key = String(a.severity ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const providerSet = new Set(accountList.map((a) => a.provider));

  const byProviderMap = new Map<string, { provider: string; accountCount: number; spend: number }>();
  monthlyByAccount.forEach(({ account, current }) => {
    const key = account.provider;
    const entry = byProviderMap.get(key) ?? { provider: key, accountCount: 0, spend: 0 };
    entry.accountCount += 1;
    entry.spend += current?.totalSpend ?? 0;
    byProviderMap.set(key, entry);
  });
  const byProvider = Array.from(byProviderMap.values())
    .map((p) => ({ ...p, pct: mtdSpend > 0 ? (p.spend / mtdSpend) * 100 : 0 }))
    .sort((a, b) => b.spend - a.spend);

  // Aggregated per service across every account, not per service-and-account
  // pair. A service spread thinly over many accounts — S3 and DynamoDB here —
  // never ranks as a single pair, so the estate's largest costs were invisible
  // on a list built from pairs. The per-account split rides along for the
  // drill-down.
  interface ServiceRollup {
    name: string;
    provider: string;
    spend: number;
    accounts: Array<{ accountId: string; accountName: string; spend: number }>;
  }
  const byService = new Map<string, ServiceRollup>();

  // Only the current month's totals are gathered here. The comparison used to
  // be accumulated alongside them from the previous month's snapshot, which is
  // where the whole-month-against-part-month mismatch came from; it now comes
  // from servicesNow/servicesThen above, summed over matching windows.
  //
  // Either way it is computed from aggregated totals rather than by averaging
  // each account's own percentage — an average of percentages is not the
  // percentage of the total, and would be wrong whenever accounts differ in
  // size, which they always do.
  monthlyByAccount.forEach(({ account, current }) => {
    (current?.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      if (s.spend <= 0) return;
      const entry: ServiceRollup = byService.get(s.name) ?? {
        name: s.name,
        provider: account.provider as string,
        spend: 0,
        accounts: [],
      };
      entry.spend += s.spend;
      entry.accounts.push({
        accountId: account.accountId as string,
        accountName: account.name as string,
        spend: s.spend,
      });
      byService.set(s.name, entry);
    });
  });

  const services = Array.from(byService.values())
    .map((s) => ({
      name: s.name,
      provider: s.provider,
      spend: s.spend,
      pct: mtdSpend > 0 ? (s.spend / mtdSpend) * 100 : 0,
      // Matching windows, same as the tile above — not this part-month against
      // all of the last one. `spend` beside it stays the true month-to-date
      // figure; only the comparison is windowed.
      trend: deltaPct(servicesNow.get(s.name) ?? 0, servicesThen.get(s.name) ?? 0),
      accountCount: s.accounts.length,
      accounts: s.accounts.sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.spend - a.spend);

  const topServices = services.slice(0, 6);

  // Real per-provider monthly trend, assembled from the snapshots already
  // loaded above. Only monthly granularity is ingested today, so this is the
  // finest real series available — the chart must not imply hourly/daily data
  // that doesn't exist.
  const monthMeta = new Map<string, string>();
  const spendByProviderMonth = new Map<string, Map<string, number>>();

  monthlyByAccount.forEach(({ account, all }) => {
    all.forEach((m) => {
      const key = m.monthKey as string;
      if (!key) return;
      monthMeta.set(key, (m.label as string) ?? key);
      const perMonth = spendByProviderMonth.get(account.provider) ?? new Map<string, number>();
      perMonth.set(key, (perMonth.get(key) ?? 0) + ((m.totalSpend as number) ?? 0));
      spendByProviderMonth.set(account.provider, perMonth);
    });
  });

  const monthKeys = Array.from(monthMeta.keys()).sort();
  const trend = {
    granularity: 'monthly' as const,
    labels: monthKeys.map((k) => monthMeta.get(k)!),
    series: Array.from(spendByProviderMonth.entries())
      .map(([provider, perMonth]) => ({
        provider,
        values: monthKeys.map((k) => perMonth.get(k) ?? 0),
      }))
      .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0)),
  };

  // Most recent successful sync across all accounts, so the header can report
  // real freshness instead of a fixed string.
  const syncTimes = accountList
    .map((a) => (a.sync ? new Date(a.sync as string).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  const lastSyncAt = syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null;

  return {
    trend,
    lastSyncAt,
    statTiles: {
      mtdSpend,
      mtdSpendDeltaPct,
      // How many complete days each side of that comparison covers, so the tile
      // can say what it actually compared instead of the bare "vs last month"
      // that hid the mismatch in the first place.
      comparisonDays,
      projectedMonthEnd,
      dayOfMonth,
      daysInMonth,
      /*
       * How many days the projection actually divided by.
       *
       * Sent because the tile's sub-line used to read "day 6 of 31" beside a
       * figure computed from five days, which is the number contradicting its
       * own caption. Where it is behind the calendar, that gap is the honest
       * thing on the tile: it says the providers have not reported today yet.
       */
      coveredDays,
      activeAnomalies: activeAlerts.length,
      criticalCount: criticalAlerts.length,
      criticalImpact,
      severityCounts,
      connectedAccounts: accountList.length,
      providerCount: providerSet.size,
    },
    topServices,
    // Every service, so "view all" needs no second request — 46 rows here,
    // far smaller than the 279 service-and-account pairs it replaces.
    services,
    byProvider,
    recentAlerts: alertList.slice(0, 3),
  };
}
