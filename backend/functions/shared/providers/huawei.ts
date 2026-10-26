import { createHash, createHmac } from 'node:crypto';
import {
  ProviderAdapter,
  ProviderCredentials,
  ProviderAuthError,
  ProviderPermissionError,
  MonthlySnapshot,
  DailySnapshot,
  buildSnapshots,
  buildDailySnapshots,
  monthKeyOf,
  monthStart,
  dayStart,
  dayKeyOf,
  isoDate,
} from './types';

// Huawei Cloud ships no usable Node SDK in this project, so this adapter talks
// to the BSS REST API directly and signs the requests itself. Everything below
// the adapter object is that plumbing.

// BSS (Business Support System) carries no region in its hostname and — unlike
// AWS SigV4 — no region/service scope in the signature either. It is not one
// global endpoint though: Huawei runs two separate sites, and an account exists
// on exactly one of them. Querying the wrong one fails with CBC.0156 no matter
// how correct the credentials are, which reads as a permissions problem and
// isn't one.
const BSS_HOSTS = {
  /** Everything outside mainland China (resolves into ap-southeast-3). */
  intl: 'bss-intl.myhuaweicloud.com',
  /** Mainland China (resolves into cn-north-4). */
  cn: 'bss.myhuaweicloud.com',
} as const;

/** "Access denied. The customer does not belong to the website you are now at." */
const WRONG_SITE_CODE = 'CBC.0156';

/** Lets the site probe tell "wrong site" apart from a real auth/permission failure. */
interface BssCoded {
  bssCode?: string;
}

// Cost queries are read-only and small; a hung socket must never hold a Lambda
// invocation open until its own timeout.
const REQUEST_TIMEOUT_MS = 15_000;

// The monthly expenditure summary already aggregates a whole billing cycle,
// which is exactly the granularity a snapshot needs, so one page normally
// covers a month. Pagination is bounded purely as a safety net for accounts
// with many service types x regions x charging modes.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

// ---- SDK-HMAC-SHA256 request signing ----
//
// Huawei's API gateway uses an AWS-SigV4-*style* scheme, but a simpler one:
// there is no date-scoped derived signing key. The SK signs the string-to-sign
// directly, and the only scoping is the X-Sdk-Date timestamp (requests are
// rejected outside a ~15 minute skew window).
//
//   1. canonical request = METHOD \n uri \n query \n headers \n signed \n hash(body)
//   2. string to sign    = "SDK-HMAC-SHA256" \n X-Sdk-Date \n hash(canonical request)
//   3. signature         = hex(hmac_sha256(SK, string_to_sign))
//
// These pieces are exported so the signing can be exercised deterministically
// against fixed inputs without reaching the network.

