import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, requireOrgScope, json } from '../../../shared/authz';
import { PLANS, smallestPlanFor, regionForTenant } from '../../../shared/plans';
import { getPricing, priceFor, capFor } from '../../../shared/pricing';
import { ratesInfo } from '../../../shared/fx';
import { getGateway, gatewayForRegion } from '../../../shared/payment-gateway';
import { getSubscription, isEntitled, effectivePlan } from '../../../shared/subscription';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { stripeConfig } from '../../../shared/stripe';
import { razorpayConfig } from '../../../shared/razorpay';
import { paymentMethodFor } from '../../../shared/payment-method';

/**
 * What the Billing page needs: the plan catalogue, this tenant's subscription,
 * and the usage the tiers are measured against.
 *
 * Usage is computed here rather than on the page so the recommendation and the
 * limits are read off the same numbers.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  // Billing describes the whole organisation, so it follows the dashboard rule.
  const outOfScope = requireOrgScope(caller);
  if (outOfScope) return outOfScope;

  const tenantId = caller.membership.tenantId;
  const subscription = await getSubscription(tenantId);

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: 'accountId, spend, dataSource',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
  }));
  const accounts = Items ?? [];
  // Live accounts only: a plan's managed-spend ceiling is about real cloud
  // bills, and sample data would push someone toward a tier they don't need.
  const managedSpend = accounts
    .filter((a) => a.dataSource === 'live')
    .reduce((sum, a) => sum + ((a.spend as number) ?? 0), 0);

  const current = effectivePlan(subscription);
  const recommended = smallestPlanFor(accounts.length, managedSpend);

  // Where this tenant is billed decides currency, whether GST applies, and
  // which gateway takes the money. Resolved server-side so the page renders
  // exactly the figures checkout will charge, rather than deriving prices of
  // its own and risking a mismatch at the moment of payment.
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));
  const region = regionForTenant({
    billingAddress: (tenant?.billingAddress as { country?: string }) ?? null,
    timezone: (tenant?.timezone as string) ?? null,
  });
  const [pricing, gatewaySetting] = await Promise.all([getPricing(), getGateway()]);
  const gateway = gatewayForRegion(gatewaySetting, region);

  // Whether checkout can actually run. Offering a button that fails on click
  // is worse than saying payments aren't ready — the page should know before
  // the customer finds out.
  //
  // Asks the gateway that will actually process *this* tenant, not Stripe
  // unconditionally. That older check predated multi-gateway and went wrong
  // both ways once Razorpay became the default: it hid the button from
  // customers whose gateway was configured and working, and offered it to
  // customers whose gateway had no keys at all.
  const checkoutAvailable = await gatewayReady(gateway);

  /*
   * What the gateway actually holds for this tenant.
   *
   * Read alongside checkoutAvailable rather than from our own record, because
   * our record cannot tell an authorised subscription from an abandoned one —
   * it stores the id either way. Mobil80's production subscription sat
   * unauthorised for a month while the portal showed a paid plan.
   *
   * paymentMethodFor never throws: a gateway outage degrades this to
   * state 'unknown' and leaves the rest of the page working.
   */
  const paymentMethod = await paymentMethodFor(subscription);

  // The ceiling that applies right now, and this tenant's spend expressed in
  // the same units — the only way the two are comparable.
  const currentCap = current
    ? capFor(current, region, pricing)
    : { amount: null as number | null, currency: 'USD' as const };
  const spendInCapCurrency = currentCap.currency === 'INR'
    ? managedSpend * ((await ratesInfo()).perUsd.INR ?? 1)
    : managedSpend;

  return json(200, {
    plans: PLANS.map((plan) => ({
      ...plan,
      price: priceFor(plan, region, pricing),
      // The ceiling in the currency this customer reads, so the plan card
      // stops quoting dollars to someone whose price is in rupees.
      cap: capFor(plan, region, pricing),
    })),
    billing: {
      region,
      gateway,
      gstPercent: region === 'india' ? pricing.gstPercent : 0,
    },
    paymentMethod,
    subscription: {
      ...subscription,
      entitled: isEntitled(subscription),
      // Owner or Admin can start or change a subscription; a Member sees the
      // same figures but no way to commit the organisation to a charge. Kept
      // in lockstep with the same check in api/billing/checkout — this flag
      // only decides whether the button is offered, not whether the request
      // is honoured, so a mismatch here can't itself grant anything.
      canManage: caller.membership.role === 'owner' || caller.membership.role === 'admin',
      // Ending the subscription is the Owner's alone; see api/billing/cancel.
      canCancel: caller.membership.role === 'owner',
    },
    usage: {
      cloudAccounts: accounts.length,
      managedSpendUsd: managedSpend,
      // What they are over, if anything — named so the page doesn't recompute
      // limits and reach a different answer.
      overAccounts: !!current && current.maxCloudAccounts !== null
        && accounts.length > current.maxCloudAccounts,
      // Compared in the cap's own currency, so what is enforced is exactly
      // what the card showed. An INR ceiling is judged against the tenant's
      // spend converted at the same rate the page displays it with — the
      // alternative, enforcing a dollar figure while advertising a rupee one,
      // is a limit the customer cannot see coming.
      //
      // Note this makes a near-the-limit account sensitive to FX drift. That
      // is the cost of quoting the ceiling in rupees at all, and it moves by
      // fractions of a percent a day.
      overSpend: currentCap.amount !== null && spendInCapCurrency > currentCap.amount,
      cap: currentCap,
      spendInCapCurrency,
    },
    recommendedPlanId: recommended.id,
    checkoutAvailable,
  });
};

/**
 * Whether a gateway has enough configuration to take a payment.
 *
 * Each gateway's config loader throws when its secret is empty, which is the
 * same signal checkout itself would hit — so this asks the question the only
 * way that cannot drift from the answer.
 */
async function gatewayReady(gateway: string): Promise<boolean> {
  try {
    if (gateway === 'razorpay') { await razorpayConfig(); return true; }
    if (gateway === 'stripe') { await stripeConfig(); return true; }
    // Paddle is a placeholder — selecting it is a deliberate choice in BMS, and
    // checkout refuses it explicitly rather than pretending it might work.
    return false;
  } catch (err) {
    // Logged, not swallowed: this exact silence is what let a missing
    // RAZORPAY_SECRET_ARN on this Lambda masquerade as "Razorpay isn't
    // configured" for every Indian tenant, with nothing in CloudWatch to
    // point at the real cause.
    console.error(`gatewayReady(${gateway}) failed`, (err as Error).message);
    return false;
  }
}
