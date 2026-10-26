import { assumeCustomerRole } from '../assume-customer-role';
import type { Expression } from '@aws-sdk/client-cost-explorer';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetDimensionValuesCommand,
  GetTagsCommand,
} from '@aws-sdk/client-cost-explorer';
import {
  ProviderAdapter,
  ProviderCredentials,
  ProviderAuthError,
  ProviderPermissionError,
  MonthlySnapshot,
  DailySnapshot,
  TagBreakdownItem,
  UntaggedServiceItem,
  buildSnapshots,
  buildDailySnapshots,
  isoDate,
  monthKeyOf,
  monthStart,
  dayStart,
} from './types';

// Cost Explorer is global with a us-east-1 endpoint, regardless of where the
// caller or the customer's resources live.
const CE_REGION = 'us-east-1';

async function ceClientFor(creds: ProviderCredentials): Promise<CostExplorerClient> {
  const Credentials = await assumeCustomerRole(creds.roleArn!, creds.externalId!);

  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
    throw new ProviderAuthError('AssumeRole returned no credentials');
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

async function fetchTagBreakdowns(
  ce: CostExplorerClient,
  creds: ProviderCredentials,
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
        ...linkedAccountFilter(creds),
      }));
    } catch {
      // A tag key without cost-allocation data activated yet just yields
      // nothing for that dimension rather than failing the whole sync.
      continue;
    }

    for (const period of byTag.ResultsByTime ?? []) {
      const periodStart = new Date(`${period.TimePeriod!.Start!}T00:00:00Z`);
      const key = monthKeyOf(periodStart);

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
      result[key] ??= {};
      result[key][tagKey] = rows;
    }
  }

  return result;
}

/**
 * What the untagged remainder is actually spent on.
 *
 * "Untagged / Shared" on the tag card is a residual — the account total minus
 * everything carrying a tag — so it is arithmetic rather than a row anything
 * was ever asked about, and there was no way to answer "what is that money?".
 * On one account it was 37% of the bill and completely opaque.
 *
 * Answered here by asking Cost Explorer the question directly: spend grouped
 * by service, filtered to resources carrying *none* of the account's tag
 * keys. ABSENT on every key is the same set the residual describes, so the
 * two agree by construction rather than by a subtraction that could drift.
 *
 * One extra CE call per refresh — CE bills per request — which is why it is
 * a single query for all keys at once rather than one per key, and why it is
 * skipped entirely for an account with no tag keys, where the residual is the
 * whole bill and the service card already answers it.
 */
async function fetchUntaggedServices(
  ce: CostExplorerClient,
  creds: ProviderCredentials,
  start: Date,
  end: Date,
  tagKeys: string[],
): Promise<Record<string, UntaggedServiceItem[]>> {
  if (tagKeys.length === 0) return {};

  const noTags: Expression[] = tagKeys.map((Key) => ({
    Tags: { Key, MatchOptions: ['ABSENT'] },
  }));
  const scope = linkedAccountFilter(creds).Filter;
  // CE rejects And/Or with a single member, so a lone tag key goes in bare.
  const untagged: Expression = noTags.length === 1 ? noTags[0] : { And: noTags };

  let res;
  try {
    res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Filter: scope ? { And: [scope, untagged] } : untagged,
    }));
  } catch (err) {
    // Same posture as the per-key query above: a tag dimension the account
    // has not activated must not cost anyone their whole sync.
    console.warn('Untagged service breakdown unavailable', (err as Error).message);
    return {};
  }

  const out: Record<string, UntaggedServiceItem[]> = {};
  for (const period of res.ResultsByTime ?? []) {
    const key = monthKeyOf(new Date(`${period.TimePeriod!.Start!}T00:00:00Z`));
    const rows = (period.Groups ?? [])
      .map((g) => ({
        name: g.Keys?.[0] ?? 'Unknown',
        spend: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
      }))
      .filter((r) => r.spend > 0)
      .sort((a, b) => b.spend - a.spend);
    if (rows.length) out[key] = rows;
  }
  return out;
}

