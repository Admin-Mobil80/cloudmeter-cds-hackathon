import { ratesInfo } from './fx';

/**
 * What currency a tenant *reads* their spend in.
 *
 * Distinct from how it is stored. The ledger stays in USD everywhere — that
 * is what makes six providers addable — and this converts only at the point
 * of display. So changing the setting is instant and reversible, historical
 * figures never shift underneath anyone, and nothing needs re-syncing.
 *
 * Two choices by design: USD, or the currency of the country on the billing
 * address. A full currency picker would be mostly unused and every extra
 * currency is another rounding and formatting case to get wrong.
 */

export type DisplayCurrencyMode = 'USD' | 'LOCAL';
export type FxSource = 'auto' | 'manual';

/** Billing-address country to its currency. Keyed on the values the Settings form offers. */
const COUNTRY_CURRENCY: Record<string, string> = {
  india: 'INR',
  'united states': 'USD',
  'united kingdom': 'GBP',
  singapore: 'SGD',
  'united arab emirates': 'AED',
  germany: 'EUR',
  australia: 'AUD',
};

const SYMBOLS: Record<string, string> = {
  USD: '$', INR: '₹', GBP: '£', EUR: '€', SGD: 'S$', AED: 'AED ', AUD: 'A$',
};

export function currencySymbol(code: string): string {
  return SYMBOLS[code.toUpperCase()] ?? `${code.toUpperCase()} `;
}

/**
 * The local currency implied by the billing address, falling back to the
 * account timezone before giving up on USD — a new account has a timezone
 * from the browser long before anyone fills in an address.
 */
export function localCurrencyFor(tenant: {
  billingAddress?: { country?: string } | null;
  timezone?: string | null;
}): string {
  const country = (tenant.billingAddress?.country ?? '').trim().toLowerCase();
  if (country && COUNTRY_CURRENCY[country]) return COUNTRY_CURRENCY[country];

  const tz = (tenant.timezone ?? '').trim();
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
  return 'USD';
}

export interface DisplayCurrency {
  /** The currency amounts should be shown in. */
  code: string;
  symbol: string;
  /** Multiply a USD amount by this to get the display amount. */
  rate: number;
  /** Which currency LOCAL resolves to for this tenant, whatever the mode is. */
  localCode: string;
  mode: DisplayCurrencyMode;
  source: FxSource;
  /** Where the rate came from, for the "as of" line the UI shows. */
  rateSource: string;
  rateAsOf: string | null;
}

/**
 * Resolves everything the UI needs to render money for one tenant.
 *
 * A manual rate is honoured exactly as entered, because the whole point of
 * offering one is that a finance team needs figures at the rate in their own
 * books rather than today's spot rate. It is never quietly overridden by the
 * live feed.
 */
export async function resolveDisplayCurrency(tenant: {
  billingAddress?: { country?: string } | null;
  timezone?: string | null;
  displayCurrency?: string | null;
  fxSource?: string | null;
  fxRateManual?: number | null;
}): Promise<DisplayCurrency> {
  const localCode = localCurrencyFor(tenant);
  const mode: DisplayCurrencyMode = tenant.displayCurrency === 'USD' ? 'USD' : 'LOCAL';
  const code = mode === 'USD' ? 'USD' : localCode;

  const base = { localCode, mode, symbol: currencySymbol(code), code };

  if (code === 'USD') {
    return { ...base, rate: 1, source: 'auto', rateSource: 'none', rateAsOf: null };
  }

  const source: FxSource = tenant.fxSource === 'manual' ? 'manual' : 'auto';

  if (source === 'manual') {
    const manual = Number(tenant.fxRateManual);
    if (Number.isFinite(manual) && manual > 0) {
      return { ...base, rate: manual, source, rateSource: 'manual', rateAsOf: null };
    }
    // Configured manual but no usable rate — fall through to live rather than
    // render every figure as zero.
    console.warn('Manual FX rate is missing or invalid; using the live rate instead');
  }

  const fx = await ratesInfo();
  const rate = fx.perUsd[code];
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    console.error(`No FX rate for ${code}; showing USD instead`);
    return { ...base, code: 'USD', symbol: '$', rate: 1, source, rateSource: 'unavailable', rateAsOf: null };
  }

  // The provider's own publication time, not ours. The feed updates once a
  // day, so quoting fetchedAt told a customer the rate was "updated" at the
  // moment our cache happened to refresh — which could be hours after, and on
  // a different date from, the figure they were looking at. Falls back to
  // fetchedAt for rows cached before publishedAt existed.
  return {
    ...base,
    rate,
    source: 'auto',
    rateSource: fx.source,
    rateAsOf: fx.publishedAt ?? fx.fetchedAt,
  };
}
