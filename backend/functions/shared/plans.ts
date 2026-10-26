/**
 * The plan catalogue — one definition, used to display the plans, to enforce
 * their limits, and (once Stripe is wired) to price a subscription.
 *
 * Kept here rather than in the page so a limit can never be enforced at one
 * number and advertised at another. The marketing page and the Billing page
 * both render from this via GET /plans.
 */

export type PlanId = 'starter' | 'growth' | 'scale';

/** null means no ceiling, which is a different thing from a very large one. */
export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly subscription price in USD. */
  priceUsd: number;
  /**
   * Monthly subscription price in INR, charged to Indian customers.
   *
   * A held price, not a live conversion: an invoice that moves with the
   * exchange rate is a support conversation every month, and Razorpay charges
   * a fixed amount per cycle anyway. Reviewed by hand when rates drift.
   */
  priceInr: number;
  /** How many cloud accounts may be connected; null = unlimited. */
  maxCloudAccounts: number | null;
  /**
   * The combined monthly cloud spend CloudMeter may monitor under this plan,
   * in USD; null = unlimited. This is the customer's own cloud bill, not what
   * they pay us — the tier scales with what is being watched.
   */
  maxManagedSpendUsd: number | null;
  /** Notification channels the plan includes. */
  channels: Array<'email' | 'whatsapp' | 'slack'>;
  /** Shown as the card's bullets, in order. */
  features: string[];
  /** One tier is highlighted; purely presentational. */
  featured?: boolean;
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export const PLANS: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceUsd: 25,
    priceInr: 2100,
    maxCloudAccounts: 5,
    maxManagedSpendUsd: 2500,
    channels: ['email'],
    features: [
      'Up to 5 cloud accounts',
      `Cumulative billing of ${money(2500)}`,
      'Notifications: Email only',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    priceUsd: 49,
    priceInr: 3999,
    maxCloudAccounts: 10,
    maxManagedSpendUsd: 10000,
    channels: ['email', 'whatsapp'],
    featured: true,
    features: [
      'Up to 10 cloud accounts',
      `Cumulative billing of ${money(10000)}`,
      'Notifications: Email + WhatsApp',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    priceUsd: 99,
    priceInr: 7999,
    maxCloudAccounts: null,
    maxManagedSpendUsd: null,
    channels: ['email', 'whatsapp', 'slack'],
    features: [
      'Unlimited accounts',
      'Unlimited cumulative billing',
      'Notifications: Email + WhatsApp + Slack',
    ],
  },
];

export function planById(id: string | undefined | null): Plan | null {
  return PLANS.find((p) => p.id === id) ?? null;
}

/**
 * The cheapest plan that covers a given usage.
 *
 * Used to recommend a tier from what someone is already monitoring, so the
 * suggestion follows the same numbers the limits are enforced at.
 */
export function smallestPlanFor(accounts: number, managedSpendUsd: number): Plan {
  return PLANS.find((p) =>
    (p.maxCloudAccounts === null || accounts <= p.maxCloudAccounts)
    && (p.maxManagedSpendUsd === null || managedSpendUsd <= p.maxManagedSpendUsd),
  ) ?? PLANS[PLANS.length - 1];
}

// ---- currency ----------------------------------------------------------

export type Currency = 'USD' | 'INR';

/**
 * Which currency a tenant is billed in.
 *
 * Decided from the billing address country, falling back to the account's
 * timezone when no address has been entered yet — a brand-new account has a
 * timezone from the browser before it ever reaches the billing page, so this
 * gets the common case right without asking.
 *
 * Deliberately narrow: INR for India, USD for everyone else. Razorpay is the
 * INR path and Stripe/Paddle the USD one, so widening this means adding a
 * gateway that can settle the new currency, not just a number here.
 */
export function currencyForTenant(tenant: {
  billingAddress?: { country?: string } | null;
  timezone?: string | null;
}): Currency {
  const country = (tenant.billingAddress?.country ?? '').trim().toLowerCase();
  if (country) return country === 'india' || country === 'in' ? 'INR' : 'USD';

  const tz = (tenant.timezone ?? '').trim();
  return tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' ? 'INR' : 'USD';
}

/**
 * Which billing region a tenant falls in.
 *
 * The same decision as currencyForTenant, named for what actually follows from
 * it: the region picks the currency, the gateway *and* whether GST applies, so
 * code that needs all three shouldn't have to infer two of them from a
 * currency code.
 */
export function regionForTenant(tenant: {
  billingAddress?: { country?: string } | null;
  timezone?: string | null;
}): 'india' | 'global' {
  return currencyForTenant(tenant) === 'INR' ? 'india' : 'global';
}

/** The amount to charge, in the currency's major unit. */
export function planPrice(plan: Plan, currency: Currency): number {
  return currency === 'INR' ? plan.priceInr : plan.priceUsd;
}

/**
 * Smallest unit, which is what every gateway's API actually takes — paise for
 * INR, cents for USD. Both happen to be 1/100, but naming it stops the next
 * currency being added with a silent 100x error.
 */
export function planPriceMinor(plan: Plan, currency: Currency): number {
  return Math.round(planPrice(plan, currency) * 100);
}

export function formatPrice(plan: Plan, currency: Currency): string {
  const amount = planPrice(plan, currency);
  return currency === 'INR'
    ? `₹${amount.toLocaleString('en-IN')}`
    : `$${amount.toLocaleString('en-US')}`;
}