/** RFC 3986 escaping — encodeURIComponent leaves !'()* alone, Huawei does not. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hexSha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** X-Sdk-Date format: YYYYMMDDTHHMMSSZ (ISO 8601 basic, always UTC). */
export function sdkDateOf(when: Date): string {
  return when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Canonical URI: every path segment percent-encoded, and — a Huawei quirk that
 * silently breaks signatures otherwise — always terminated with a slash.
 */
export function canonicalUriOf(path: string): string {
  const encoded = path.split('/').map(uriEncode).join('/');
  return encoded.endsWith('/') ? encoded : `${encoded}/`;
}

/** Canonical query: encoded, sorted by key, `k=v` joined with `&`. */
export function canonicalQueryOf(query: Record<string, string | number>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`)
    .join('&');
}

export function buildCanonicalRequest(
  method: string,
  path: string,
  query: Record<string, string | number>,
  headers: Record<string, string>,
  body: string,
): { canonicalRequest: string; signedHeaders: string } {
  // Header names are lowercased and sorted; values are trimmed and their
  // internal whitespace runs collapsed.
  const normalized = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = normalized.map(([n, v]) => `${n}:${v}\n`).join('');
  const signedHeaders = normalized.map(([n]) => n).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUriOf(path),
    canonicalQueryOf(query),
    canonicalHeaders,
    signedHeaders,
    hexSha256(body),
  ].join('\n');

  return { canonicalRequest, signedHeaders };
}

export function buildStringToSign(xSdkDate: string, canonicalRequest: string): string {
  return ['SDK-HMAC-SHA256', xSdkDate, hexSha256(canonicalRequest)].join('\n');
}

export function calculateSignature(secretKey: string, stringToSign: string): string {
  return createHmac('sha256', secretKey).update(stringToSign, 'utf8').digest('hex');
}

/**
 * Returns the request headers including `Authorization`. The caller must send
 * exactly these headers: adding or dropping one after signing invalidates the
 * signature, since the set is pinned by SignedHeaders.
 */
export function signRequest(params: {
  accessKey: string;
  secretKey: string;
  method: string;
  host: string;
  path: string;
  query: Record<string, string | number>;
  headers?: Record<string, string>;
  body?: string;
  now?: Date;
}): Record<string, string> {
  const body = params.body ?? '';
  const xSdkDate = sdkDateOf(params.now ?? new Date());

  const headers: Record<string, string> = {
    ...(params.headers ?? {}),
    host: params.host,
    'X-Sdk-Date': xSdkDate,
  };

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
    params.method,
    params.path,
    params.query,
    headers,
    body,
  );
  const signature = calculateSignature(params.secretKey, buildStringToSign(xSdkDate, canonicalRequest));

  return {
    ...headers,
    Authorization:
      `SDK-HMAC-SHA256 Access=${params.accessKey}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---- BSS API access ----

/**
 * Chosen endpoint: `GET /v2/bills/customer-bills/monthly-sum` — "Query Monthly
 * Expenditure Summary" (BSS `ShowCustomerMonthlySum`).
 *
 * Why this one for months: it is already aggregated per billing cycle and its
 * `bill_sums` rows carry `service_type_name`, which is precisely the
 * per-service breakdown a monthly snapshot needs, in one request per month.
 *
 * It has no daily resolution at all, which is why the daily series comes from
 * the resource endpoint below instead.
 */
const MONTHLY_SUM_PATH = '/v2/bills/customer-bills/monthly-sum';

interface BillSumRow {
  service_type_name?: string;
  service_type_code?: string;
  consume_amount?: number | string;
  official_amount?: number | string;
}

interface MonthlySumResponse {
  bill_sums?: BillSumRow[];
  total_count?: number;
  error_code?: string;
  error_msg?: string;
}

/** Huawei returns amounts as numbers *or* numeric strings depending on field. */
function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Maps a failed BSS response onto the two failure modes the customer can act
 * on. 401 and signature/AK-SK complaints mean the credentials are wrong; 403
 * and "not authorized"/"access denied" mean they are valid but lack the BSS
 * billing-read permission. Anything else stays a plain Error so a transient
 * outage isn't reported to the customer as a credential problem.
 */
function classifyFailure(status: number, code: string, message: string): Error {
  const detail = `HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
  const haystack = `${code} ${message}`.toLowerCase();

  // Carried on every error so the site probe can retry on CBC.0156 alone and
  // let a genuine credential or permission failure through untouched.
  const tag = (err: Error): Error => {
    (err as Error & BssCoded).bssCode = code;
    return err;
  };

  // Checked before the 403 branch below: CBC.0156 arrives as a 403 and would
  // otherwise be reported as a missing billing policy, sending the customer
  // off to fix permissions that were never the problem.
  if (code === WRONG_SITE_CODE) {
    return tag(new ProviderPermissionError(
      `This Huawei Cloud account isn't registered on either Huawei site CloudMeter can reach. ` +
        `Accounts live on either the International site (${BSS_HOSTS.intl}) or the Chinese site ` +
        `(${BSS_HOSTS.cn}), and both rejected these credentials as belonging elsewhere. ` +
        `Check the access key was created in the same account you mean to monitor. (${detail})`,
    ));
  }

  const looksLikeBadCredentials =
    status === 401 ||
    // APIGW.0301 covers "incorrect IAM authentication information", which is
    // what a bad AK or a mismatched signature surfaces as.
    code === 'APIGW.0301' ||
    haystack.includes('signature') ||
    haystack.includes('aksk') ||
    haystack.includes('access key') ||
    haystack.includes('authentication');

  const looksLikeMissingPermission =
    status === 403 ||
    // APIGW.0302 is "the user is not authorized to access the API";
    // CBC.0150 is BSS's own access-denied code.
    code === 'APIGW.0302' ||
    code === 'CBC.0150' ||
    haystack.includes('not authorized') ||
    haystack.includes('access denied') ||
    haystack.includes('permission');

  // Permission wins the tie: a 403 whose message merely mentions the word
  // "authentication" is still a policy problem, not a bad key.
  if (looksLikeMissingPermission) {
    return tag(new ProviderPermissionError(
      `Huawei Cloud rejected the billing query as unauthorized. Grant the account's ` +
        `IAM user the BSS Administrator (or an equivalent billing read-only) policy. (${detail})`,
    ));
  }
  if (looksLikeBadCredentials) {
    return tag(new ProviderAuthError(
      `Huawei Cloud rejected the credentials. Check the access key (AK), secret key (SK) ` +
        `and domain ID, and that the server clock is accurate. (${detail})`,
    ));
  }
  return tag(new Error(`Huawei Cloud BSS request failed (${detail})`));
}

