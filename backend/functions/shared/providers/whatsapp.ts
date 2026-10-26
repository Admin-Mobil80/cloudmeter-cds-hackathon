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

// WhatsApp Business is metered spend like any cloud: Meta bills per delivered
// template message, priced by category and by the recipient's country. Since
// July 2025 it is per-message rather than per-conversation, and the figures
// come from the WABA's `pricing_analytics` field on the Graph API.
//
// The two dimensions map straight onto what every other adapter here produces:
//   pricing_category (MARKETING / UTILITY / AUTHENTICATION / ...) -> services
//   country                                                      -> tags
// Country matters more here than anywhere else in CloudMeter: the same
// template can cost 30x more in one market than another.
const GRAPH_VERSION = 'v23.0';
const GRAPH_HOST = 'https://graph.facebook.com';

const REQUEST_TIMEOUT_MS = 15_000;

/** How many countries to surface as a tag dimension, most expensive first. */
const MAX_COUNTRIES = 10;

interface DataPoint {
  start?: number;
  end?: number;
  country?: string;
  pricing_category?: string;
  pricing_type?: string;
  volume?: number | string;
  cost?: number | string;
}

interface PricingAnalyticsResponse {
  pricing_analytics?: { data?: Array<{ data_points?: DataPoint[] }> };
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** MARKETING -> Marketing, AUTHENTICATION_INTERNATIONAL -> Authentication international. */
function categoryLabel(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return 'Uncategorised';
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Meta answers auth failures with HTTP 400 and an OAuthException rather than
 * 401, so the HTTP status alone can't be trusted to separate "bad token" from
 * "bad request" — the error code is the authority.
 *
 *   190  expired / invalid / revoked access token
 *   200, 10, 3  permission problems: the token is real but lacks
 *               whatsapp_business_management, or isn't allowed on this WABA
 *   100  malformed request — ours to fix, not the customer's
 */
function classifyFailure(status: number, err: PricingAnalyticsResponse['error'], raw: string): Error {
  const code = err?.code;
  const message = err?.message ?? raw;
  const detail = `HTTP ${status}${code ? ` code ${code}` : ''}${message ? `: ${message}` : ''}`;
  const haystack = message.toLowerCase();

  if (code === 190 || haystack.includes('access token')) {
    return new ProviderAuthError(
      `Meta rejected the access token. Use a System User token from Business Settings that `
        + `hasn't expired — tokens generated for a person expire, System User tokens can be `
        + `made permanent. (${detail})`,
    );
  }
  if (code === 200 || code === 10 || code === 3 || haystack.includes('permission')) {
    return new ProviderPermissionError(
      `Meta authenticated the token but refused the billing query. The System User needs the `
        + `whatsapp_business_management permission and must be assigned to this WhatsApp `
        + `Business Account in Business Settings. (${detail})`,
    );
  }
  if (code === 100) {
    return new Error(
      `Meta rejected the request — check the WhatsApp Business Account ID is the WABA ID, `
        + `not a phone number ID or a Business Manager ID. (${detail})`,
    );
  }
  return new Error(`WhatsApp Business cost query failed (${detail})`);
}

/**
 * One `pricing_analytics` read.
 *
 * The token goes in the Authorization header rather than the query string:
 * Graph accepts either, but a URL carrying a permanent System User token ends
 * up in logs and error text.
 */
async function pricingAnalytics(
  creds: ProviderCredentials,
  granularity: 'DAILY' | 'MONTHLY',
  start: Date,
  end: Date,
): Promise<DataPoint[]> {
  const wabaId = (creds.waba_id ?? '').trim();
  if (!wabaId) throw new ProviderAuthError('Enter the WhatsApp Business Account ID.');

  // Field-parameter syntax: every argument is applied to the field itself, not
  // to the node, so this is one nested read rather than a separate edge.
  const field = `pricing_analytics`
    + `.start(${unixSeconds(start)})`
    + `.end(${unixSeconds(end)})`
    + `.granularity(${granularity})`
    + `.dimensions(COUNTRY,PRICING_CATEGORY)`
    + `.metric_types(COST,VOLUME)`;

  const url = `${GRAPH_HOST}/${GRAPH_VERSION}/${encodeURIComponent(wabaId)}`
    + `?fields=${encodeURIComponent(field)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Couldn't reach the Meta Graph API (${(err as Error).name})`);
  }

