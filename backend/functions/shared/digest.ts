import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { normalizeTimezone, reportableDay, daysBehind, MAX_DIGEST_STALENESS_DAYS } from './schedule';
import type { ServiceBreakdownItem } from './providers';
import { resolveDisplayCurrency, type DisplayCurrency } from './display-currency';
import { FIXED_CHARGE_SERVICES } from './anomaly';

/** Complete days of history pulled per account to build a digest. */
// Enough to cover a month-end digest's previous-month comparison (up to 31 + 31
// days) with room for a late run, and matched to the 90 days the sync actually
// stores. At 65 a month-end digest that ran three days late silently truncated
// the previous month, which understated it and inflated the percentage change.
const LOOKBACK_DAYS = 95;

/** Days averaged to decide what "normal" looks like for a service. */
const BASELINE_DAYS = 7;

/**
 * A service must move by at least this much, in dollars, to be worth naming
 * as a "mover" in a digest someone reads on a phone.
 */
const MOVER_MIN_DELTA = 1;

/** Or move by at least this share of its own normal level... */
const MOVER_MIN_PCT = 50;

/**
 * ...once it has moved by at least this many dollars. Without this floor a
 * WhatsApp or GCP account running at fractions of a cent per day could never
 * clear MOVER_MIN_DELTA and so could never be named, however large its jump —
 * but a raw percentage escape on its own would call $0.001 -> $0.01 "up
 * 900%", which is noise, not a mover.
 */
const MOVER_MIN_DELTA_FOR_PCT = 0.20;

export interface DigestMover {
  service: string;
  /** The account's provider id ('aws', 'openai', …). */
  provider: string;
  accountName: string;
  spend: number;
  baseline: number;
  delta: number;
}

/** One service's cost on the reported day and month to date, across accounts. */
export interface DigestService {
  service: string;
  /** Provider id; the same name under two providers stays two services. */
  provider: string;
  daySpend: number;
  monthToDate: number;
}

export interface Digest {
  tenantName: string;
  /** The complete day being reported, e.g. 2026-08-19. */
  dayKey: string;
  dayLabel: string;
  /** How far behind the tenant's local today that day is. */
  daysBehind: number;
  daySpend: number;
  monthToDate: number;
  /** Same number of days into the previous month, for a fair comparison. */
  lastMonthToSamePoint: number | null;
  monthDeltaPct: number | null;
  movers: DigestMover[];
  /**
   * Every service with cost on the reported day or earlier in the month,
   * summed across accounts, largest on the day first. The digest names each
   * service's cost rather than only the one that moved most.
   */
  services: DigestService[];
  accountCount: number;
  /** Accounts whose sync is failing — worth saying out loud in a digest. */
  stale: Array<{ name: string; provider: string; lastSync: string | null }>;
  /**
   * What to render the amounts above in. Every figure on this object is USD,
   * the storage currency; this is what turns them into the tenant's own money.
   *
   * Carried on the digest rather than resolved by each sender, so the email and
   * the WhatsApp describing one day cannot quote different currencies, and so a
   * digest built once for several recipients converts once.
   */
  currency: DisplayCurrency;
}

interface AccountRow {
  accountId: string;
  name: string;
  provider: string;
  status?: string;
  sync?: string;
  dataSource?: string;
}

/**
 * Assembles a tenant's daily digest from stored cost rows.
 *
 * Reads only what we already hold — no provider calls, so a digest costs
 * nothing in metered API spend and can't be delayed by a slow cost API.
 */