/**
 * Signs and performs one BSS GET. Never logs or returns the Authorization
 * header or any credential value.
 */
interface BssErrorShape {
  error_code?: string;
  error_msg?: string;
}

async function bssGet<T extends BssErrorShape>(
  creds: ProviderCredentials,
  host: string,
  path: string,
  query: Record<string, string | number>,
): Promise<T> {
  const headers = signRequest({
    accessKey: creds.access_key,
    secretKey: creds.secret_key,
    method: 'GET',
    host,
    path,
    query,
    // BSS resolves the billing account from the signing key, but IAM-user keys
    // under a domain need the domain stated explicitly. Signed like any other
    // header, so both have to be present before the signature is computed.
    //
    // X-Language: without it BSS returns service names in Chinese even on the
    // international site — "云防火墙" rather than "Cloud Firewall" — and those
    // names are what the dashboard's service breakdown displays. "en_us" is
    // the accepted spelling; a bare "en" is rejected with CBC.0100.
    headers: { 'X-Domain-Id': creds.domain_id, 'X-Language': 'en_us' },
  });

  const url = `https://${host}${path}?${canonicalQueryOf(query)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Couldn't reach the Huawei Cloud BSS API (${(err as Error).name})`);
  }

  const text = await res.text();
  let body: T = {} as T;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    // Gateway errors ahead of BSS can come back as HTML; keep the status.
  }

  if (!res.ok) {
    throw classifyFailure(res.status, body.error_code ?? '', body.error_msg ?? '');
  }
  // A 200 carrying an error_code happens on some BSS paths; treat it the same.
  if (body.error_code) {
    throw classifyFailure(res.status, body.error_code, body.error_msg ?? '');
  }

  return body;
}

/**
 * Which Huawei site this account lives on.
 *
 * Resolved once at connect time and stored alongside the credentials, so
 * every later refresh goes straight to the right site instead of paying for
 * the probe again. International is tried first: it serves every region
 * outside mainland China.
 */
async function resolveBssHost(creds: ProviderCredentials): Promise<string> {
  const configured = creds.bss_host?.trim();
  if (configured) return configured;

  const probe = { bill_cycle: monthKeyOf(new Date()), limit: 1, offset: 0 };
  let wrongSite: Error | null = null;

  for (const host of [BSS_HOSTS.intl, BSS_HOSTS.cn]) {
    try {
      await bssGet<MonthlySumResponse>(creds, host, MONTHLY_SUM_PATH, probe);
      return host;
    } catch (err) {
      // Only "you're on the wrong site" is worth trying the other one for. A
      // bad key or a missing billing policy fails identically on both, so
      // surfacing it straight away beats a second pointless round trip.
      if ((err as Error & BssCoded).bssCode !== WRONG_SITE_CODE) throw err;
      wrongSite = err as Error;
    }
  }

  throw wrongSite ?? new Error('Huawei Cloud rejected this account on both of its sites');
}

/** All `bill_sums` rows for one `YYYY-MM` cycle, following pagination. */
async function fetchCycleRows(
  creds: ProviderCredentials,
  host: string,
  billCycle: string,
): Promise<BillSumRow[]> {
  const rows: BillSumRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await bssGet<MonthlySumResponse>(creds, host, MONTHLY_SUM_PATH, {
      bill_cycle: billCycle,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });

    const batch = body.bill_sums ?? [];
    rows.push(...batch);

    const total = toNumber(body.total_count);
    if (batch.length < PAGE_SIZE || rows.length >= total) break;
  }

  return rows;
}