  const text = await res.text();
  let body: PricingAnalyticsResponse = {};
  try {
    body = text ? (JSON.parse(text) as PricingAnalyticsResponse) : {};
  } catch {
    // Edge errors ahead of Graph can be HTML; the status still carries meaning.
  }

  // Graph reports failures in the body even on a 200, so the error field is
  // checked regardless of status.
  if (!res.ok || body.error) {
    const stated = (text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    console.error('WhatsApp pricing_analytics failed', { status: res.status, body: stated });
    throw classifyFailure(res.status, body.error, stated);
  }

  return (body.pricing_analytics?.data ?? []).flatMap((d) => d.data_points ?? []);
}

/**
 * The currency Meta bills this WhatsApp Business Account in.
 *
 * Not optional detail: `pricing_analytics` reports `cost` in this currency
 * with no unit attached anywhere in the payload, so reading the figures
 * without it is how ₹537 became "$537".
 */
async function wabaCurrency(creds: ProviderCredentials): Promise<string> {
  const wabaId = (creds.waba_id ?? '').trim();
  const url = `${GRAPH_HOST}/${GRAPH_VERSION}/${encodeURIComponent(wabaId)}?fields=currency`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json() as { currency?: string; error?: unknown };
    if (!res.ok || body.error || !body.currency) {
      // USD is the safest assumption to fall back on: it is the ledger's own
      // unit, so a wrong guess leaves the number unchanged rather than
      // scaling it by a rate that may not apply.
      console.error('Could not read WABA currency; assuming USD', JSON.stringify(body.error ?? {}));
      return 'USD';
    }
    return body.currency.toUpperCase();
  } catch (err) {
    console.error('WABA currency lookup failed; assuming USD', (err as Error).message);
    return 'USD';
  }
}

/**
 * Which day (or month) a data point belongs to.
 *
 * Meta buckets in the WhatsApp Business Account's *own* timezone, not UTC: an
 * Indian WABA returns days starting at 18:30Z, because that is midnight IST.
 * Keying those off the UTC date pushed every bucket into the previous day —
 * and, at a month boundary, into the previous month, which is how a month
 * with real spend reported zero.
 *
 * The midpoint of the bucket is used rather than its start, which lands inside
 * the correct local day for any offset within ±12h without this code needing
 * to know what the account's timezone actually is.
 */
