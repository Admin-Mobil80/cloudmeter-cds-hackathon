import { razorpayRequest } from './razorpay';
import { stripeRequest } from './stripe';

/**
 * Whether a tenant's gateway subscription can still charge someone.
 *
 * BMS asks before it takes a tenant over by hand. Setting a plan by hand
 * unlinks the gateway subscription, so CloudMeter would stop tracking it —
 * and a subscription that is still live would keep charging a card nobody
 * can now cancel from the portal. A subscription already set to cancel is
 * still live until its period ends: the gateway's "cancelled" webhook would
 * then mark the tenant cancelled, undoing whatever was set by hand before it.
 *
 * Read from the gateway, never from our own record: Vandelay's record said
 * "set in BMS" while Razorpay was charging a card every month.
 */
export interface GatewayLink {
  gateway: 'razorpay' | 'stripe';
  id: string;
  /** The gateway's own status, as it reports it. */
  status: string;
  /** True while the gateway may still take a payment. */
  live: boolean;
}

/** Razorpay statuses after which nothing more is ever charged. */
const RAZORPAY_ENDED = new Set(['created', 'cancelled', 'completed', 'expired']);
/** Stripe statuses after which nothing more is ever charged. */
const STRIPE_ENDED = new Set(['canceled', 'incomplete_expired']);

export function isLive(gateway: 'razorpay' | 'stripe', status: string): boolean {
  return !(gateway === 'razorpay' ? RAZORPAY_ENDED : STRIPE_ENDED).has(status);
}

/**
 * The tenant's linked gateway subscription and whether it is live, or null if
 * none is linked. Throws if the gateway can't be reached: the caller must not
 * guess, since guessing "ended" is exactly the mistake this guards against.
 */
export async function linkedSubscription(tenant: Record<string, unknown>): Promise<GatewayLink | null> {
  if (tenant.gateway === 'razorpay' && typeof tenant.gatewaySubscriptionId === 'string' && tenant.gatewaySubscriptionId) {
    const id = tenant.gatewaySubscriptionId;
    const sub = await razorpayRequest<{ status?: string }>(`/subscriptions/${encodeURIComponent(id)}`);
    const status = sub.status ?? 'unknown';
    return { gateway: 'razorpay', id, status, live: isLive('razorpay', status) };
  }
  if (typeof tenant.stripeSubscriptionId === 'string' && tenant.stripeSubscriptionId) {
    const id = tenant.stripeSubscriptionId;
    const sub = await stripeRequest<{ status?: string }>(`/subscriptions/${encodeURIComponent(id)}`);
    const status = sub.status ?? 'unknown';
    return { gateway: 'stripe', id, status, live: isLive('stripe', status) };
  }
  return null;
}
