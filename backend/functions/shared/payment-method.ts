import { razorpayRequest } from './razorpay';
import { stripeRequest } from './stripe';
import type { Subscription } from './subscription';

/**
 * What the gateway says, rather than what we wrote down.
 *
 * CloudMeter stored a subscription id at checkout and then never looked at it
 * again, so an authorised subscription and an abandoned one were identical in
 * our database. Mobil80's production subscription sat at Razorpay status
 * `created` — invoice raised, nobody ever authorised a mandate, no customer,
 * no card — from 27 August, while the portal showed the workspace as being on
 * a paid plan. Someone typed an end date into BMS each month and nothing ever
 * contradicted them.
 *
 * Read live rather than cached from webhooks, deliberately. A subscription
 * stuck at `created` is exactly the case that generates no events at all, so
 * a webhook-fed cache would stay silent about the one state worth surfacing.
 */

export type MandateState =
  /** Authorised and charging. */
  | 'active'
  /** Created but never authorised — cannot charge, and never will. */
  | 'awaiting_authorisation'
  /** The gateway knows it and it has stopped: cancelled, expired, halted. */
  | 'inactive'
  /** No gateway subscription recorded at all — a hand-set plan. */
  | 'none'
  /** The gateway could not be reached. Says nothing either way. */
  | 'unknown';

export interface PaymentMethodInfo {
  state: MandateState;
  /** The gateway's own status word, for support and the BMS console. */
  gatewayStatus: string | null;
  gateway: string | null;
  /** e.g. "Visa •••• 8940". Null when no instrument is attached. */
  label: string | null;
  brand: string | null;
  last4: string | null;
  /** MM/YYYY, omitted for a token the gateway gives no real expiry for. */
  expiry: string | null;
  /** When the gateway will next charge, ISO. Null when it will not. */
  nextChargeAt: string | null;
}

const NONE: PaymentMethodInfo = {
  state: 'none',
  gatewayStatus: null,
  gateway: null,
  label: null,
  brand: null,
  last4: null,
  expiry: null,
  nextChargeAt: null,
};

/**
 * Razorpay's placeholder expiry for a network token.
 *
 * Tokenised cards come back as 01/2099 because the token outlives the card
 * behind it. Showing that to a customer states something false — their card
 * does not expire in 2099 — so it is dropped rather than displayed.
 */
const TOKEN_PLACEHOLDER_YEAR = 2099;

function cardLabel(brand: string | null, last4: string | null): string | null {
  if (!last4) return null;
  return brand ? `${brand} •••• ${last4}` : `•••• ${last4}`;
}

function expiryOrNull(month?: number | string, year?: number | string): string | null {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(m) || !Number.isFinite(y)) return null;
  if (y >= TOKEN_PLACEHOLDER_YEAR) return null;
  return `${String(m).padStart(2, '0')}/${y}`;
}

interface RazorpaySubscription {
  status: string;
  customer_id: string | null;
  charge_at: number | null;
  current_end: number | null;
}
interface RazorpayTokens {
  items?: Array<{
    method?: string;
    recurring?: boolean;
    card?: { network?: string; last4?: string; expiry_month?: number; expiry_year?: number };
  }>;
}

async function fromRazorpay(subscriptionId: string): Promise<PaymentMethodInfo> {
  const sub = await razorpayRequest<RazorpaySubscription>(`/subscriptions/${subscriptionId}`);

  // `created` is the state that caused this module to exist: Razorpay has the
  // subscription and an invoice, and no mandate was ever authorised against
  // it. `authenticated` means the mandate exists but the first charge has not
  // landed, which is a live subscription and reads as one.
  const state: MandateState = sub.status === 'active' || sub.status === 'authenticated'
    ? 'active'
    : sub.status === 'created' || sub.status === 'pending'
      ? 'awaiting_authorisation'
      : 'inactive';

  const base: PaymentMethodInfo = {
    ...NONE,
    state,
    gateway: 'razorpay',
    gatewayStatus: sub.status,
    nextChargeAt: sub.charge_at ? new Date(sub.charge_at * 1000).toISOString() : null,
  };

  // No customer means no instrument to describe — which is itself the answer.
  if (!sub.customer_id) return base;

  const tokens = await razorpayRequest<RazorpayTokens>(`/customers/${sub.customer_id}/tokens`);
  // The recurring one is the mandate doing the charging; a customer may hold
  // other tokens from one-off payments that will never renew anything.
  const items = tokens.items ?? [];
  const token = items.find((t) => t.recurring && t.card) ?? items.find((t) => t.card);
  if (!token?.card) return base;

  const brand = token.card.network ?? null;
  const last4 = token.card.last4 ?? null;
  return {
    ...base,
    brand,
    last4,
    label: cardLabel(brand, last4),
    expiry: expiryOrNull(token.card.expiry_month, token.card.expiry_year),
  };
}

interface StripeSubscription {
  status: string;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number }> };
  default_payment_method?: string | null;
}
interface StripePaymentMethod {
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
}

async function fromStripe(subscriptionId: string): Promise<PaymentMethodInfo> {
  const sub = await stripeRequest<StripeSubscription>(`/subscriptions/${subscriptionId}`);

  // Stripe has no direct equivalent of Razorpay's `created`: a subscription
  // exists only once checkout completed. `incomplete` is the nearest — the
  // first payment never succeeded — and belongs in the same bucket, because
  // it is the same message to the customer.
  const state: MandateState = sub.status === 'active' || sub.status === 'trialing'
    ? 'active'
    : sub.status === 'incomplete'
      ? 'awaiting_authorisation'
      : 'inactive';

  const ends = (sub.items?.data ?? [])
    .map((i) => i.current_period_end)
    .find((v): v is number => typeof v === 'number') ?? sub.current_period_end;

  const base: PaymentMethodInfo = {
    ...NONE,
    state,
    gateway: 'stripe',
    gatewayStatus: sub.status,
    nextChargeAt: ends ? new Date(ends * 1000).toISOString() : null,
  };

  if (!sub.default_payment_method) return base;
  const pm = await stripeRequest<StripePaymentMethod>(`/payment_methods/${sub.default_payment_method}`);
  if (!pm.card) return base;

  const brand = pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : null;
  const last4 = pm.card.last4 ?? null;
  return {
    ...base,
    brand,
    last4,
    label: cardLabel(brand, last4),
    expiry: expiryOrNull(pm.card.exp_month, pm.card.exp_year),
  };
}

/**
 * Never throws. A gateway outage must not take the Billing page down with it,
 * and `unknown` is an honest answer that the page can render as "we could not
 * check" — unlike `none`, which would assert something we do not know.
 */
export async function paymentMethodFor(sub: Subscription): Promise<PaymentMethodInfo> {
  const id = sub.gatewaySubscriptionId ?? sub.stripeSubscriptionId;
  if (!id) return NONE;

  const gateway = sub.gateway ?? (sub.stripeSubscriptionId ? 'stripe' : 'razorpay');
  try {
    if (gateway === 'stripe') return await fromStripe(id);
    if (gateway === 'razorpay') return await fromRazorpay(id);
    return { ...NONE, state: 'unknown', gateway };
  } catch (err) {
    console.warn('Could not read the gateway subscription', {
      gateway, subscriptionId: id, reason: (err as Error).message,
    });
    return { ...NONE, state: 'unknown', gateway };
  }
}