/**
 * Folds the cycle's rows into per-service totals. BSS splits a service across
 * regions and charging modes, so the same service name appears several times.
 */
function servicesFromRows(rows: BillSumRow[]): Array<{ name: string; spend: number }> {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const name = row.service_type_name || row.service_type_code || 'Unknown';
    // `consume_amount` is the actual expenditure for the cycle; `official_amount`
    // is list price before discounts, and is only a fallback.
    const spend = toNumber(row.consume_amount ?? row.official_amount);
    totals.set(name, (totals.get(name) ?? 0) + spend);
  }

  return [...totals].map(([name, spend]) => ({ name, spend }));
}

/**
 * Daily figures come from `res-fee-records` ("Viewing Resource Expenditures"),
 * because `monthly-sum` has no day dimension — which is why Huawei spend was
 * absent from the dashboard's daily trend even with months of data stored.
 *
 * `statistic_type=2` is what makes this affordable: it asks BSS to aggregate
 * by day rather than return the default per-resource detail rows, so a month
 * comes back as tens of records instead of thousands.
 */
const RES_FEE_PATH = '/v2/bills/customer-bills/res-fee-records';

/** The endpoint's documented ceiling (default is 10, which would page forever). */
const RES_FEE_PAGE_SIZE = 1000;

interface FeeRecord {
  bill_date?: string;
  cloud_service_type_name?: string;
  cloud_service_type?: string;
  amount?: number | string;
  official_amount?: number | string;
}

interface ResFeeResponse {
  fee_records?: FeeRecord[];
  total_count?: number;
  error_code?: string;
  error_msg?: string;
}

/**
 * The window split into per-cycle chunks.
 *
 * `cycle` is required and `bill_date_begin`/`bill_date_end` must fall inside
 * the month it names, so a 30-day window spanning a month boundary is two
 * requests, not one.
 */
