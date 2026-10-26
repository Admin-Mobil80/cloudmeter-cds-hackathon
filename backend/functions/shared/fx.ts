import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * Converting a provider's native billing currency into USD.
 *
 * CloudMeter's ledger is normalised to USD — the dashboard says so — but not
 * every provider bills in it. Meta invoices a WhatsApp Business Account in the
 * account's own currency, so an Indian WABA reports costs in rupees. Treating
 * those as dollars overstated a month's spend by roughly ninety times, which
 * is the mistake this exists to stop.
 *
 * Rates are fetched from a public source and cached for a day, with a held
 * table as the floor. The held numbers are a safety net for an outage, not the
 * normal path: they were the normal path briefly, and being 14% adrift on the
 * INR rate was enough to make the figures wrong in a way nobody would notice.
 */

// Keyless, ~166 currencies, refreshed daily. Chosen over the ECB feed because
// that one covers far fewer currencies and omits several this will need.
const RATES_URL = 'https://open.er-api.com/v6/latest/USD';

const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = { PK: 'PLATFORM#fx', SK: 'RATES' };

/** When the fallback table below was last checked by hand. */
export const FALLBACK_RATES_AS_OF = '2026-08-25';

/**
 * Units of the currency per 1 USD — the shape the rates API returns, so the
 * two can't drift into being each other's reciprocal.
 *
 * Only a floor for when the API is unreachable. Anything missing here and
 * missing from the API is reported unconverted and logged, never guessed.
 */
const FALLBACK_PER_USD: Record<string, number> = {
  USD: 1,
  INR: 95.8,
  EUR: 0.92,
  GBP: 0.79,
  AED: 3.67,
  SGD: 1.34,
  BRL: 5.4,
  IDR: 15800,
};

interface CachedRates {
  perUsd: Record<string, number>;
  /** When CloudMeter last called the API — drives the 24h cache, nothing else. */
  fetchedAt: string;
  /**
   * When the provider last published these rates, from time_last_update_utc.
   *
   * Distinct from fetchedAt and the one worth showing anyone: the feed updates
   * once a day, so a fetch at 00:30 returns rates published the previous
   * evening. Quoting our own fetch time as "updated" claimed a freshness the
   * figure did not have. Null on the fallback table, and on rows cached before
   * this field existed.
   */
  publishedAt?: string | null;
  source: 'live' | 'fallback';
}

let memo: CachedRates | null = null;

async function loadRates(): Promise<CachedRates> {
  if (memo && Date.now() - new Date(memo.fetchedAt).getTime() < CACHE_TTL_MS) return memo;

  // Shared across every tenant — an exchange rate is not customer data.
  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: CACHE_KEY }));
    const cached = Item?.rates as CachedRates | undefined;
    if (cached?.perUsd && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
      memo = cached;
      return cached;
    }
  } catch (err) {
    console.error('FX cache read failed', (err as Error).message);
  }

  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await res.json() as {
      result?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    if (res.ok && body.result === 'success' && body.rates?.USD === 1) {
      const published = body.time_last_update_utc
        ? new Date(body.time_last_update_utc)
        : null;
      const fresh: CachedRates = {
        perUsd: body.rates,
        fetchedAt: new Date().toISOString(),
        // An RFC 1123 string from the feed; stored as ISO so every consumer
        // parses it the same way. Unparseable is treated as absent rather than
        // stored as "Invalid Date".
        publishedAt: published && !Number.isNaN(published.getTime())
          ? published.toISOString()
          : null,
        source: 'live',
      };
      memo = fresh;
      await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...CACHE_KEY, rates: fresh } }))
        .catch((err) => console.error('FX cache write failed', (err as Error).message));
      return fresh;
    }
    console.error('FX source returned an unusable payload; using held rates');
  } catch (err) {
    console.error('FX fetch failed; using held rates', (err as Error).message);
  }

  const fallback: CachedRates = {
    perUsd: FALLBACK_PER_USD,
    fetchedAt: new Date().toISOString(),
    // The hand-checked table has a date of its own, and it is not today's.
    publishedAt: `${FALLBACK_RATES_AS_OF}T00:00:00.000Z`,
    source: 'fallback',
  };
  memo = fallback;
  return fallback;
}

export async function ratesInfo(): Promise<{
  source: string;
  fetchedAt: string;
  publishedAt?: string | null;
  perUsd: Record<string, number>;
}> {
  return loadRates();
}

/**
 * Converts an amount in `currency` into USD.
 *
 * An unrecognised currency is returned unchanged and logged loudly rather than
 * guessed at: reporting a number in the wrong unit is the failure being fixed
 * here, so inventing a rate would reintroduce it in a new currency.
 */
export async function toUsd(amount: number, currency: string | null | undefined): Promise<number> {
  const code = (currency ?? 'USD').toUpperCase();
  if (code === 'USD') return amount;

  const { perUsd } = await loadRates();
  const rate = perUsd[code];

  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    console.error(
      `FX: no rate for ${code} — reporting the amount unconverted, which will be wrong. `
      + 'Add it to the fallback table in shared/fx.ts.',
    );
    return amount;
  }
  return amount / rate;
}

/** Synchronous form, for callers that already hold the rate table. */
export function convertToUsd(amount: number, currency: string, perUsd: Record<string, number>): number {
  const code = currency.toUpperCase();
  if (code === 'USD') return amount;
  const rate = perUsd[code];
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    console.error(`FX: no rate for ${code} — leaving the amount unconverted.`);
    return amount;
  }
  return amount / rate;
}
