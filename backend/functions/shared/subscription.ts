import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { PlanId, planById, Plan } from './plans';

/**
 * What CloudMeter records about a tenant's subscription.
 *
 * Stripe is the authority on all of it; this is a local copy kept current by
 * the webhook so that a page load doesn't have to call Stripe, and so that a
 * Stripe outage degrades to stale state rather than to no state.
 */
export interface Subscription {
  planId: PlanId | null;
  status: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** ISO timestamp the current paid period ends. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Which gateway this subscription actually lives on.
   *
   * Recorded per subscription, not read from the platform setting: switching
   * the platform gateway doesn't migrate anyone, so a tenant subscribed on
   * Razorpay must keep being reconciled against Razorpay even after the
   * setting moves to Stripe. Null for records predating multi-gateway.
   */
  gateway: string | null;
  /** The gateway's own subscription id — Razorpay's `sub_…`, and so on. */
  gatewaySubscriptionId: string | null;
  /** Currency actually charged, so an invoice is never relabelled later. */
  currency: string | null;
  /**
   * What was agreed at signup, held rather than recomputed.
   *
   * Plan prices are editable in BMS and the GST rate is set by legislation, so
   * both move. Recomputing an invoice from today's config would silently
   * restate what a customer was charged last month. Null on records created
   * before pricing was configurable.
   */
  region: string | null;
  subtotal: number | null;
  taxPercent: number | null;
  tax: number | null;
  total: number | null;
}

/** Statuses Stripe considers as granting access to the product. */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Whether a status alone grants access, for callers that hold the status but
 * not a whole Subscription — /me reads the tenant record for other reasons
 * and shouldn't re-fetch it just to answer this.
 */
export function statusGrantsAccess(status: string | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

export function isEntitled(sub: Subscription): boolean {
  return statusGrantsAccess(sub.status);
}

/**
 * The plan whose limits apply right now.
 *
 * Null while someone is still in the free trial with no subscription — the
 * trial is deliberately unlimited, so there is nothing to enforce yet.
 */
export function effectivePlan(sub: Subscription): Plan | null {
  return isEntitled(sub) ? planById(sub.planId) : null;
}

export async function getSubscription(tenantId: string): Promise<Subscription> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));

  return {
    planId: (Item?.planId as PlanId) ?? null,
    status: (Item?.subscriptionStatus as string) ?? null,
    stripeCustomerId: (Item?.stripeCustomerId as string) ?? null,
    stripeSubscriptionId: (Item?.stripeSubscriptionId as string) ?? null,
    currentPeriodEnd: (Item?.currentPeriodEnd as string) ?? null,
    cancelAtPeriodEnd: Item?.cancelAtPeriodEnd === true,
    // Stripe came first, so a record with a Stripe subscription id and no
    // explicit gateway is a Stripe one.
    gateway: (Item?.gateway as string) ?? (Item?.stripeSubscriptionId ? 'stripe' : null),
    gatewaySubscriptionId: (Item?.gatewaySubscriptionId as string)
      ?? (Item?.stripeSubscriptionId as string) ?? null,
    currency: (Item?.currency as string) ?? null,
    region: (Item?.region as string) ?? null,
    subtotal: numberOrNull(Item?.subtotal),
    taxPercent: numberOrNull(Item?.taxPercent),
    tax: numberOrNull(Item?.tax),
    total: numberOrNull(Item?.total),
  };
}

/** DynamoDB numbers arrive as numbers, but an absent one must stay absent. */
function numberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Writes back what Stripe just told us.
 *
 * Only the fields present are touched: webhook events arrive out of order and
 * carry different subsets, so a partial event must not blank what an earlier,
 * fuller one established.
 */
export async function saveSubscription(
  tenantId: string,
  patch: Partial<Subscription>,
): Promise<void> {
  const map: Array<[keyof Subscription, string]> = [
    ['planId', 'planId'],
    ['status', 'subscriptionStatus'],
    ['stripeCustomerId', 'stripeCustomerId'],
    ['stripeSubscriptionId', 'stripeSubscriptionId'],
    ['currentPeriodEnd', 'currentPeriodEnd'],
    ['cancelAtPeriodEnd', 'cancelAtPeriodEnd'],
    ['gateway', 'gateway'],
    ['gatewaySubscriptionId', 'gatewaySubscriptionId'],
    ['currency', 'currency'],
  ];

  const sets: string[] = ['subscriptionUpdatedAt = :now'];
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };

  for (const [key, attr] of map) {
    if (patch[key] === undefined) continue;
    sets.push(`${attr} = :${attr}`);
    values[`:${attr}`] = patch[key];
  }
  if (sets.length === 1) return;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
  }));
}