export async function buildDigest(
  tenantId: string,
  tenantName: string,
  timezone: string,
  now = new Date(),
  /** null = every account in the tenant; a list = a Member's mapped accounts. */
  visibleAccountIds: string[] | null = null,
): Promise<Digest | null> {
  const tz = normalizeTimezone(timezone);

  // The tenant row is read alongside the accounts purely for display currency:
  // every stored figure is USD, and without this the digest quotes dollars to a
  // tenant whose dashboard shows rupees. Fetched in parallel so it costs no
  // extra round trip.
  const [{ Items: tenantItems }, { Item: tenantRow }] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
    })),
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    })),
  ]);

  // A currency that can't be resolved must not cost anyone their digest, so
  // this falls back to USD — the storage currency, so the figures stay true
  // even when the label is not the one the tenant picked.
  let currency: DisplayCurrency;
  try {
    currency = await resolveDisplayCurrency(tenantRow ?? {});
  } catch (err) {
    console.error(`Display currency unresolved for tenant ${tenantId}; quoting USD`, err);
    currency = {
      code: 'USD', symbol: '$', rate: 1, localCode: 'USD',
      mode: 'USD', source: 'auto', rateSource: 'unavailable', rateAsOf: null,
    };
  }

  // Sample data is generated for demos — including it here would report
  // spend and trends nobody is actually incurring.
  const all = (tenantItems ?? [])
    .filter((a) => (a as unknown as AccountRow).dataSource === 'live') as unknown as AccountRow[];
  // null = every account. A Member gets a digest covering only what they can
  // open; without this the email would leak the tenant-wide total that the
  // dashboard deliberately withholds from them.
  const accounts = visibleAccountIds === null
    ? all
    : all.filter((a) => visibleAccountIds.includes(a.accountId));
  if (accounts.length === 0) return null;

  const perAccount = await Promise.all(accounts.map(async (a) => {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':sk': 'DAILY#' },
      ScanIndexForward: false,
      Limit: LOOKBACK_DAYS,
    }));
    return { account: a, days: (Items ?? []) as Array<Record<string, unknown>> };
  }));

  // Keyed by day so that when several accounts hold the same day, the day is
  // only reportable once *every* one of them has been observed after it
  // closed. Taking the newest sync would let one freshly-synced account vouch
  // for another that is still holding a mid-day figure, and the digest sums
  // them into a single total.
  const oldestSyncPerDay = new Map<string, string | null>();
  perAccount.forEach(({ days }) => days.forEach((d) => {
    const key = d.dayKey as string;
    const syncedAt = (d.syncedAt as string | undefined) ?? null;
    if (!oldestSyncPerDay.has(key)) { oldestSyncPerDay.set(key, syncedAt); return; }
    const held = oldestSyncPerDay.get(key)!;
    // A row with no syncedAt is the weakest evidence there is, so it wins.
    if (held === null || syncedAt === null) { oldestSyncPerDay.set(key, null); return; }
    if (syncedAt < held) oldestSyncPerDay.set(key, syncedAt);
  }));

  const dayKey = reportableDay(
    Array.from(oldestSyncPerDay, ([k, syncedAt]) => ({ dayKey: k, syncedAt })),
    tz,
    now,
  );
  if (!dayKey) return null;

  const behind = daysBehind(dayKey, tz, now);
  // Nothing recent enough to call a daily summary. The sweep reports this as a
  // skip rather than sending a digest about data from last week.
  if (behind > MAX_DIGEST_STALENESS_DAYS) return null;

  let daySpend = 0;
  let monthToDate = 0;
  let lastMonthToSamePoint = 0;
  let sawLastMonth = false;

  const month = dayKey.slice(0, 7);
  const dayOfMonth = Number(dayKey.slice(8, 10));
  const prevMonth = previousMonthOf(month);

  // The percentage compares equal numbers of days on both sides.
  //
  // Taking "the same point last month" as day-of-month alone breaks when the
  // previous month is shorter: a 31 March digest was measured against all 28
  // days of February, so March read ~10% up on day count before a single
  // resource changed. Clamping to the shorter month compares like with like.
  //
  // monthToDate itself is deliberately NOT clamped — it is the real
  // month-to-date figure people expect to see, and only the comparison needs
  // matched spans.
  const comparableDays = Math.min(dayOfMonth, daysInMonth(prevMonth));
  let currentToSamePoint = 0;

  const movers: DigestMover[] = [];
  // Keyed by provider and name together, so each service keeps its provider.
  const serviceKey = (provider: string, name: string) => `${provider}\u0000${name}`;
  const serviceDay = new Map<string, number>();
  const serviceMonth = new Map<string, number>();

  for (const { account, days } of perAccount) {
    const byKey = new Map(days.map((d) => [d.dayKey as string, d]));

    const today = byKey.get(dayKey);
    if (today) daySpend += (today.totalSpend as number) ?? 0;

    for (const d of days) {
      const key = d.dayKey as string;
      const spend = (d.totalSpend as number) ?? 0;
      if (key.startsWith(month) && key <= dayKey) {
        monthToDate += spend;
        (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((x) => {
          const k = serviceKey(account.provider, x.name);
          serviceMonth.set(k, (serviceMonth.get(k) ?? 0) + (x.spend ?? 0));
          if (key === dayKey) serviceDay.set(k, (serviceDay.get(k) ?? 0) + (x.spend ?? 0));
        });
        if (Number(key.slice(8, 10)) <= comparableDays) currentToSamePoint += spend;
      }
      // Same slice of the previous month, so a digest sent on the 3rd doesn't
      // compare three days against a full previous month.
      if (key.startsWith(prevMonth) && Number(key.slice(8, 10)) <= comparableDays) {
        lastMonthToSamePoint += spend;
        sawLastMonth = true;
      }
    }

    if (today) {
      movers.push(...moversFor(account, today, byKey, dayKey));
    }
  }

  const stale = accounts
    .filter((a) => a.status === 'error')
    .map((a) => ({ name: a.name, provider: a.provider, lastSync: a.sync ?? null }));

  return {
    tenantName,
    dayKey,
    dayLabel: formatDay(dayKey),
    daysBehind: behind,
    daySpend,
    monthToDate,
    lastMonthToSamePoint: sawLastMonth ? lastMonthToSamePoint : null,
    // Both sides span `comparableDays`, so this is a like-for-like change and
    // not partly an artefact of one month being longer than the other.
    monthDeltaPct: sawLastMonth && lastMonthToSamePoint > 0
      ? ((currentToSamePoint - lastMonthToSamePoint) / lastMonthToSamePoint) * 100
      : null,
    movers: movers.sort((a, b) => b.delta - a.delta).slice(0, 3),
    services: Array.from(serviceMonth.keys())
      .map((k) => {
        const [provider, service] = k.split('\u0000');
        return { service, provider, daySpend: serviceDay.get(k) ?? 0, monthToDate: serviceMonth.get(k) ?? 0 };
      })
      .filter((x) => x.daySpend > 0 || x.monthToDate > 0)
      .sort((a, b) => b.daySpend - a.daySpend || b.monthToDate - a.monthToDate),
    accountCount: accounts.length,
    stale,
    currency,
  };
}

