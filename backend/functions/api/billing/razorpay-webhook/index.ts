import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { mapSubscriptionStatus } from '../../../shared/razorpay';
import { saveSubscription } from '../../../shared/subscription';
import { PlanId } from '../../../shared/plans';
import { recordTransaction, TransactionKind } from '../../../shared/transactions';
import { getSubscription } from '../../../shared/subscription';

interface RazorpaySubscriptionEntity {
  id: string;
  status?: string;
  current_end?: number;
  notes?: Record<string, string>;
}

interface RazorpayPaymentEntity {
  id: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  created_at?: number;
  error_description?: string;
  notes?: Record<string, string>;
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    subscription?: { entity?: RazorpaySubscriptionEntity };
    payment?: { entity?: RazorpayPaymentEntity };
    refund?: { entity?: RazorpayPaymentEntity };
  };
}

/** Razorpay event name -> what kind of row it becomes. */
const PAYMENT_KINDS: Record<string, TransactionKind> = {
  'payment.captured': 'payment',
  'payment.failed': 'failed',
  'refund.created': 'refund',
  'refund.processed': 'refund',
};

const ok = () => ({ statusCode: 200, body: JSON.stringify({ received: true }) });

/**
 * Razorpay subscription webhook.
 *
 * SIGNATURE VERIFICATION IS DELIBERATELY DISABLED. This endpoint is public —
 * anyone who has this URL can POST to it — and this handler no longer checks
 * that a request genuinely came from Razorpay before acting on it. That is a
 * confirmed, explicit choice by the account owner (2026-08-26), made after
 * being told exactly what it opens up: anyone who finds this URL can forge a
 * `payment.captured` / `subscription.activated` body and mark any tenant as
 * paid, with no card ever charged. The alternative — setting a webhook
 * secret in Razorpay and pasting the matching value into
 * `cloudmeter/razorpay_{env}`'s `webhookSecret` field — costs nothing and
 * closes this hole; `verifyWebhookSignature` in shared/razorpay.ts (and the
 * same pattern already live on the Stripe webhook) is what re-enabling it
 * looks like. Do not silently restore the check without the same explicit
 * sign-off this removal had — the point of writing this comment is that a
 * future reader should not assume its absence was an oversight.
 *
 * Always answers 200, even for events it ignores: a non-2xx makes Razorpay
 * retry, and retrying an event we deliberately skipped just generates noise
 * forever.
 */
export const handler = async (event: APIGatewayProxyEventV2) => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let parsed: RazorpayEvent;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Bad payload' }) };
  }

  // Money events first: a payment carries the subscription id in its own
  // entity, so it is recorded whether or not a subscription event accompanies
  // it. Answering 200 afterwards either way keeps Razorpay from retrying.
  const kind = PAYMENT_KINDS[parsed.event ?? ''];
  if (kind) {
    await recordPayment(parsed, kind);
    return ok();
  }

  const entity = parsed.payload?.subscription?.entity;
  if (!entity?.id) return ok();

  // Set in `notes` when the subscription was created, which is the only link
  // back to a tenant — Razorpay knows nothing about CloudMeter's ids.
  const tenantId = entity.notes?.tenantId;
  if (!tenantId) {
    console.warn('Razorpay subscription event with no tenantId in notes', entity.id);
    return ok();
  }

  const status = mapSubscriptionStatus(entity.status ?? '');
  const planId = entity.notes?.planId as PlanId | undefined;

  await saveSubscription(tenantId, {
    gateway: 'razorpay',
    gatewaySubscriptionId: entity.id,
    status,
    ...(planId ? { planId } : {}),
    // Razorpay sends epoch seconds; absent on some events, and a missing value
    // must not blank a period end an earlier event established.
    ...(typeof entity.current_end === 'number'
      ? { currentPeriodEnd: new Date(entity.current_end * 1000).toISOString() }
      : {}),
  });

  console.log('Razorpay subscription updated', { tenantId, event: parsed.event, status });

  // A charge — first payment or a renewal — arrives as `subscription.charged`
  // carrying both entities in one payload: the subscription (whose notes
  // carry tenantId) and the payment (whose amount this records). The
  // standalone `payment.captured` event that fires alongside it cannot be
  // used for this: Razorpay does not copy the subscription's notes onto the
  // bare payment entity — confirmed empirically against a real captured
  // payment, which came back with `notes: []` — so tenantId is only
  // recoverable here, via the paired subscription.
  if (parsed.event === 'subscription.charged' && parsed.payload?.payment?.entity) {
    await recordPayment(parsed, 'payment');
  }

  return ok();
};

/**
 * Writes a payment, failure or refund to the transaction ledger.
 *
 * The tenant comes from the subscription's `notes`, which is the only link
 * Razorpay carries back to CloudMeter. A payment we cannot attribute is logged
 * and dropped rather than stored against nobody — an unattributed row in a
 * revenue ledger is worse than an absent one, because it looks like data.
 *
 * Never throws: the webhook's job is to acknowledge, and a failure to record
 * a row must not make Razorpay retry an event that already updated the
 * subscription.
 */
async function recordPayment(parsed: RazorpayEvent, kind: TransactionKind): Promise<void> {
  const entity = parsed.payload?.payment?.entity ?? parsed.payload?.refund?.entity;
  if (!entity?.id) return;

  const tenantId = entity.notes?.tenantId
    ?? parsed.payload?.subscription?.entity?.notes?.tenantId;
  if (!tenantId) {
    console.warn('Razorpay payment event with no tenantId in notes', entity.id, parsed.event);
    return;
  }

  try {
    // The GST split was stored on the subscription at checkout. Reading it
    // back means the ledger shows tax as charged rather than recomputed from
    // today's rate, which would restate old rows every time GST changed.
    const sub = await getSubscription(tenantId);

    await recordTransaction({
      tenantId,
      gateway: 'razorpay',
      gatewayPaymentId: entity.id,
      gatewaySubscriptionId: parsed.payload?.subscription?.entity?.id ?? sub.gatewaySubscriptionId,
      kind,
      // Razorpay reports minor units — paise for INR, cents for USD.
      amount: (entity.amount ?? 0) / 100,
      currency: entity.currency ?? sub.currency ?? 'INR',
      subtotal: sub.subtotal,
      tax: sub.tax,
      taxPercent: sub.taxPercent,
      planId: sub.planId,
      status: entity.status ?? (kind === 'failed' ? 'failed' : 'captured'),
      method: entity.method ?? null,
      occurredAt: entity.created_at
        ? new Date(entity.created_at * 1000).toISOString()
        : new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to record Razorpay transaction', entity.id, (err as Error).message);
  }
}
