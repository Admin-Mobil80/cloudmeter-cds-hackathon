import { ClientSecretCredential } from '@azure/identity';
import { CostManagementClient, isRestError } from '@azure/arm-costmanagement';
import type { QueryColumn, QueryDefinition, QueryResult } from '@azure/arm-costmanagement';
import {
  ProviderAdapter,
  ProviderCredentials,
  ProviderAuthError,
  ProviderPermissionError,
  MonthlySnapshot,
  DailySnapshot,
  TagBreakdownItem,
  buildSnapshots,
  buildDailySnapshots,
  monthKeyOf,
  monthStart,
  dayKeyOf,
  dayStart,
} from './types';

// Everything below talks to the Cost Management *Query* API
// (POST {scope}/providers/Microsoft.CostManagement/query), which is the only
// endpoint that returns aggregated cost without provisioning an Export +
// storage account first.
const ARM_ENDPOINT = 'https://management.azure.com';
const ARM_SCOPE = `${ARM_ENDPOINT}/.default`;
// Matches the api-version the installed @azure/arm-costmanagement pins, so the
// hand-rolled tags request below can't drift away from the SDK's queries.
const API_VERSION = '2025-03-01';

// EA subscriptions expose PreTaxCost; MCA / pay-as-you-go ones only expose
// Cost. We can't tell which we're pointed at without asking, so we ask for the
// richer metric and fall back on rejection.
const COST_METRICS = ['PreTaxCost', 'Cost'];

// Azure charges no extra for group-by, but every tag key is its own round trip,
// so cap the fan-out the same way the AWS adapter caps activated tag keys.
const MAX_TAG_KEYS = 5;

function credentialFor(creds: ProviderCredentials): ClientSecretCredential {
  return new ClientSecretCredential(creds.tenant_id, creds.client_id, creds.client_secret);
}

function scopeFor(creds: ProviderCredentials): string {
  return `/subscriptions/${creds.subscription_id}`;
}

/** Short, credential-free description of a failure, for customer-facing copy. */
function describe(err: unknown): string {
  if (isRestError(err)) return `${err.statusCode ?? 'no status'} ${err.code ?? err.name}`;
  return (err as Error)?.name ?? 'unknown error';
}

// ---- response decoding ----
//
// The Query API returns `rows` as positional arrays and `columns` as the
// metadata describing them. Column order is *not* contractual — it shifts with
// granularity, scope type and which group-bys were asked for — so every read
// goes through this lookup rather than a hardcoded index.

function columnIndex(columns: QueryColumn[] | undefined, ...candidates: string[]): number {
  const names = (columns ?? []).map((c) => (c.name ?? '').toLowerCase());
  for (const candidate of candidates) {
    const at = names.indexOf(candidate.toLowerCase());
    if (at !== -1) return at;
  }
  return -1;
}

function cellNumber(row: unknown[], at: number): number {
  if (at === -1) return 0;
  const value = Number(row[at]);
  return Number.isFinite(value) ? value : 0;
}