function pointDate(point: DataPoint): Date | null {
  if (typeof point.start !== 'number') return null;
  const start = point.start * 1000;
  const end = typeof point.end === 'number' ? point.end * 1000 : start + 86_400_000;
  const d = new Date((start + end) / 2);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Folds data points into per-bucket service totals and per-bucket country
 * totals in one pass — both dimensions come back on every point, so there is
 * no reason to ask Meta twice.
 */
function fold(
  points: DataPoint[],
  keyOf: (d: Date) => string,
  currency: string,
  perUsd: Record<string, number>,
) {
  const services = new Map<string, Map<string, number>>();
  const countries = new Map<string, Map<string, number>>();

  for (const point of points) {
    const date = pointDate(point);
    if (!date) continue;
    const key = keyOf(date);
    // Converted at the point of ingest so everything downstream — snapshots,
    // alerts, the dashboard total — is already in the ledger's currency.
    const cost = convertToUsd(toNumber(point.cost), currency, perUsd);

    const byService = services.get(key) ?? new Map<string, number>();
    const service = categoryLabel(point.pricing_category);
    byService.set(service, (byService.get(service) ?? 0) + cost);
    services.set(key, byService);

    const byCountry = countries.get(key) ?? new Map<string, number>();
    // Free service conversations carry no country on some points; they are
    // still real (zero-cost) traffic, so they are not dropped.
    const country = (point.country ?? '').trim() || 'Unknown';
    byCountry.set(country, (byCountry.get(country) ?? 0) + cost);
    countries.set(key, byCountry);
  }

  return { services, countries };
}

function countryTags(perCountry: Map<string, number> | undefined): Record<string, TagBreakdownItem[]> {
  if (!perCountry) return {};
  const items = [...perCountry]
    .filter(([, spend]) => spend > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COUNTRIES)
    .map(([label, spend]) => ({ label, spend, untagged: label === 'Unknown' }));
  return items.length ? { Country: items } : {};
}

export const whatsappAdapter: ProviderAdapter = {
  key: 'whatsapp',
  displayName: 'WhatsApp Business',
  // Built against Meta's documented pricing_analytics contract, but not yet
  // run against a real WhatsApp Business Account.
  verified: false,

  credentialFields: [
    {
      name: 'waba_id',
      label: 'WhatsApp Business Account ID',
      type: 'text',
      required: true,
      placeholder: '1234567890123456',
      help: 'Business Settings > Accounts > WhatsApp Accounts. This is the WABA ID — '
        + 'not a phone number ID and not the Business Manager ID.',
    },
    {
      name: 'access_token',
      label: 'System User Access Token',
      type: 'secret',
      required: true,
      placeholder: 'EAAG…',
      help: 'A System User token with the whatsapp_business_management permission, assigned '
        + 'to this WhatsApp Business Account. Person tokens expire; System User tokens can be '
        + 'made permanent. Stored encrypted and never shown again.',
    },
    {
      name: 'business_name',
      label: 'Business Name',
      type: 'text',
      required: true,
      placeholder: 'Acme Inc.',
      help: 'How this WhatsApp Business Account is labelled in CloudMeter.',
    },
  ],

  async verifyAccess(creds) {
    if (!(creds.access_token ?? '').trim()) {
      throw new ProviderAuthError('Enter the System User access token.');
    }
    // Yesterday to now: proves the token authenticates, carries the WhatsApp
    // management permission, and is scoped to this WABA. An account that sent
    // nothing yesterday returns no data points, which is a valid answer.
    const now = new Date();
    await pricingAnalytics(creds, 'DAILY', dayStart(now, -1), now);
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const now = new Date();
    const start = monthStart(now, -(months - 1));
    const end = monthStart(now, 1);

    // Deliberately DAILY, then folded into months.
    //
    // MONTHLY granularity comes back incomplete — against a real account it
    // returned two points for a six-month window and silently omitted the
    // current month entirely, while DAILY over the same window returned every
    // day of it. Folding the daily buckets also guarantees the monthly figure
    // and the daily chart agree, since they are then the same numbers.
    const [points, currency, fx] = await Promise.all([
      pricingAnalytics(creds, 'DAILY', start, end),
      wabaCurrency(creds),
      ratesInfo(),
    ]);
    const { services, countries } = fold(points, monthKeyOf, currency, fx.perUsd);

    const monthly: Array<{
      date: Date;
      services: Array<{ name: string; spend: number }>;
      tagBreakdown: Record<string, TagBreakdownItem[]>;
    }> = [];

    // Every month in the window, so a quiet month is a zero rather than a gap.
    for (let i = months - 1; i >= 0; i--) {
      const date = monthStart(now, -i);
      const key = monthKeyOf(date);
      monthly.push({
        date,
        services: [...(services.get(key) ?? new Map<string, number>())]
          .map(([name, spend]) => ({ name, spend })),
        tagBreakdown: countryTags(countries.get(key)),
      });
    }

    return buildSnapshots(monthly);
  },

  // Meta reports pricing daily natively, so the daily view is raw data rather
  // than anything derived.
  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const now = new Date();
    const [points, currency, fx] = await Promise.all([
      pricingAnalytics(creds, 'DAILY', dayStart(now, -(days - 1)), dayStart(now, 1)),
      wabaCurrency(creds),
      ratesInfo(),
    ]);
    const { services } = fold(points, dayKeyOf, currency, fx.perUsd);

    const daily: Array<{ date: Date; services: Array<{ name: string; spend: number }> }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayStart(now, -i);
      daily.push({
        date,
        services: [...(services.get(dayKeyOf(date)) ?? new Map<string, number>())]
          .map(([name, spend]) => ({ name, spend })),
      });
    }

    return buildDailySnapshots(daily);
  },
};