function cycleRanges(start: Date, end: Date): Array<{ cycle: string; begin: string; end: string }> {
  const ranges: Array<{ cycle: string; begin: string; end: string }> = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  while (cursor.getTime() <= lastMonth.getTime()) {
    const firstOfMonth = cursor;
    // Day 0 of the next month is the last day of this one.
    const lastOfMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    ranges.push({
      cycle: monthKeyOf(cursor),
      begin: isoDate(start.getTime() > firstOfMonth.getTime() ? start : firstOfMonth),
      end: isoDate(end.getTime() < lastOfMonth.getTime() ? end : lastOfMonth),
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return ranges;
}

/** Every day-aggregated fee record for one cycle window, following pagination. */
async function fetchFeeRecords(
  creds: ProviderCredentials,
  host: string,
  range: { cycle: string; begin: string; end: string },
): Promise<FeeRecord[]> {
  const records: FeeRecord[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await bssGet<ResFeeResponse>(creds, host, RES_FEE_PATH, {
      cycle: range.cycle,
      bill_date_begin: range.begin,
      bill_date_end: range.end,
      statistic_type: 2,
      limit: RES_FEE_PAGE_SIZE,
      offset: page * RES_FEE_PAGE_SIZE,
    });

    const batch = body.fee_records ?? [];
    records.push(...batch);

    const total = toNumber(body.total_count);
    if (batch.length < RES_FEE_PAGE_SIZE || records.length >= total) break;
  }

  return records;
}

export const huaweiAdapter: ProviderAdapter = {
  key: 'huawei',
  displayName: 'Huawei Cloud',
  // Hand-rolled SDK-HMAC-SHA256 signing, never exercised against a real Huawei
  // Cloud account. Structurally complete, not known to work.
  verified: false,

  credentialFields: [
    {
      name: 'access_key',
      label: 'Access Key (AK)',
      type: 'text',
      required: true,
      help: 'Permanent AK of an IAM user with billing read access.',
    },
    {
      name: 'secret_key',
      label: 'Secret Access Key (SK)',
      type: 'secret',
      required: true,
      help: 'Shown only once when the access key is created.',
    },
    {
      name: 'domain_id',
      label: 'Account (Domain) ID',
      type: 'text',
      required: true,
      help: 'My Credentials > API Credentials > Account ID.',
    },
    {
      name: 'project_id',
      label: 'Project ID',
      type: 'text',
      required: true,
      help: 'Project ID of the region to monitor.',
    },
    {
      name: 'account_email_id',
      label: 'Account Owner Email',
      type: 'text',
      required: true,
      help: 'Email of the Huawei Cloud account owner, used for billing contact.',
    },
  ],

  async verifyAccess(creds) {
    // Resolving the site *is* the verification: the probe is signed (so a bad
    // AK/SK fails it) and it reads billing data (so a missing BSS policy fails
    // it too). One row is enough — we're not using the numbers here.
    //
    // The answer is written back onto creds deliberately: the connect flow
    // stores them straight after this returns, so the resolved site is
    // persisted and no later refresh has to probe again.
    creds.bss_host = await resolveBssHost(creds);
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    // Stored at connect time. Falling back to a probe rather than assuming a
    // site keeps accounts connected before this field existed working.
    const host = creds.bss_host?.trim() || (await resolveBssHost(creds));
    const now = new Date();
    // Oldest first; the last entry is the current, still-accruing month, which
    // buildSnapshots flags via isCurrent.
    const cycles = Array.from({ length: months }, (_, i) => monthStart(now, -(months - 1 - i)));

    const monthly: Array<{ date: Date; services: Array<{ name: string; spend: number }> }> = [];
    let lastSoftFailure: Error | null = null;

    // Sequential on purpose: BSS throttles aggressively per account, and a
    // handful of months is not worth risking APIGW.0308 for.
    for (const date of cycles) {
      const billCycle = monthKeyOf(date);
      try {
        monthly.push({ date, services: servicesFromRows(await fetchCycleRows(creds, host, billCycle)) });
      } catch (err) {
        // A credential or permission problem affects every month equally, so
        // surface it immediately rather than returning a silently empty chart.
        if (err instanceof ProviderAuthError || err instanceof ProviderPermissionError) throw err;
        // Anything else (a cycle with no bill yet, a transient 5xx) costs us
        // one month, not the whole sync.
        lastSoftFailure = err as Error;
        console.warn(`huawei: skipping bill cycle ${billCycle}: ${(err as Error).message}`);
      }
    }

    if (monthly.length === 0) {
      throw lastSoftFailure ?? new Error('Huawei Cloud returned no billing cycles');
    }

    // Huawei exposes no cost-by-tag dimension on this endpoint, so tagBreakdown
    // stays empty — the UI renders the service breakdown alone.
    return buildSnapshots(monthly);
  },

  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const host = creds.bss_host?.trim() || (await resolveBssHost(creds));
    const now = new Date();
    const start = dayStart(now, -(days - 1));
    const today = dayStart(now, 0);

    // day -> service -> spend
    const byDay = new Map<string, Map<string, number>>();
    let lastSoftFailure: Error | null = null;

    // Sequential, like the monthly pull: BSS throttles aggressively per
    // account and a couple of cycles is not worth risking APIGW.0308 for.
    for (const range of cycleRanges(start, today)) {
      try {
        for (const record of await fetchFeeRecords(creds, host, range)) {
          const day = (record.bill_date ?? '').trim();
          if (!day) continue;
          const name = record.cloud_service_type_name || record.cloud_service_type || 'Unknown';
          // `amount` is what was actually payable; `official_amount` is list
          // price before discounts and is only a fallback.
          const spend = toNumber(record.amount ?? record.official_amount);
          const services = byDay.get(day) ?? new Map<string, number>();
          services.set(name, (services.get(name) ?? 0) + spend);
          byDay.set(day, services);
        }
      } catch (err) {
        // A credential or permission problem affects every cycle equally, so
        // surface it rather than returning a silently short series.
        if (err instanceof ProviderAuthError || err instanceof ProviderPermissionError) throw err;
        lastSoftFailure = err as Error;
        console.warn(`huawei: skipping daily cycle ${range.cycle}: ${(err as Error).message}`);
      }
    }

    // Nothing at all *and* something went wrong is a failure, not an empty
    // chart. Nothing at all with no error is a genuinely quiet account.
    if (byDay.size === 0 && lastSoftFailure) throw lastSoftFailure;

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
