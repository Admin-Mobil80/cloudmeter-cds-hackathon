import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { PLANS, Plan, PlanId, Currency } from './plans';

/**
 * What a plan costs, per region, and the tax on top of it.
 *
 * CloudMeter sells into two places with different rules, so a single price is
 * not enough:
 *
 *   India  — charged in INR through Razorpay, plus 18% GST. GST is a statutory
 *            charge we collect and remit, so it is added to the price rather
 *            than absorbed into it, and it must appear on the invoice as its
 *            own line.
 *   Global — charged in USD, no tax added here. Sales tax and VAT outside
 *            India are the merchant-of-record's problem, and CloudMeter is not
 *            registered to collect them.
 *
 * Prices live here rather than only in plans.ts because they have to be
 * changeable without a deploy — pricing is a commercial decision, and waiting
 * on an engineer to edit a constant is the wrong shape for it. plans.ts stays
 * the seed and the fallback: whatever BMS has not overridden comes from there,
 * so a wiped or unreadable config leaves the product priced, not free.
 */

export type BillingRegion = 'india' | 'global';

/** GST on Indian sales. A rate, not a law — it has changed before and will again. */
export const DEFAULT_GST_PERCENT = 18;

/**
 * Free-trial length, in days, and the range BMS may set it to.
 *
 * Bounded because it is a commercial lever, not a free-text field: under a day
 * is not a trial, and beyond a fortnight it stops being one too — long enough
 * that people forget they started it and short enough to still be a decision.
 *
 * Changing it moves *new* accounts only. Every account stores its own
 * `trialEndsAt` when it is created, so nobody's deadline shifts under them
 * because the default was edited afterwards.
 */
export const DEFAULT_TRIAL_DAYS = 7;
export const MIN_TRIAL_DAYS = 1;
export const MAX_TRIAL_DAYS = 14;

const KEY = { PK: 'PLATFORM#config', SK: 'PRICING' };

export interface PlanPriceOverride {
  /** Monthly price in INR, charged to Indian customers, before GST. */
  inr: number;
  /** Monthly price in USD, charged everywhere else. */
  usd: number;
}

/**
 * The managed-spend ceiling for a plan, per region, in that region's currency.
 *
 * The tiers scale with how much cloud spend CloudMeter is watching, so the
 * ceiling is the number the customer is actually buying — and quoting an
 * Indian customer "$2,500/mo managed cloud spend" next to a price in rupees
 * asked them to do the conversion themselves.
 *
 * null means unlimited, which is a different thing from a very large number.
 */
export interface PlanCapOverride {
  inr: number | null;
  usd: number | null;
}

export interface PricingConfig {
  prices: Record<PlanId, PlanPriceOverride>;
  caps: Record<PlanId, PlanCapOverride>;
  /** Applied to Indian sales only. */
  gstPercent: number;
  /** Length of the free trial for accounts created from now on. */
  trialDays: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** True when nothing has been configured and plans.ts values are in force. */
  usingDefaults: boolean;
}

/** Keeps a stored value in range even if it was written before the bounds existed. */
export function clampTrialDays(days: number): number {
  return Math.min(MAX_TRIAL_DAYS, Math.max(MIN_TRIAL_DAYS, Math.round(days)));
}

export function regionForCurrency(currency: Currency): BillingRegion {
  return currency === 'INR' ? 'india' : 'global';
}

export function currencyForRegion(region: BillingRegion): Currency {
  return region === 'india' ? 'INR' : 'USD';
}

function defaultPrices(): Record<PlanId, PlanPriceOverride> {
  return Object.fromEntries(
    PLANS.map((p) => [p.id, { inr: p.priceInr, usd: p.priceUsd }]),
  ) as Record<PlanId, PlanPriceOverride>;
}

/**
 * Seeded from the compiled-in USD ceiling, with the INR one left null until
 * somebody sets it. Null there means "no separate Indian ceiling", and the
 * resolver falls back to the USD figure rather than inventing a conversion —
 * a made-up rupee cap that nobody chose is worse than an honest dollar one.
 */
function defaultCaps(): Record<PlanId, PlanCapOverride> {
  return Object.fromEntries(
    PLANS.map((p) => [p.id, { inr: null, usd: p.maxManagedSpendUsd }]),
  ) as Record<PlanId, PlanCapOverride>;
}

