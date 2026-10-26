import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { stripeConfig, verifyWebhookSignature, stripeRequest } from '../../../shared/stripe';
import { PlanId } from '../../../shared/plans';
import { saveSubscription } from '../../../shared/subscription';

interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  /** Present on older API versions only — see periodEnd(). */
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number }> };
  currency?: string;
  metadata?: Record<string, string>;
}

/**
 * When the paid period ends, in seconds.
 *
 * Stripe moved this off the subscription and onto its items: a subscription
 * can hold items on different cycles, so there is no single subscription-level
 * answer any more. The webhook destination is pinned to a version where the
 * top-level field is gone, and reading it returned undefined on every event —
 * so every Stripe customer was stored with a null period end, which
 * currentPeriod() correctly refuses to date and hands to a human instead.
 *
 * Items first, then the old field, because a downgrade of the destination's
 * API version should degrade to the old shape rather than to no date at all.
 * CloudMeter sells one item per subscription, so the first item is the
 * subscription; max() rather than [0] keeps that from silently becoming a
 * too-early renewal date if that ever stops being true.
 */
export function periodEnd(sub: StripeSubscriptionObject): number | null {
  const fromItems = (sub.items?.data ?? [])
    .map((i) => i.current_period_end)
    .filter((v): v is number => typeof v === 'number');
  if (fromItems.length) return Math.max(...fromItems);
  return typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Stripe's view of a subscription, pushed to us.
 *
 * Deliberately PUBLIC — Stripe has no credentials of ours — so the signature
 * is the entire security boundary. Nothing is read from the body until it
 * verifies, and verification runs over the exact bytes Stripe sent.
 *
 * Always answers 200 once verified, even when the event is one we ignore or
 * cannot map to a tenant: a non-2xx makes Stripe retry for days, and a bad
 * event will fail identically every time.
 */
export const handler = async (event: APIGatewayProxyEventV2) => {
  const ok = (body: Record<string, unknown>) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // API Gateway may hand us base64. The signature covers the original bytes,
  // so decode before verifying and never re-serialise.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let cfg;
  try {
    cfg = await stripeConfig();
  } catch (err) {
    console.error('Stripe not configured', (err as Error).message);
    return { statusCode: 500, body: JSON.stringify({ message: 'Stripe not configured' }) };
  }

  const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature'];
  const verdict = verifyWebhookSignature(rawBody, signature, cfg.webhookSecret);
  if (!verdict.ok) {
    // 400, not 200: an unverified caller is not Stripe, and should not be
    // told we accepted anything.
    console.warn('Rejected webhook:', verdict.reason);
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid signature' }) };
  }

  let stripeEvent: StripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON' }) };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as {
          client_reference_id?: string;
          customer?: string;
          subscription?: string;
          metadata?: Record<string, string>;
        };
        const tenantId = session.client_reference_id ?? session.metadata?.tenantId;
        if (!tenantId || !session.subscription) break;

        // The session says a subscription exists but not its period or status,
        // so read it back rather than guessing.
        const sub = await stripeRequest<StripeSubscriptionObject>(`/subscriptions/${session.subscription}`);
        await applySubscription(tenantId, sub, session.metadata?.planId as PlanId | undefined);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object as unknown as StripeSubscriptionObject;
        const tenantId = sub.metadata?.tenantId;
        if (!tenantId) {
          console.warn('Subscription event with no tenantId in metadata', sub.id);
          break;
        }
        await applySubscription(tenantId, sub, sub.metadata?.planId as PlanId | undefined);
        break;
      }

      default:
        // Everything else is noise for our purposes; acknowledge and move on.
        break;
    }
  } catch (err) {
    // Logged and acknowledged: Stripe retrying will not fix a bug here, and a
    // retry storm would bury the log line that shows what actually broke.
    console.error('Webhook handling failed', stripeEvent.type, (err as Error).message);
  }

  return ok({ received: true, type: stripeEvent.type });
};

async function applySubscription(
  tenantId: string,
  sub: StripeSubscriptionObject,
  planId: PlanId | undefined,
): Promise<void> {
  const ends = periodEnd(sub);

  await saveSubscription(tenantId, {
    // A deleted subscription keeps its plan for the record; entitlement is
    // decided by status, not by whether a plan is set.
    ...(planId ? { planId } : {}),
    status: sub.status,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: ends ? new Date(ends * 1000).toISOString() : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    /*
     * Which gateway is actually billing this tenant.
     *
     * Omitted until now, so a tenant who tried Razorpay before subscribing on
     * Stripe kept `gateway: 'razorpay'` beside a live Stripe subscription, and
     * the stale Razorpay id sat next to the Stripe one. Anything reconciling a
     * customer against their gateway — support, or a cancellation — would have
     * gone to the wrong dashboard.
     *
     * The stale id is cleared rather than left: it names a subscription on a
     * gateway this tenant is no longer billed by, and a wrong id is worse than
     * none. Razorpay's own webhook sets both when it is the one charging.
     */
    gateway: 'stripe',
    gatewaySubscriptionId: null,
    ...(sub.currency ? { currency: sub.currency.toUpperCase() } : {}),
  });
  console.log('Subscription updated', { tenantId, status: sub.status, planId });
}
