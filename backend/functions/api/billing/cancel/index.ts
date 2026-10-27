import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, requireRole, json } from '../../../shared/authz';
import { stripeRequest, StripeError } from '../../../shared/stripe';
import { cancelSubscription, RazorpayError } from '../../../shared/razorpay';
import { getSubscription, isEntitled, saveSubscription } from '../../../shared/subscription';

/**
 * Cancels the workspace's subscription at the end of the paid period.
 *
 * Owner only: the Owner is the one who agreed to be charged, and an Admin who
 * can change the plan still shouldn't be able to end the organisation's
 * subscription on their own. requireRole also refuses the read-only demo.
 *
 * Never immediate. The period is already paid for, so access runs to its end
 * and the gateway simply doesn't renew — Stripe's cancel_at_period_end, and
 * Razorpay's cancel_at_cycle_end. The gateway's webhook then reports the
 * subscription ended, exactly as for any lapse.
 *
 * Deliberately open to a lapsed workspace, like the rest of billing/* (see
 * test/read-only.test.ts): a workspace whose payment failed is precisely one
 * whose owner may want out, and refusing them would leave a mandate they
 * cannot stop.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const forbidden = requireRole(caller, ['owner']);
  if (forbidden) {
    if (caller.membership.readOnlyDemo) return forbidden;
    return json(403, { message: 'Only the workspace owner can cancel the subscription.' });
  }

  const tenantId = caller.membership.tenantId;
  const subscription = await getSubscription(tenantId);
  if (!isEntitled(subscription)) {
    return json(400, { message: 'There is no active subscription to cancel.' });
  }
  if (subscription.cancelAtPeriodEnd) {
    return json(200, { cancelAtPeriodEnd: true, currentPeriodEnd: subscription.currentPeriodEnd, alreadyCancelled: true });
  }

  try {
    if (subscription.gateway === 'razorpay' && subscription.gatewaySubscriptionId) {
      await cancelSubscription(subscription.gatewaySubscriptionId);
    } else if (subscription.stripeSubscriptionId) {
      await stripeRequest(`/subscriptions/${encodeURIComponent(subscription.stripeSubscriptionId)}`, {
        cancel_at_period_end: 'true',
      });
    } else {
      // A plan set by hand in BMS: there is no gateway subscription to stop.
      return json(400, { message: 'This plan was set up by the CloudMeter team, so it can\'t be cancelled here. Email support@cloudmeter.io and we\'ll cancel it for you.' });
    }
  } catch (err) {
    if (err instanceof StripeError || err instanceof RazorpayError) {
      console.error('Cancel failed at the gateway', subscription.gateway, err.status, err.message);
      return json(502, { message: `The payment provider couldn't cancel the subscription: ${err.message}` });
    }
    throw err;
  }

  // Recorded now so the page shows it at once; the gateway's webhook agrees
  // shortly after (Stripe sends cancel_at_period_end, Razorpay the eventual
  // cancellation).
  await saveSubscription(tenantId, { cancelAtPeriodEnd: true });
  console.log('Subscription set to cancel', { tenantId, gateway: subscription.gateway, by: caller.userId });
  return json(200, { cancelAtPeriodEnd: true, currentPeriodEnd: subscription.currentPeriodEnd });
};