function cellString(row: unknown[], at: number): string {
  if (at === -1) return '';
  const value = row[at];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * The date column is `BillingMonth` (an ISO timestamp) on monthly queries but
 * `UsageDate` (a yyyymmdd integer) on daily ones, and some scopes return the
 * ISO form without a timezone marker — which `new Date` would read as local
 * time and, east of UTC, roll back into the previous month. Force UTC.
 */
function parseRowDate(value: unknown): Date | null {
  if (value instanceof Date) return value;

  if (typeof value === 'number' || (typeof value === 'string' && /^\d{8}$/.test(value))) {
    const digits = String(value);
    if (digits.length !== 8) return null;
    const parsed = new Date(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === 'string' && value) {
    const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
    const parsed = new Date(stamped);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

// ---- queries ----

function costQuery(
  from: Date,
  to: Date,
  metric: string,
  grouping: { type: string; name: string },
  granularity: 'Monthly' | 'Daily' = 'Monthly',
): QueryDefinition {
  return {
    type: 'ActualCost',
    timeframe: 'Custom',
    // Azure's `to` is inclusive, so callers pass the last instant of the final
    // month or day; that's what pulls in the current, still-accruing period.
    timePeriod: { from, to },
    dataset: {
      granularity,
      aggregation: { [metric]: { name: metric, function: 'Sum' } },
      grouping: [grouping],
    },
  };
}

/**
 * How long a throttled Azure query may hold a sync up.
 *
 * Bounded because this runs on both sides of the product: the hourly sweep has
 * fifteen minutes and would not notice, but the Refresh button is an HTTP
 * request, and a wait longer than this turns a rate limit into a hang.
 *
 * Azure sometimes asks for a minute or more. That is a sustained limit rather
 * than a burst, and failing with the message the account page already shows is
 * the honest answer to it.
 */
const MAX_RETRY_WAIT_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/**
 * How long to wait after a throttled query, from Azure's own headers.
 *
 * Read rather than guessed: backing off for an invented interval is how a
 * client turns one rate limit into a queue of them. Azure names the header
 * differently per resource provider, so the usual spellings are all tried.
 *
 * Null means "do not retry" — not a 429, no header, or a wait past the cap.
 */
export function azureRetryAfterMs(err: unknown): number | null {
  if (!isRestError(err) || err.statusCode !== 429) return null;

  const headers = err.response?.headers;
  if (!headers) return null;

  return retryAfterFromHeaders((name) => headers.get(name));
}

/**
 * The header read behind `azureRetryAfterMs`, taking a plain getter.
 *
 * Shared because the throttle reaches us two different ways: as a RestError
 * from the SDK's own queries, and as a 429 `Response` from the hand-rolled
 * pagination below. The list of spellings and the cap have to be the same in
 * both, or one path quietly backs off differently from the other.
 */
function retryAfterFromHeaders(get: (name: string) => string | null | undefined): number | null {
  const names = [
    'retry-after',
    'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after',
    'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after',
    'x-ms-ratelimit-microsoft.consumption-retry-after',
  ];

  for (const name of names) {
    const seconds = Number(get(name));
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = seconds * 1000;
      return ms <= MAX_RETRY_WAIT_MS ? ms : null;
    }
  }
  return null;
}

/** True for the refusal that means "slow down" rather than "that was wrong". */
function isThrottled(err: unknown): boolean {
  return isRestError(err) && err.statusCode === 429;
}

/**
 * Runs a query, retrying once with the alternate cost metric when the first is
 * rejected. Returns the metric that worked so follow-up queries skip the retry.
 *
 * A throttle is handled before that fallback, and deliberately so. Azure
 * refusing for rate reasons says nothing about which cost metric this
 * subscription uses, so trying the other one spends a second request on a
 * limit that has just turned us away — and on Soylent AZ 01 that is what
 * happened every hour for six days, two refusals per sweep and a week with no
 * data. Waiting the second or two Azure asks for turns most of those into a
 * success; a limit that is still refusing after that is sustained, and trying
 * the alternate metric then would only make it worse.
 */
export async function queryWithMetricFallback(
  client: CostManagementClient,
  scope: string,
  build: (metric: string) => QueryDefinition,
): Promise<{ result: QueryResult | undefined; metric: string }> {
  let firstError: unknown;

  for (const metric of COST_METRICS) {
    try {
      return { result: await client.query.usage(scope, build(metric)), metric };
    } catch (err) {
      const wait = azureRetryAfterMs(err);
      if (wait !== null) {
        console.warn(`Azure throttled the cost query; retrying once in ${wait}ms`);
        await sleep(wait);
        try {
          return { result: await client.query.usage(scope, build(metric)), metric };
        } catch (retryErr) {
          if (isThrottled(retryErr)) throw retryErr;
          firstError ??= retryErr;
          continue;
        }
      }
      // Still throttled with nothing to go on: the alternate metric would be
      // another request against the same refusal.
      if (isThrottled(err)) throw err;
      firstError ??= err;
    }
  }

  throw firstError;
}

// ---- pagination ----
//
// The Query API caps a response at 1,000 rows and hands back a `nextLink`
// carrying a $skiptoken for the rest. The SDK models the field but does not
// follow it, and a daily query is exactly where that bites: 90 days of a
// subscription with a dozen services is over 1,000 (day, service) rows, so a
// single page silently loses the oldest ones. Monthly queries never came close
// to the cap, which is why nothing needed this before.

/**
 * How many extra pages to follow before giving up.
 *
 * A bound rather than a plain `while`: a nextLink that ever pointed at itself
 * would otherwise spin until the Lambda timed out. Ten pages is 10,000 rows,
 * far past the ~1,100 a 90-day subscription produces.
 */
const MAX_EXTRA_PAGES = 10;

/**
 * POSTs the original query body to a nextLink and returns that page.
 *
 * Hand-rolled for the same reason as the tags request: the operation exists in
 * the REST contract but has no SDK surface. Unlike that one this is *not*
 * best-effort — see `fetchAllPages`.
 */
async function fetchNextPage(
  credential: ClientSecretCredential,
  url: string,
  body: QueryDefinition,
): Promise<QueryResult> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token) throw new ProviderAuthError('Azure refused a token while paging through daily cost.');

  const send = () => fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
    // Dates serialise to ISO strings, which is the wire format the REST API
    // documents — the same shape the SDK sends for the first page.
    body: JSON.stringify(body),
  });

  let res = await send();

  if (res.status === 429) {
    const wait = retryAfterFromHeaders((name) => res.headers.get(name));
    if (wait === null) {
      throw new Error('Azure throttled a daily cost page and asked us to wait longer than we may.');
    }
    console.warn(`Azure throttled a daily cost page; retrying once in ${wait}ms`);
    await sleep(wait);
    res = await send();
  }

  if (!res.ok) {
    throw new Error(`Azure rejected a daily cost page with ${res.status}.`);
  }

  // The raw response nests what the SDK flattens.
  const body2 = (await res.json()) as { properties?: QueryResult };
  return body2.properties ?? {};
}

