import { BigQuery } from '@google-cloud/bigquery';
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
  dayStart,
  dayKeyOf,
} from './types';
import { ratesInfo, convertToUsd } from '../fx';

// GCP has no cost API. Billing data lands in a BigQuery table the customer
// configures ("Cloud Billing export to BigQuery"), and we read it from there,
// so every call here is a query against a customer-owned dataset.

/** How many label keys we surface as tag dimensions, most expensive first. */
const MAX_LABEL_KEYS = 10;

// ---- identifier safety -------------------------------------------------
//
// The project/dataset/table come from the customer, and BigQuery has no
// parameter form for table references — the path has to be interpolated into
// the SQL text. So every identifier is validated against a strict allowlist
// first and rejected outright otherwise; nothing that could close a backtick
// or start a comment can survive these patterns.

// Dataset and table IDs are letters, digits and underscores; dashes show up in
// some legacy/partitioned table names, so they're tolerated too.
const BQ_NAME = /^[A-Za-z0-9_-]+$/;
// Project IDs are lowercase alphanumerics and dashes. Domain-scoped legacy
// projects add exactly one `domain.tld:` prefix — the only place `.` and `:`
// are legitimate.
const GCP_PROJECT_ID = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:)?[A-Za-z0-9-]+$/;

function requireIdentifier(value: string | undefined, pattern: RegExp, field: string): string {
  const v = (value ?? '').trim();
  if (!v || !pattern.test(v)) {
    throw new ProviderPermissionError(
      `"${field}" isn't a valid BigQuery identifier. Copy it exactly as it appears in the billing export settings.`,
    );
  }
  return v;
}

/** Fully-qualified, backtick-quoted table reference built only from validated parts. */
function tableRef(creds: ProviderCredentials): string {
  const project = requireIdentifier(creds.project_id, GCP_PROJECT_ID, 'project_id');
  const dataset = requireIdentifier(creds.dataset_name, BQ_NAME, 'dataset_name');
  const table = requireIdentifier(creds.table_name, BQ_NAME, 'table_name');
  return `\`${project}.${dataset}.${table}\``;
}

// ---- client ------------------------------------------------------------

function bqClientFor(creds: ProviderCredentials): BigQuery {
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(creds.gcp_service_account_json ?? '');
  } catch {
    // Deliberately not echoing the parser message: it can quote the source
    // text, which here is the private key.
    throw new ProviderAuthError(
      'The service account key could not be parsed. Paste the full JSON key file, exactly as downloaded from GCP.',
    );
  }

  if (!credentials || typeof credentials !== 'object'
    || typeof credentials.client_email !== 'string'
    || typeof credentials.private_key !== 'string') {
    throw new ProviderAuthError(
      'The service account key is missing "client_email" or "private_key". Use a service account key file, not an OAuth client or an API key.',
    );
  }

  return new BigQuery({
    projectId: requireIdentifier(creds.project_id, GCP_PROJECT_ID, 'project_id'),
    credentials: credentials as { client_email: string; private_key: string },
    location: creds.bq_location?.trim() || undefined,
  });
}

// ---- error classification ---------------------------------------------

/** Short, safe error text: never any part of the key material. */
function describe(err: unknown): string {
  const e = err as { name?: string; code?: unknown; message?: string };
  const msg = (e?.message ?? '')
    // Belt and braces — Google's errors don't quote the key, but if anything
    // ever does, it stops here.
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[redacted]')
    .replace(/"private_key"\s*:\s*"[^"]*"/g, '"private_key":"[redacted]"')
    .split('\n')[0]
    .slice(0, 200);
  return msg || e?.name || 'unknown error';
}

/**
 * True when the failure is about *who* we are rather than *what we may read*:
 * a bad key, a disabled/deleted service account, a clock-skewed JWT. Anything
 * else that comes back from a table-scoped query is treated as a permission or
 * wrong-table problem, which is the fix the customer needs to hear about.
 */
function isAuthFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  if (e?.code === 401) return true;
  const msg = (e?.message ?? '').toLowerCase();
  return [
    'invalid_grant',
    'invalid_client',
    'unauthorized_client',
    'invalid jwt',
    'invalid_request',
    'unauthenticated',
    'could not load the default credentials',
    'error:1e08010c', // OpenSSL DECODER — malformed private_key PEM
    'pem routines',
    'account not found',
    'has been deleted',
    'is disabled',
  ].some((needle) => msg.includes(needle));
}

// ---- SQL ---------------------------------------------------------------
//
// Net cost is list cost plus credits (credits.amount is negative), which is the
// convention the billing export docs use and what customers see on an invoice.
const NET_COST = 'cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)';

// Months are bucketed by usage_start_time in UTC. `usage_start_time` is also
// the column the export table is clustered/partitioned on, so the BETWEEN also
// keeps the scanned bytes down.
function costByServiceSql(table: string): string {
  return `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m', usage_start_time, 'UTC') AS month_key,
      IFNULL(service.description, 'Unknown') AS service_name,
      currency,
      SUM(${NET_COST}) AS net_cost
    FROM ${table}
    WHERE usage_start_time >= @start_time
      AND usage_start_time < @end_time
    GROUP BY month_key, service_name, currency
  `;
}

// Same shape as costByServiceSql, bucketed by day. The dashboard's "Cost trend
// by provider" is a daily chart, so a provider that only reports months is
// simply absent from it — which is how GCP spend was invisible there despite
// six months of monthly data sitting in the table.
function costByServiceDailySql(table: string): string {
  return `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, 'UTC') AS day_key,
      IFNULL(service.description, 'Unknown') AS service_name,
      currency,
      SUM(${NET_COST}) AS net_cost
    FROM ${table}
    WHERE usage_start_time >= @start_time
      AND usage_start_time < @end_time
    GROUP BY day_key, service_name, currency
  `;
}

function costByLabelSql(table: string): string {
  return `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m', usage_start_time, 'UTC') AS month_key,
      label.key AS label_key,
      label.value AS label_value,
      currency,
      SUM(${NET_COST}) AS net_cost
    FROM ${table}, UNNEST(labels) AS label
    WHERE usage_start_time >= @start_time
      AND usage_start_time < @end_time
    GROUP BY month_key, label_key, label_value, currency
  `;
}

// ---- helpers -----------------------------------------------------------

/**
 * BigQuery hands back NUMERIC/BIGNUMERIC as strings or as {value} wrappers
 * depending on the column type and client options, so nothing is trusted to
 * already be a number.
 */
function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return toNumber((raw as { value: unknown }).value);
  }
  return 0;
}

/**
 * A row's net cost, in USD.
 *
 * The billing export is denominated in the billing account's own currency —
 * its `currency` column — not in dollars. Reading `cost` as though it were USD
 * and letting the portal convert at display time multiplied an INR account by
 * the USD→INR rate: Mobil80's GCP project reported ₹83.62 for August 2026 and
 * the dashboard showed ₹7,932.
 *
 * Converting here keeps the stored ledger in USD like every other provider, so
 * display currency stays a rendering choice rather than something each adapter
 * has to know about.
 */
function netCostUsd(row: Record<string, unknown>, perUsd: Record<string, number>): number {
  return convertToUsd(toNumber(row.net_cost), str(row.currency) || 'USD', perUsd);
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
}

/**
 * Per-month label breakdowns. Each label key becomes one tag dimension, with
 * an "Untagged" row derived from the month total — that's spend on resources
 * carrying no value for that key.
 */