/**
 * Services that cost materially more on the reported day than they normally do.
 *
 * "Normally" is the mean of the preceding complete days rather than the single
 * day before — one quiet Sunday shouldn't make Monday look like a spike.
 */
function moversFor(
  account: AccountRow,
  today: Record<string, unknown>,
  byKey: Map<string, Record<string, unknown>>,
  dayKey: string,
): DigestMover[] {
  const baselineKeys = Array.from(byKey.keys()).filter((k) => k < dayKey).sort().slice(-BASELINE_DAYS);
  if (baselineKeys.length === 0) return [];

  const baselineTotals = new Map<string, number>();
  for (const k of baselineKeys) {
    const row = byKey.get(k);
    (row?.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      baselineTotals.set(s.name, (baselineTotals.get(s.name) ?? 0) + s.spend);
    });
  }

  const out: DigestMover[] = [];
  (today.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
    // A periodic charge landing on its billing day is not a "mover". Averaging
    // it across a week of $0 days makes an ordinary renewal look like the
    // largest change of the day and push a real one out of the digest. Genuine
    // over-charges are still caught — as fixed-charge anomalies, which carry
    // the amount comparison this figure cannot.
    if (FIXED_CHARGE_SERVICES.has(s.name)) return;
    const baseline = (baselineTotals.get(s.name) ?? 0) / baselineKeys.length;
    const delta = s.spend - baseline;

    // A flat dollar floor decided whether a service could EVER be named,
    // which shut cents-per-day accounts out of the digest entirely — the
    // same account could 10x and still never appear. It now also qualifies
    // on the size of ITS OWN move, gated by MOVER_MIN_DELTA_FOR_PCT so a
    // literal fraction of a cent can't pass on percentage alone.
    const deltaPct = baseline > 0 ? (delta / baseline) * 100 : null;
    const worthNaming = delta >= MOVER_MIN_DELTA
      || (deltaPct !== null && deltaPct >= MOVER_MIN_PCT && delta >= MOVER_MIN_DELTA_FOR_PCT);
    if (!worthNaming) return;

    out.push({
      service: s.name,
      provider: account.provider,
      accountName: account.name,
      spend: s.spend,
      baseline,
      delta,
    });
  });
  return out;
}

/** Calendar length of a "yyyy-MM" month, leap years included. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function previousMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2026-08-19" -> "19 Aug 2026", the form used in emails and templates. */
export function formatDay(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Formats a USD amount in the tenant's display currency.
 *
 * Callers hold USD — the storage currency — so the rate is applied here rather
 * than at every call site. Passing no currency keeps the old dollar output,
 * which is what plan pricing wants: those figures are quoted in USD by
 * definition and must not move with a tenant's display preference.
 */
export function money(n: number, currency?: Pick<DisplayCurrency, 'symbol' | 'rate' | 'code'>): string {
  // An unusable rate drops the whole currency, symbol included: converting at
  // 1 but still writing ₹ would label a dollar figure as rupees, which is worse
  // than admitting we could not convert.
  const usable = currency && Number.isFinite(currency.rate) && currency.rate > 0 ? currency : undefined;
  const symbol = usable?.symbol ?? '$';
  // Indian digit grouping is 2,2,3 rather than 3,3,3 — en-US would render
  // ₹1,74,980 as ₹174,980, which reads wrong to the people it is quoted to.
  const locale = usable?.code === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${Math.round(n * (usable?.rate ?? 1)).toLocaleString(locale)}`;
}
