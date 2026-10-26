import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, requireRole, json } from '../../../shared/authz';
import { planById } from '../../../shared/plans';
import { stripeRequest, StripeError } from '../../../shared/stripe';
import { getSubscription, saveSubscription } from '../../../shared/subscription';
import { getGateway, gatewayForRegion } from '../../../shared/payment-gateway';
import { regionForTenant } from '../../../shared/plans';
import { getPricing, priceFor, BillingRegion, PriceBreakdown } from '../../../shared/pricing';
import {
  razorpayPlanId, createSubscription, RazorpayError, RazorpayNotConfiguredError,
} from '../../../shared/razorpay';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';

const PORTAL_URL = process.env.PORTAL_URL!;

/**
 * Starts checkout (Stripe or Razorpay, by region) for a plan.
 *
 * Owner or Admin: it commits the organisation to a recurring charge, which is
 * why a Member — scoped to individual cloud accounts, not the account's own
 * billing — cannot reach this. An Admin doing it on the Owner's behalf is a
 * deliberate choice: unlike closing the CloudMeter account, starting a
 * subscription is reversible (cancel, or simply don't renew), so it doesn't
 * need to be Owner-only the way that does.
 *
 * Prices are built from the plan catalogue rather than referencing Stripe
 * Price IDs, so the amount charged is the amount plans.ts advertises and the
 * two cannot drift. The trade-off is that changing a price changes it for new
 * checkouts only — existing subscriptions keep the price they were created at,
 * which is the behaviour you want anyway.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return json(403, { message: 'Only the account owner or an admin can change the plan.' });

  let body: { planId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const plan = planById(typeof body.planId === 'string' ? body.planId : null);
  if (!plan) return json(400, { message: 'Unknown plan' });

  const tenantId = caller.membership.tenantId;
  const existing = await getSubscription(tenantId);

  // Where this customer is billed decides all three of: currency, whether GST
  // applies, and which gateway takes the money. Resolved once, up front.
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));
  const region = regionForTenant({
    billingAddress: (tenant?.billingAddress as { country?: string }) ?? null,
    timezone: (tenant?.timezone as string) ?? null,
  });

  // Read per request rather than cached: a price or gateway change in BMS must
  // take effect on the next checkout, not whenever a Lambda container happens
  // to recycle.
  const [gatewaySetting, pricing] = await Promise.all([getGateway(), getPricing()]);
  const gateway = gatewayForRegion(gatewaySetting, region);
  const price = priceFor(plan, region, pricing);

  if (gateway === 'paddle') {
    return json(503, {
      message: 'Paddle is selected as the payment gateway for customers outside India, '
        + 'but is not implemented yet. Switch the gateway in BMS, or contact support '
        + 'to complete this purchase.',
    });
  }

  if (gateway === 'razorpay') {
    return razorpayCheckout({ tenantId, plan, caller, existing, region, price });
  }

  try {
    // Reuse the customer if this tenant has one, so a second subscription
    // doesn't fragment their billing history across two Stripe customers.
    let customerId = existing.stripeCustomerId;
    if (!customerId) {
      const customer = await stripeRequest<{ id: string }>('/customers', {
        email: caller.email,
        name: caller.membership.tenantName ?? undefined,
        metadata: { tenantId, cloudmeterOwner: caller.userId },
      }, { idempotencyKey: `customer-${tenantId}` });
      customerId = customer.id;
      await saveSubscription(tenantId, { stripeCustomerId: customerId });
    }

    const session = await stripeRequest<{ id: string; url: string }>('/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      success_url: `${PORTAL_URL}/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PORTAL_URL}/billing.html?checkout=cancelled`,
      client_reference_id: tenantId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          // The configured global price, not the compiled-in one — and no tax
          // line, because outside India CloudMeter does not collect any.
          unit_amount: price.totalMinor,
          recurring: { interval: 'month' },
          product_data: {
            name: `CloudMeter ${plan.name}`,
            description: plan.features.join(' · '),
          },
        },
      }],
      // Carried on both the session and the subscription: the webhook needs to
      // know which tenant and plan an event belongs to without a lookup table.
      metadata: { tenantId, planId: plan.id },
      subscription_data: { metadata: { tenantId, planId: plan.id } },
    });

    return json(200, { url: session.url, sessionId: session.id, planId: plan.id });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error('Stripe checkout failed', err.status, err.code, err.message);
      return json(502, { message: `Stripe could not start checkout: ${err.message}` });
    }
    // The detail ("add secretKey to the Stripe secret") is an instruction to
    // whoever runs CloudMeter, not to the customer looking at the page — so it
    // goes to the log and they get something true and actionable instead.
    console.error('Checkout failed', (err as Error).message);
    return json(503, {
      message: 'Payments are not available just yet. Nothing has been charged — '
        + 'please try again shortly, or email hello@cloudmeter.io.',
    });
  }
};

/**
 * Razorpay's equivalent of a Checkout Session.
 *
 * Razorpay bills against an immutable Plan object rather than inline prices,
 * so the plan is resolved (and created on first use) before the subscription.
 * The customer is sent to Razorpay's hosted authorisation page, where they set
 * up a UPI Autopay or card mandate; every later cycle is charged automatically
 * and reported through the webhook.
 */
async function razorpayCheckout(args: {
  tenantId: string;
  plan: ReturnType<typeof planById> & object;
  caller: { email: string; membership: { tenantName: string | null } };
  existing: Awaited<ReturnType<typeof getSubscription>>;
  region: BillingRegion;
  price: PriceBreakdown;
}) {
  const { tenantId, plan, caller, region, price } = args;
  const currency = price.currency;

  try {
    // The mandate is for the tax-inclusive figure — Razorpay charges one fixed
    // amount per cycle and has no concept of our GST line. The split is stored
    // below so the invoice can show it.
    const razorpayPlan = await razorpayPlanId(plan, currency, price.totalMinor);
    const subscription = await createSubscription({
      planId: razorpayPlan,
      tenantId,
      email: caller.email,
      tenantName: caller.membership.tenantName,
    });

    // Recorded before the customer pays: the webhook arrives keyed on the
    // subscription id, and an id we never stored is an event we cannot match
    // to a tenant.
    await saveSubscription(tenantId, {
      planId: plan.id,
      gatewaySubscriptionId: subscription.id,
      gateway: 'razorpay',
      currency,
      // What they agreed to pay, kept as it was at signup. Prices and the GST
      // rate both change; an invoice for a past cycle must not move with them.
      region,
      subtotal: price.subtotal,
      taxPercent: price.taxPercent,
      tax: price.tax,
      total: price.total,
    });

    return json(200, {
      url: subscription.short_url,
      gateway: 'razorpay',
      currency,
      price,
    });
  } catch (err) {
    if (err instanceof RazorpayNotConfiguredError) {
      return json(503, {
        message: 'Razorpay is selected but its API keys have not been added yet. '
          + 'Add them to the Razorpay secret in AWS Secrets Manager.',
      });
    }
    if (err instanceof RazorpayError) {
      return json(502, { message: `Razorpay refused the request: ${err.message}` });
    }
    throw err;
  }
}