/**
 * Every page of a query, starting from one the SDK has already run.
 *
 * A page that cannot be fetched throws rather than returning what arrived so
 * far. Partial pages are not a partial answer here: each row is one service on
 * one day, so a missing page does not mean "fewer days", it means some day's
 * total is quietly too low — and `persistDailySnapshots` would write that
 * understated figure as fact. No daily data is a visible, recoverable state;
 * wrong daily data is the one this whole module exists to avoid.
 */
async function fetchAllPages(
  credential: ClientSecretCredential,
  first: QueryResult | undefined,
  body: QueryDefinition,
): Promise<QueryResult[]> {
  const pages: QueryResult[] = [];
  let page = first;

  for (let i = 0; page && i <= MAX_EXTRA_PAGES; i++) {
    pages.push(page);
    const next = page.nextLink;
    if (!next) return pages;
    page = await fetchNextPage(credential, next, body);
  }

  throw new Error(`Azure daily cost did not finish within ${MAX_EXTRA_PAGES} extra pages.`);
}

// ---- tag breakdown ----
//
// The Cost Management "tags" endpoint has no operation group in
// @azure/arm-costmanagement, so discovery is a plain authenticated GET. Every
// step here is best-effort: an empty tag breakdown is a supported UI state, and
// nothing in this section is allowed to fail a sync.

async function fetchTagKeys(
  credential: ClientSecretCredential,
  scope: string,
): Promise<string[]> {
  try {
    const token = await credential.getToken(ARM_SCOPE);
    if (!token) return [];

    const res = await fetch(
      `${ARM_ENDPOINT}${scope}/providers/Microsoft.CostManagement/tags?api-version=${API_VERSION}`,
      { headers: { Authorization: `Bearer ${token.token}` } },
    );
    if (!res.ok) return [];

    // Older api-versions return properties.tags as bare strings, newer ones as
    // { key, values } objects. Accept both.
    const body = (await res.json()) as { properties?: { tags?: Array<string | { key?: string }> } };
    return (body.properties?.tags ?? [])
      .map((tag) => (typeof tag === 'string' ? tag : tag?.key ?? ''))
      .filter((key) => !!key)
      .slice(0, MAX_TAG_KEYS);
  } catch {
    return [];
  }
}

async function fetchTagBreakdowns(
  client: CostManagementClient,
  scope: string,
  from: Date,
  to: Date,
  metric: string,
  tagKeys: string[],
): Promise<Record<string, Record<string, TagBreakdownItem[]>>> {
  const byMonth: Record<string, Record<string, TagBreakdownItem[]>> = {};

  for (const tagKey of tagKeys) {
    let result: QueryResult | undefined;
    try {
      result = await client.query.usage(
        scope,
        costQuery(from, to, metric, { type: 'TagKey', name: tagKey }),
      );
    } catch {
      // A tag that isn't a cost dimension on this subscription just yields
      // nothing for that key rather than failing the whole sync.
      continue;
    }

    const columns = result?.columns;
    const costAt = columnIndex(columns, metric, ...COST_METRICS);
    const dateAt = columnIndex(columns, 'BillingMonth', 'UsageDate', 'UsageDateTime');
    // Grouping by TagKey normally splits into TagKey/TagValue columns, but some
    // scopes name the value column after the tag itself.
    const valueAt = columnIndex(columns, 'TagValue', tagKey, 'Tag');

    const perMonth = new Map<string, TagBreakdownItem[]>();
    for (const row of result?.rows ?? []) {
      const date = parseRowDate(row[dateAt]);
      if (!date) continue;

      const spend = cellNumber(row, costAt);
      if (spend <= 0) continue;

      const value = cellString(row, valueAt).trim();
      const key = monthKeyOf(monthStart(date));
      const rows = perMonth.get(key) ?? [];
      rows.push({ label: value || 'Untagged', spend, untagged: !value });
      perMonth.set(key, rows);
    }

    for (const [key, rows] of perMonth) {
      byMonth[key] ??= {};
      byMonth[key][tagKey] = rows.sort((a, b) => b.spend - a.spend);
    }
  }

  return byMonth;
}