async function fetchAvailableTagKeys(ce: CostExplorerClient): Promise<string[]> {
  const now = new Date();
  try {
    const res = await ce.send(new GetTagsCommand({
      TimePeriod: { Start: isoDate(monthStart(now, -1)), End: isoDate(now) },
    }));
    // With no TagKey supplied, GetTags returns the account's activated
    // cost-allocation tag keys themselves.
    return (res.Tags ?? []).filter((t): t is string => !!t).slice(0, 10);
  } catch {
    return [];
  }
}


// Cost Explorer returns region codes, which read as opaque strings in a cost
// report. There's no API that maps code to city, so this table does — and any
// code not listed simply shows as itself rather than being dropped or guessed.
const AWS_REGION_NAMES: Record<string, string> = {
  'us-east-1': 'N. Virginia', 'us-east-2': 'Ohio',
  'us-west-1': 'N. California', 'us-west-2': 'Oregon',
  'af-south-1': 'Cape Town',
  'ap-east-1': 'Hong Kong',
  'ap-south-1': 'Mumbai', 'ap-south-2': 'Hyderabad',
  'ap-southeast-1': 'Singapore', 'ap-southeast-2': 'Sydney',
  'ap-southeast-3': 'Jakarta', 'ap-southeast-4': 'Melbourne',
  'ap-northeast-1': 'Tokyo', 'ap-northeast-2': 'Seoul', 'ap-northeast-3': 'Osaka',
  'ca-central-1': 'Canada Central', 'ca-west-1': 'Calgary',
  'eu-central-1': 'Frankfurt', 'eu-central-2': 'Zurich',
  'eu-west-1': 'Ireland', 'eu-west-2': 'London', 'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm', 'eu-south-1': 'Milan', 'eu-south-2': 'Spain',
  'il-central-1': 'Tel Aviv',
  'me-south-1': 'Bahrain', 'me-central-1': 'UAE',
  'sa-east-1': 'S\u00e3o Paulo',
};

// Charges with no location — support plans, some taxes, savings-plan fees —
// come back under several different literals. They're one concept to a reader,
// so they collapse to one row rather than appearing as two or three
// identically-labelled lines.
const UNPLACED_CODES = new Set(['NoRegion', 'global', '']);
const UNPLACED = 'NoRegion';

function regionDisplayName(code: string): string {
  if (UNPLACED_CODES.has(code)) return 'Not region-specific';
  const city = AWS_REGION_NAMES[code];
  return city ? `${city} (${code})` : code;
}

async function fetchRegionBreakdowns(
  ce: CostExplorerClient,
  creds: ProviderCredentials,
  start: Date,
  end: Date,
): Promise<Record<string, Array<{ name: string; displayName: string; spend: number }>>> {
  const result: Record<string, Array<{ name: string; displayName: string; spend: number }>> = {};

  let byRegion;
  try {
    byRegion = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'REGION' }],
      ...linkedAccountFilter(creds),
    }));
  } catch {
    // One optional dimension failing must not cost us the whole sync — the
    // service and tag data is the same call pattern and already succeeded.
    return result;
  }

  for (const period of byRegion.ResultsByTime ?? []) {
    const periodStart = new Date(`${period.TimePeriod!.Start!}T00:00:00Z`);

    const merged = new Map<string, { name: string; displayName: string; spend: number }>();
    for (const g of period.Groups ?? []) {
      const raw = g.Keys?.[0] ?? '';
      const code = UNPLACED_CODES.has(raw) ? UNPLACED : raw;
      const row = merged.get(code)
        ?? { name: code, displayName: regionDisplayName(code), spend: 0 };
      row.spend += Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      merged.set(code, row);
    }

    result[monthKeyOf(periodStart)] = Array.from(merged.values());
  }

  return result;
}


/**
 * A management (payer) account's Cost Explorer returns the *whole
 * organization's* spend, not its own. Connect a payer and its members
 * separately — which is the normal way to get per-account visibility — and
 * every member's cost is counted twice: once inside the payer's consolidated
 * figure and once on its own.
 *
 * So every query is scoped to the one account it belongs to. For a member
 * account this changes nothing (it can only see itself anyway); for a payer it
 * is the difference between its own spend and its entire org's.
 *
 * `costScope: 'organization'` opts back into the consolidated view, for
 * someone who connects only the payer and wants a single org-wide roll-up.
 */
