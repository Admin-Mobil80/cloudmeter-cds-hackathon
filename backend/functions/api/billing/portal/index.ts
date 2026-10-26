import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, requireRole, json } from '../../../shared/authz';
import { stripeRequest, StripeError } from '../../../shared/stripe';
import { getSubscription } from '../../../shared/subscription';

const PORTAL_URL = process.env.PORTAL_URL!;

/**
 * A one-time link into Stripe's own billing portal.
 *
 * Card details, invoices and cancellation live there deliberately: CloudMeter
 * never sees a card number, and Stripe's portal is already built, localised
 * and PCI-compliant.
 *
 * Owner or Admin — kept in step with api/billing/checkout's role check. The
 * Billing page offers this button and the plan-selection buttons under one
 * `canManage` flag; splitting the two into different roles would show an
 * Admin a working "choose a plan" alongside a "manage billing" button that
 * 403s the moment they click it.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return json(403, { message: 'Only the account owner or an admin can manage billing.' });

  const subscription = await getSubscription(caller.membership.tenantId);
  if (!subscription.stripeCustomerId) {
    return json(400, { message: 'No billing account yet — choose a plan first.' });
  }

  try {
    const session = await stripeRequest<{ url: string }>('/billing_portal/sessions', {
      customer: subscription.stripeCustomerId,
      return_url: `${PORTAL_URL}/billing.html`,
    });
    return json(200, { url: session.url });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error('Stripe portal failed', err.status, err.code, err.message);
      return json(502, { message: `Stripe could not open the billing portal: ${err.message}` });
    }
    throw err;
  }
};