export const azureAdapter: ProviderAdapter = {
  key: 'azure',
  displayName: 'Microsoft Azure',
  // Exercised against live subscriptions: two production accounts each hold
  // months of Cost Management data with per-service breakdowns.
  verified: true,

  // An app registration is the only way to give a third party unattended
  // read access to Azure billing, so unlike AWS we do have to hold a secret.
  credentialFields: [
    {
      name: 'tenant_id',
      label: 'Directory (tenant) ID',
      type: 'text',
      required: true,
      placeholder: '00000000-0000-0000-0000-000000000000',
      help: 'Azure Active Directory tenant the app registration lives in.',
    },
    {
      name: 'client_id',
      label: 'Application (client) ID',
      type: 'text',
      required: true,
      placeholder: '00000000-0000-0000-0000-000000000000',
      help: 'The app registration (service principal) CloudMeter signs in as.',
    },
    {
      name: 'client_secret',
      label: 'Client secret',
      type: 'secret',
      required: true,
      help: 'Client secret value from the app registration. Stored encrypted and never shown again.',
    },
    {
      name: 'subscription_id',
      label: 'Subscription ID',
      type: 'text',
      required: true,
      placeholder: '00000000-0000-0000-0000-000000000000',
      help: 'Grant the service principal the Cost Management Reader role on this subscription.',
    },
  ],

  async verifyAccess(creds) {
    // Step 1: does the service principal authenticate at all? getToken talks
    // only to Entra ID, so it isolates bad tenant/client/secret from missing
    // subscription permissions.
    const credential = credentialFor(creds);
    try {
      const token = await credential.getToken(ARM_SCOPE);
      if (!token) throw new Error('no token issued');
    } catch (err) {
      throw new ProviderAuthError(
        `Couldn't sign in as the service principal. Check the tenant ID, client ID and client secret, and that the secret hasn't expired. (${describe(err)})`,
      );
    }

    // Step 2: cheapest Cost Management read there is — one page of one
    // dimension. It exercises exactly the role we need without pulling cost.
    const client = new CostManagementClient(credential);
    try {
      await client.dimensions.list(scopeFor(creds), { top: 1 }).next();
    } catch (err) {
      if (isRestError(err) && err.statusCode === 401) {
        throw new ProviderPermissionError(
          `Azure rejected the token for this subscription. Confirm the subscription belongs to the same tenant as the app registration. (${describe(err)})`,
        );
      }
      throw new ProviderPermissionError(
        `The service principal signed in, but Cost Management access was denied. Assign it the Cost Management Reader role on this subscription and confirm the subscription ID. (${describe(err)})`,
      );
    }
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const credential = credentialFor(creds);
    const client = new CostManagementClient(credential);
    const scope = scopeFor(creds);

    const now = new Date();
    const from = monthStart(now, -(months - 1));
    // Last instant of the current month: `to` is inclusive, and reaching past
    // today is what makes Azure return the partial current month.
    const to = new Date(monthStart(now, 1).getTime() - 1);

    const { result, metric } = await queryWithMetricFallback(client, scope, (m) =>
      costQuery(from, to, m, { type: 'Dimension', name: 'ServiceName' }),
    );

    const columns = result?.columns;
    const costAt = columnIndex(columns, metric, ...COST_METRICS);
    const dateAt = columnIndex(columns, 'BillingMonth', 'UsageDate', 'UsageDateTime');
    const serviceAt = columnIndex(columns, 'ServiceName');

    // Seed every requested month so a zero-cost month still produces a
    // snapshot; Azure simply omits months with no rows.
    const buckets = new Map<string, { date: Date; services: Map<string, number> }>();
    for (let offset = months - 1; offset >= 0; offset--) {
      const date = monthStart(now, -offset);
      buckets.set(monthKeyOf(date), { date, services: new Map() });
    }

    for (const row of result?.rows ?? []) {
      const date = parseRowDate(row[dateAt]);
      if (!date) continue;

      const start = monthStart(date);
      const key = monthKeyOf(start);
      const bucket = buckets.get(key);
      // Azure can round the window outward; ignore anything we didn't ask for.
      if (!bucket) continue;

      const name = cellString(row, serviceAt) || 'Unknown';
      bucket.services.set(name, (bucket.services.get(name) ?? 0) + cellNumber(row, costAt));
    }

    const tagKeys = await fetchTagKeys(credential, scope);
    const tagsByMonth = tagKeys.length
      ? await fetchTagBreakdowns(client, scope, from, to, metric, tagKeys)
      : {};

    // Insertion order is oldest first, which is the order buildSnapshots needs
    // to derive month-over-month trend.
    return buildSnapshots([...buckets.entries()].map(([key, bucket]) => ({
      date: bucket.date,
      services: [...bucket.services].map(([name, spend]) => ({ name, spend })),
      tagBreakdown: tagsByMonth[key] ?? {},
    })));
  },

  /**
   * The last `days` days, one row per day with its service split.
   *
   * No tag breakdown: `DailySnapshot` has no field for one, and a per-day
   * per-tag pull is a round trip per tag key for detail nothing reads.
   */
  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const credential = credentialFor(creds);
    const client = new CostManagementClient(credential);
    const scope = scopeFor(creds);

    const now = new Date();
    const from = dayStart(now, -(days - 1));
    // Last instant of today: `to` is inclusive, and reaching to the end of the
    // day is what returns today's partial spend.
    const to = new Date(dayStart(now, 1).getTime() - 1);

    const build = (m: string) =>
      costQuery(from, to, m, { type: 'Dimension', name: 'ServiceName' }, 'Daily');

    const { result, metric } = await queryWithMetricFallback(client, scope, build);
    const pages = await fetchAllPages(credential, result, build(metric));

    /*
     * Keyed by day, and only for days Azure actually answered for.
     *
     * Deliberately not seeded across the whole window the way the monthly path
     * seeds its months. Azure omits a day it has no rows for, and that omission
     * covers both "nothing ran that day" and "not computed yet" — inventing a
     * zero for it is precisely the placeholder that told a customer they had
     * spent nothing on their most expensive day of the month. An absent day
     * stays absent, and `persistDailySnapshots` keeps whatever is stored.
     */
    const buckets = new Map<string, { date: Date; services: Map<string, number> }>();

    for (const page of pages) {
      const columns = page.columns;
      // Daily queries name the date column UsageDate and return it as a
      // yyyymmdd integer; the monthly spellings stay in the list because the
      // column set shifts with scope type, not only with granularity.
      const costAt = columnIndex(columns, metric, ...COST_METRICS);
      const dateAt = columnIndex(columns, 'UsageDate', 'UsageDateTime', 'BillingMonth');
      const serviceAt = columnIndex(columns, 'ServiceName');

      for (const row of page.rows ?? []) {
        const date = parseRowDate(row[dateAt]);
        if (!date) continue;

        const start = dayStart(date);
        const key = dayKeyOf(start);
        const bucket = buckets.get(key) ?? { date: start, services: new Map<string, number>() };

        const name = cellString(row, serviceAt) || 'Unknown';
        bucket.services.set(name, (bucket.services.get(name) ?? 0) + cellNumber(row, costAt));
        buckets.set(key, bucket);
      }
    }

    /*
     * Oldest first, because buildDailySnapshots reads each entry against the
     * one before it to derive per-service trend. Pages arrive in whatever
     * order Azure returns them, so this cannot lean on insertion order the way
     * the seeded monthly path does.
     *
     * Where Azure skipped a day, the days either side of the gap end up
     * adjacent and that trend compares across it. A wrong percentage on one
     * service is a far smaller lie than a fabricated zero-spend day, which is
     * the only other way to close the gap.
     */
    const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));

    return buildDailySnapshots(ordered.map(([, bucket]) => ({
      date: bucket.date,
      services: [...bucket.services].map(([name, spend]) => ({ name, spend })),
    })));
  },
};