function linkedAccountFilter(creds: ProviderCredentials): { Filter?: Expression } {
  if (creds.costScope === 'organization') return {};

  const accountId = accountIdFromRoleArn(creds.roleArn);
  if (!accountId) return {};

  return {
    Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
  };
}

/** "arn:aws:iam::975138397215:role/CloudMeterReadOnly" -> "975138397215" */
function accountIdFromRoleArn(roleArn?: string): string | null {
  const m = /^arn:aws:iam::(\d{12}):role\//.exec(roleArn ?? '');
  return m ? m[1] : null;
}

export const awsAdapter: ProviderAdapter = {
  key: 'aws',
  displayName: 'Amazon Web Services',
  verified: true,

  // AWS deliberately uses cross-account AssumeRole rather than stored access
  // keys: nothing secret is retained, and the customer can revoke access at
  // any time by deleting the role. Both fields are issued/validated by the
  // dedicated connect flow, so neither is a free-text secret.
  credentialFields: [
    { name: 'roleArn', label: 'Role ARN', type: 'text', required: true, placeholder: 'arn:aws:iam::111122223333:role/CloudMeterReadOnly' },
  ],

  async verifyAccess(creds) {
    let ce: CostExplorerClient;
    try {
      ce = await ceClientFor(creds);
    } catch (err) {
      throw new ProviderAuthError(
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
      throw new ProviderPermissionError(
        `The role was assumed, but Cost Explorer access was denied. Attach the read-only Cost Explorer permissions shown above. (${(err as Error).name})`,
      );
    }
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const ce = await ceClientFor(creds);
    const now = new Date();
    const start = monthStart(now, -(months - 1));
    // End at tomorrow, not the first of next month.
    //
    // Cost Explorer amortizes subscription charges — support plans, domain
    // renewals, hosted zones — across every day of the month, including days
    // that haven't happened yet. Asking for the whole month therefore returns
    // the *projected* month, and calling that "month to date" overstates it:
    // on this org's payer account it added $38 of not-yet-incurred spend on the
    // 21st. Ending at tomorrow makes the current month genuinely month-to-date,
    // and leaves complete past months unchanged.
    const end = dayStart(now, 1);

    const byService = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ...linkedAccountFilter(creds),
    }));

    const tagKeys = await fetchAvailableTagKeys(ce);
    const tagsByMonth = await fetchTagBreakdowns(ce, creds, start, end, tagKeys);
    const untaggedByMonth = await fetchUntaggedServices(ce, creds, start, end, tagKeys);
    const regionsByMonth = await fetchRegionBreakdowns(ce, creds, start, end);

    return buildSnapshots((byService.ResultsByTime ?? []).map((period) => {
      const periodStart = new Date(`${period.TimePeriod!.Start!}T00:00:00Z`);
      return {
        date: periodStart,
        services: (period.Groups ?? []).map((g) => ({
          name: g.Keys?.[0] ?? 'Unknown',
          spend: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
        })),
        tagBreakdown: tagsByMonth[monthKeyOf(periodStart)] ?? {},
        untaggedServices: untaggedByMonth[monthKeyOf(periodStart)] ?? [],
        regions: regionsByMonth[monthKeyOf(periodStart)] ?? [],
      };
    }));
  },

  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const ce = await ceClientFor(creds);
    const now = new Date();
    // End is exclusive; tomorrow captures today's partial spend. Cost Explorer
    // retains DAILY granularity well beyond a year, so any window we ask for
    // here is available — unlike HOURLY, which is ~14 days and costs more.
    const start = dayStart(now, -(days - 1));
    const end = dayStart(now, 1);

    const byService = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(end) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ...linkedAccountFilter(creds),
    }));

    return buildDailySnapshots((byService.ResultsByTime ?? []).map((period) => ({
      date: new Date(`${period.TimePeriod!.Start!}T00:00:00Z`),
      services: (period.Groups ?? []).map((g) => ({
        name: g.Keys?.[0] ?? 'Unknown',
        spend: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
      })),
    })));
  },
};