/** A stored price is only honoured if it is a usable number. */
function usable(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function getPricing(): Promise<PricingConfig> {
  const fallback: PricingConfig = {
    prices: defaultPrices(),
    caps: defaultCaps(),
    gstPercent: DEFAULT_GST_PERCENT,
    trialDays: DEFAULT_TRIAL_DAYS,
    updatedAt: null,
    updatedBy: null,
    usingDefaults: true,
  };

  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: KEY }));
    if (!Item) return fallback;

    const stored = (Item.prices ?? {}) as Record<string, { inr?: unknown; usd?: unknown }>;
    const prices = defaultPrices();
    // Merged per field rather than wholesale, so a config written before a new
    // plan existed doesn't leave that plan priceless.
    for (const plan of PLANS) {
      const row = stored[plan.id];
      if (!row) continue;
      const inr = usable(row.inr);
      const usd = usable(row.usd);
      prices[plan.id] = {
        inr: inr ?? plan.priceInr,
        usd: usd ?? plan.priceUsd,
      };
    }

    const storedCaps = (Item.caps ?? {}) as Record<string, { inr?: unknown; usd?: unknown }>;
    const caps = defaultCaps();
    for (const plan of PLANS) {
      const row = storedCaps[plan.id];
      if (!row) continue;
      // null is meaningful here — it is how "unlimited" is stored — so an
      // explicit null is kept rather than falling back to the default.
      caps[plan.id] = {
        inr: row.inr === null ? null : usable(row.inr) ?? caps[plan.id].inr,
        usd: row.usd === null ? null : usable(row.usd) ?? caps[plan.id].usd,
      };
    }

    return {
      prices,
      caps,
      gstPercent: usable(Item.gstPercent) ?? DEFAULT_GST_PERCENT,
      trialDays: clampTrialDays(usable(Item.trialDays) ?? DEFAULT_TRIAL_DAYS),
      updatedAt: (Item.updatedAt as string) ?? null,
      updatedBy: (Item.updatedBy as string) ?? null,
      usingDefaults: false,
    };
  } catch (err) {
    // Checkout and the pricing page both depend on this. Falling back to the
    // compiled-in catalogue keeps them working at the last known-good prices
    // rather than failing or, far worse, charging zero.
    console.error('Pricing config read failed; using plans.ts defaults', (err as Error).message);
    return fallback;
  }
}

export async function setPricing(
  input: {
    prices: Record<PlanId, PlanPriceOverride>;
    caps: Record<PlanId, PlanCapOverride>;
    gstPercent: number;
    trialDays: number;
  },
  updatedBy: string,
): Promise<PricingConfig> {
  const updatedAt = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...KEY, prices: input.prices, caps: input.caps,
      gstPercent: input.gstPercent, trialDays: input.trialDays, updatedAt, updatedBy,
    },
  }));
  console.log('Plan pricing changed', { by: updatedBy, gstPercent: input.gstPercent });
  return { ...input, updatedAt, updatedBy, usingDefaults: false };
}

// ---- what a customer actually pays -------------------------------------

export interface PriceBreakdown {
  region: BillingRegion;
  currency: Currency;
  /** Price before tax, in the currency's major unit. */
  subtotal: number;
  /** 18 for India, 0 elsewhere — carried so an invoice can name the rate. */
  taxPercent: number;
  taxLabel: string | null;
  tax: number;
  total: number;
  /** Smallest unit (paise/cents) — what every gateway API actually takes. */
  totalMinor: number;
}

/**
 * What one plan costs one customer, tax included.
 *
 * **Tax follows the customer, never the gateway.** Razorpay can process
 * non-Indian sales too — it is the default for the global region, and BMS may
 * keep it there — but a customer outside India owes no GST regardless of who
 * takes their money. Deciding tax from the gateway would charge 18% to every
 * overseas customer the moment Razorpay was selected abroad. Region is the
 * only input.
 *
 * Rounds to whole minor units at each step, because that is the only amount a
 * gateway can charge. Tax is computed on the *rounded* subtotal rather than
 * rounding the total at the end, so subtotal + tax === total exactly. An
 * invoice whose lines don't add up to its own total is a support ticket, and
 * with GST it is also a filing problem.
 */
export function priceFor(
  plan: Plan,
  region: BillingRegion,
  pricing: PricingConfig,
): PriceBreakdown {
  const currency = currencyForRegion(region);
  const configured = pricing.prices[plan.id];
  const subtotalMajor = region === 'india'
    ? configured?.inr ?? plan.priceInr
    : configured?.usd ?? plan.priceUsd;

  const subtotalMinor = Math.round(subtotalMajor * 100);
  const taxPercent = region === 'india' ? pricing.gstPercent : 0;
  const taxMinor = Math.round((subtotalMinor * taxPercent) / 100);
  const totalMinor = subtotalMinor + taxMinor;

  return {
    region,
    currency,
    subtotal: subtotalMinor / 100,
    taxPercent,
    taxLabel: taxPercent > 0 ? `GST ${taxPercent}%` : null,
    tax: taxMinor / 100,
    total: totalMinor / 100,
    totalMinor,
  };
}

/**
 * The managed-spend ceiling that applies to one plan in one region, in that
 * region's own currency.
 *
 * India falls back to the USD figure when no rupee ceiling has been set, so an
 * unconfigured install still enforces something real rather than nothing. The
 * currency it is quoted in is returned alongside, because a caller that
 * assumes rupees would mislabel exactly that fallback.
 */
export function capFor(
  plan: Plan,
  region: BillingRegion,
  pricing: PricingConfig,
): { amount: number | null; currency: Currency } {
  const configured = pricing.caps?.[plan.id];

  if (region === 'india') {
    const inr = configured?.inr;
    if (inr !== undefined && inr !== null) return { amount: inr, currency: 'INR' };
    const usd = configured?.usd !== undefined ? configured.usd : plan.maxManagedSpendUsd;
    return { amount: usd, currency: 'USD' };
  }

  const usd = configured?.usd !== undefined ? configured.usd : plan.maxManagedSpendUsd;
  return { amount: usd, currency: 'USD' };
}