function labelBreakdowns(
  rows: Array<Record<string, unknown>>,
  monthTotals: Map<string, number>,
  perUsd: Record<string, number>,
): Record<string, Record<string, TagBreakdownItem[]>> {
  // key -> total spend, to pick the dimensions worth showing.
  const keyTotals = new Map<string, number>();
  for (const row of rows) {
    const key = str(row.label_key);
    if (!key) continue;
    keyTotals.set(key, (keyTotals.get(key) ?? 0) + netCostUsd(row, perUsd));
  }

  const topKeys = new Set(
    [...keyTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LABEL_KEYS)
      .map(([key]) => key),
  );

  const result: Record<string, Record<string, TagBreakdownItem[]>> = {};
  // month -> key -> spend covered by that key, for the untagged remainder.
  const covered = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const key = str(row.label_key);
    const month = str(row.month_key);
    if (!key || !month || !topKeys.has(key)) continue;

    const spend = netCostUsd(row, perUsd);
    const value = str(row.label_value);

    result[month] ??= {};
    result[month][key] ??= [];
    if (spend > 0) {
      result[month][key].push({ label: value || 'Untagged', spend, untagged: !value });
    }

    const perKey = covered.get(month) ?? new Map<string, number>();
    perKey.set(key, (perKey.get(key) ?? 0) + spend);
    covered.set(month, perKey);
  }

  for (const [month, dims] of Object.entries(result)) {
    for (const [key, items] of Object.entries(dims)) {
      const remainder = (monthTotals.get(month) ?? 0) - (covered.get(month)?.get(key) ?? 0);
      // Rounding noise across float sums shows up as a few cents; ignore it.
      if (remainder > 0.01) {
        items.push({ label: 'Untagged', spend: remainder, untagged: true });
      }
      items.sort((a, b) => b.spend - a.spend);
    }
    // Drop dimensions that ended up with nothing to show.
    for (const [key, items] of Object.entries(dims)) {
      if (items.length === 0) delete dims[key];
    }
  }

  return result;
}

