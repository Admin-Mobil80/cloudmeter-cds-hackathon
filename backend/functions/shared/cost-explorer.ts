import { assumeCustomerRole } from './assume-customer-role';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetDimensionValuesCommand,
  GetTagsCommand,
} from '@aws-sdk/client-cost-explorer';
import type { ServiceBreakdownItem, TagBreakdownItem } from './seed-cost-data';

// Cost Explorer is a global service with a us-east-1 endpoint regardless of
// where the caller or the customer's resources live.
const CE_REGION = 'us-east-1';

export interface AssumeRoleTarget {
  roleArn: string;
  externalId: string;
}

async function ceClientFor(target: AssumeRoleTarget): Promise<CostExplorerClient> {
  const Credentials = await assumeCustomerRole(target.roleArn, target.externalId);

  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
    throw new Error('AssumeRole returned no credentials');
  }

  return new CostExplorerClient({
    region: CE_REGION,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
  });
}

/** Confirms both the trust policy (AssumeRole works) and the permission set
 * (a real Cost Explorer read succeeds), returning distinct errors for each so
 * the customer knows which half of their setup is wrong. */
export async function verifyAccess(target: AssumeRoleTarget): Promise<void> {
  let ce: CostExplorerClient;
  try {
    ce = await ceClientFor(target);
  } catch (err) {
    throw new Error(
      `Couldn't assume the role. Check the role ARN and that its trust policy allows this account with the exact External ID. (${(err as Error).name})`,
    );
  }

  const today = new Date();
  const start = new Date(today.getTime() - 2 * 86400000);
  try {
    await ce.send(new GetDimensionValuesCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(today) },
      Dimension: 'SERVICE',
    }));
  } catch (err) {
    throw new Error(
      `The role was assumed, but Cost Explorer access was denied. Attach the read-only Cost Explorer permissions shown above. (${(err as Error).name})`,
    );
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface RealMonthlySnapshot {
  monthKey: string;
  label: string;
  totalSpend: number;
  isCurrent: boolean;
  serviceBreakdown: ServiceBreakdownItem[];
  tagBreakdown: Record<string, TagBreakdownItem[]>;
}

/** Pulls 6 months of real MONTHLY-granularity unblended cost, grouped by
 * SERVICE, and builds per-month snapshots in the same shape the seeded
 * generator produces so the read handlers stay identical. */
export async function fetchMonthlySnapshots(target: AssumeRoleTarget, tagKeys: string[]): Promise<RealMonthlySnapshot[]> {
  const ce = await ceClientFor(target);
  const now = new Date();
  const start = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)));
  // Cost Explorer's End is exclusive, so push to the first of next month to
  // include the current (partial) month.
  const end = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

  const byService = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: isoDate(start), End: isoDate(end) },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));

  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const tagBreakdownByMonth = await fetchTagBreakdowns(ce, start, end, tagKeys);

  const snapshots: RealMonthlySnapshot[] = (byService.ResultsByTime ?? []).map((period) => {
    const periodStart = new Date(`${period.TimePeriod!.Start!}T00:00:00Z`);
    const monthKey = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

    const services = (period.Groups ?? [])
      .map((g) => ({
        name: g.Keys?.[0] ?? 'Unknown',
        spend: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
      }))
      .filter((s) => s.spend > 0);

    const totalSpend = services.reduce((sum, s) => sum + s.spend, 0);

    const serviceBreakdown: ServiceBreakdownItem[] = services
      .map((s) => ({
        name: s.name,
        spend: s.spend,
        pct: totalSpend > 0 ? (s.spend / totalSpend) * 100 : 0,
        trend: 0, // filled in below, once neighbouring months are known
      }))
      .sort((a, b) => b.spend - a.spend);

    return {
      monthKey,
      label: periodStart.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      totalSpend,
      isCurrent: monthKey === currentMonthKey,
      serviceBreakdown,
      tagBreakdown: tagBreakdownByMonth[monthKey] ?? {},
    };
  });

  // Real month-over-month trend per service, now that all months are loaded.
  for (let i = 1; i < snapshots.length; i++) {
    const prev = new Map(snapshots[i - 1].serviceBreakdown.map((s) => [s.name, s.spend]));
    for (const svc of snapshots[i].serviceBreakdown) {
      const before = prev.get(svc.name);
      svc.trend = before && before > 0 ? Math.round(((svc.spend - before) / before) * 100) : 0;
    }
  }

  return snapshots;
}

async function fetchTagBreakdowns(
  ce: CostExplorerClient,
  start: Date,
  end: Date,
  tagKeys: string[],
): Promise<Record<string, Record<string, TagBreakdownItem[]>>> {
  const result: Record<string, Record<string, TagBreakdownItem[]>> = {};

  for (const tagKey of tagKeys) {
    let byTag;
    try {
      byTag = await ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: isoDate(start), End: isoDate(end) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'TAG', Key: tagKey }],
      }));
    } catch {
      // A tag key with no cost-allocation data activated yet just yields
      // nothing for that dimension rather than failing the whole sync.
      continue;
    }

    for (const period of byTag.ResultsByTime ?? []) {
      const periodStart = new Date(`${period.TimePeriod!.Start!}T00:00:00Z`);
      const monthKey = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

      const rows: TagBreakdownItem[] = (period.Groups ?? [])
        .map((g) => {
          const raw = g.Keys?.[0] ?? '';
          // CE returns "tagKey$value", with an empty value for untagged spend.
          const value = raw.includes('$') ? raw.slice(raw.indexOf('$') + 1) : raw;
          return {
            label: value || 'Untagged',
            spend: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
            untagged: !value,
          };
        })
        .filter((r) => r.spend > 0)
        .sort((a, b) => b.spend - a.spend);

      if (rows.length === 0) continue;
      result[monthKey] ??= {};
      result[monthKey][tagKey] = rows;
    }
  }

  return result;
}

/** Discovers which cost-allocation tag keys the account actually has
 * activated, so the UI's tag dimensions reflect reality instead of a
 * hardcoded list. */
export async function fetchAvailableTagKeys(target: AssumeRoleTarget): Promise<string[]> {
  const ce = await ceClientFor(target);
  const now = new Date();
  const start = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

  try {
    const res = await ce.send(new GetTagsCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(now) },
    }));
    // With no TagKey supplied, GetTags returns the account's activated
    // cost-allocation tag keys themselves.
    return (res.Tags ?? []).filter((t): t is string => !!t).slice(0, 10);
  } catch {
    return [];
  }
}