export const gcpAdapter: ProviderAdapter = {
  key: 'gcp',
  displayName: 'Google Cloud Platform',
  // Validated 2026-08-25 against a real Cloud Billing export to BigQuery
  // table (found and fixed a real bug in the process: a raw string param
  // paired with an explicit TIMESTAMP `types` override was silently matching
  // zero rows — see fetchMonthlySnapshots below).
  verified: true,

  credentialFields: [
    { name: 'project_id', label: 'Project ID', type: 'text', required: true, placeholder: 'my-billing-project', help: 'The GCP project that owns the billing export dataset.' },
    { name: 'dataset_name', label: 'BigQuery Dataset', type: 'text', required: true, placeholder: 'billing_export', help: 'Dataset holding the Cloud Billing export.' },
    { name: 'table_name', label: 'Billing Export Table', type: 'text', required: true, placeholder: 'gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX' },
    { name: 'bq_location', label: 'Dataset Region', type: 'text', required: true, placeholder: 'asia-south1', help: 'The region the dataset lives in — queries fail if this is wrong.' },
    { name: 'account_email_id', label: 'Billing Account Email', type: 'text', required: true, placeholder: 'billing-owner@example.com' },
    {
      name: 'gcp_service_account_json',
      label: 'Service Account Key (JSON)',
      type: 'textarea',
      required: true,
      help: 'Full JSON key for a service account with BigQuery Data Viewer and BigQuery Job User on the billing dataset. Stored encrypted and never shown again.',
    },
  ],

  async verifyAccess(creds) {
    // Anything wrong with the key itself surfaces as ProviderAuthError from here.
    const bq = bqClientFor(creds);
    const table = tableRef(creds);

    try {
      // A dry run costs nothing and still exercises the whole path: it needs
      // valid credentials, jobs.create (Job User) and table metadata access
      // (Data Viewer), and it fails if the dataset/table doesn't exist.
      await bq.createQueryJob({
        query: `SELECT ${NET_COST} AS net_cost FROM ${table} LIMIT 1`,
        dryRun: true,
        location: creds.bq_location?.trim() || undefined,
      });
    } catch (err) {
      if (isAuthFailure(err)) {
        throw new ProviderAuthError(
          `The service account couldn't authenticate. Check that the key is current and the service account still exists. (${describe(err)})`,
        );
      }
      throw new ProviderPermissionError(
        `Authenticated, but the billing export table couldn't be read. Check the dataset/table names and region, and that the service account has BigQuery Data Viewer and Job User on that dataset. (${describe(err)})`,
      );
    }
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const bq = bqClientFor(creds);
    const table = tableRef(creds);
    const location = creds.bq_location?.trim() || undefined;

    const now = new Date();
    const start = monthStart(now, -(months - 1));
    // Exclusive upper bound on the first of next month, so the current
    // (partial) month is included; buildSnapshots flags it.
    const end = monthStart(now, 1);

    // BigQuery.timestamp(), not a raw ISO string plus an explicit `types` map:
    // pairing a plain string param with `types: { ...: 'TIMESTAMP' }` silently
    // matches zero rows instead of erroring — verified against a real billing
    // export, where every account synced clean but every month came back
    // empty. A bare Date/ISO string with no `types` override also works (the
    // client infers it correctly), but the explicit helper doesn't depend on
    // that inference holding across client versions.
    const params = { start_time: BigQuery.timestamp(start), end_time: BigQuery.timestamp(end) };

    // Rates come from the shared cache (one live fetch a day), so this adds a
    // DynamoDB read rather than a network call per sync.
    const [[serviceRows], fx] = await Promise.all([
      bq.query({ query: costByServiceSql(table), params, location }),
      ratesInfo(),
    ]);

    // month -> service -> spend
    const byMonth = new Map<string, Map<string, number>>();
    for (const row of serviceRows as Array<Record<string, unknown>>) {
      const month = str(row.month_key);
      if (!month) continue;
      const services = byMonth.get(month) ?? new Map<string, number>();
      const name = str(row.service_name) || 'Unknown';
      services.set(name, (services.get(name) ?? 0) + netCostUsd(row, fx.perUsd));
      byMonth.set(month, services);
    }

    const monthTotals = new Map<string, number>();
    for (const [month, services] of byMonth) {
      monthTotals.set(month, [...services.values()].reduce((sum, v) => sum + v, 0));
    }

    let tagsByMonth: Record<string, Record<string, TagBreakdownItem[]>> = {};
    try {
      const [labelRows] = await bq.query({
        query: costByLabelSql(table),
        params,
        location,
      });
      tagsByMonth = labelBreakdowns(labelRows as Array<Record<string, unknown>>, monthTotals, fx.perUsd);
    } catch {
      // Labels are optional garnish — an export without a `labels` column, or a
      // query that blows a byte limit, must not sink the whole sync.
      tagsByMonth = {};
    }

    // Emit every month in the window, including ones the export has no rows
    // for, so the trend line has no holes.
    const monthly: Array<{
      date: Date;
      services: Array<{ name: string; spend: number }>;
      tagBreakdown: Record<string, TagBreakdownItem[]>;
    }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const date = monthStart(now, -i);
      const key = monthKeyOf(date);
      monthly.push({
        date,
        services: [...(byMonth.get(key) ?? new Map<string, number>())].map(([name, spend]) => ({ name, spend })),
        tagBreakdown: tagsByMonth[key] ?? {},
      });
    }

    return buildSnapshots(monthly);
  },

  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const bq = bqClientFor(creds);
    const table = tableRef(creds);
    const location = creds.bq_location?.trim() || undefined;

    const now = new Date();
    const start = dayStart(now, -(days - 1));
    // Exclusive upper bound on tomorrow, so today's partial spend is included.
    const end = dayStart(now, 1);

    const [[rows], fx] = await Promise.all([
      bq.query({
        query: costByServiceDailySql(table),
        // BigQuery.timestamp() for the same reason as the monthly query: a raw
        // string paired with an explicit TIMESTAMP type override matches zero
        // rows instead of erroring.
        params: { start_time: BigQuery.timestamp(start), end_time: BigQuery.timestamp(end) },
        location,
      }),
      ratesInfo(),
    ]);

    // day -> service -> spend
    const byDay = new Map<string, Map<string, number>>();
    for (const row of rows as Array<Record<string, unknown>>) {
      const day = str(row.day_key);
      if (!day) continue;
      const services = byDay.get(day) ?? new Map<string, number>();
      const name = str(row.service_name) || 'Unknown';
      services.set(name, (services.get(name) ?? 0) + netCostUsd(row, fx.perUsd));
      byDay.set(day, services);
    }

    // Every day in the window, so a day with no spend is a zero rather than a
    // gap that shifts the rest of the series along.
    const daily: Array<{ date: Date; services: Array<{ name: string; spend: number }> }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayStart(now, -i);
      daily.push({
        date,
        services: [...(byDay.get(dayKeyOf(date)) ?? new Map<string, number>())]
          .map(([name, spend]) => ({ name, spend })),
      });
    }

    return buildDailySnapshots(daily);
  },
};
