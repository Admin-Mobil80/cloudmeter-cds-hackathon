/**
 * Cancelling a subscription from the Billing page.
 *
 * Only the Owner may, only an active subscription, and always at the end of
 * the paid period on whichever gateway holds it — never an immediate stop.
 */

// Declared inside the factories: jest.mock is hoisted above any const here.
jest.mock('../functions/shared/authz', () => {
  const actual = jest.requireActual('../functions/shared/authz');
  return { ...actual, resolveCaller: jest.fn() };
});
jest.mock('../functions/shared/subscription', () => {
  const actual = jest.requireActual('../functions/shared/subscription');
  return { ...actual, getSubscription: jest.fn(), saveSubscription: jest.fn() };
});
jest.mock('../functions/shared/stripe', () => {
  const actual = jest.requireActual('../functions/shared/stripe');
  return { ...actual, stripeRequest: jest.fn() };
});
jest.mock('../functions/shared/razorpay', () => {
  const actual = jest.requireActual('../functions/shared/razorpay');
  return { ...actual, cancelSubscription: jest.fn() };
});

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler } from '../functions/api/billing/cancel';
import { resolveCaller as rc } from '../functions/shared/authz';
import { getSubscription as gs, saveSubscription as ss, type Subscription } from '../functions/shared/subscription';
import { stripeRequest as sr, StripeError } from '../functions/shared/stripe';
import { cancelSubscription as cs } from '../functions/shared/razorpay';

const resolveCaller = rc as jest.Mock;
const getSubscription = gs as jest.Mock;
const saveSubscription = ss as jest.Mock;
const stripeRequest = sr as jest.Mock;
const cancelSubscription = cs as jest.Mock;

const event = {} as APIGatewayProxyEventV2WithJWTAuthorizer;
const caller = (role: string, readOnlyDemo = false) => ({
  userId: 'u1', email: 'owner@acme.com',
  membership: { tenantId: 't1', role, readOnlyDemo, syncStatus: 'active' },
});
const sub = (over: Partial<Subscription> = {}): Subscription => ({
  planId: 'growth', status: 'active',
  stripeCustomerId: null, stripeSubscriptionId: null,
  currentPeriodEnd: '2026-11-20T00:00:00.000Z', cancelAtPeriodEnd: false,
  gateway: 'razorpay', gatewaySubscriptionId: 'sub_123',
  currency: 'INR', ...over,
} as Subscription);

async function call() {
  const res = await handler(event) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(() => jest.clearAllMocks());

describe('POST /billing/cancel', () => {
  it('lets only the Owner cancel', async () => {
    getSubscription.mockResolvedValue(sub());
    for (const role of ['admin', 'member']) {
      resolveCaller.mockResolvedValue(caller(role));
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Only the workspace owner can cancel the subscription.');
    }
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it('refuses the read-only demo workspace', async () => {
    resolveCaller.mockResolvedValue(caller('owner', true));
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body.readOnlyDemo).toBe(true);
  });

  it('cancels a Razorpay subscription at the end of the cycle', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub());
    const res = await call();
    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalledWith('sub_123');
    expect(saveSubscription).toHaveBeenCalledWith('t1', { cancelAtPeriodEnd: true });
  });

  it('cancels a Stripe subscription at the end of the period', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub({ gateway: 'stripe', gatewaySubscriptionId: null, stripeSubscriptionId: 'sub_stripe' }));
    stripeRequest.mockResolvedValue({});
    const res = await call();
    expect(res.status).toBe(200);
    expect(stripeRequest).toHaveBeenCalledWith('/subscriptions/sub_stripe', { cancel_at_period_end: 'true' });
  });

  it('says so when there is nothing active to cancel', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub({ status: 'canceled' }));
    expect((await call()).status).toBe(400);
  });

  it('does not cancel twice', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub({ cancelAtPeriodEnd: true }));
    const res = await call();
    expect(res.body.alreadyCancelled).toBe(true);
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it('points a plan set by the CloudMeter team at support', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub({ gateway: null, gatewaySubscriptionId: null }));
    const res = await call();
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('support@cloudmeter.io');
  });

  it('reports a gateway failure and records nothing', async () => {
    resolveCaller.mockResolvedValue(caller('owner'));
    getSubscription.mockResolvedValue(sub({ gateway: 'stripe', gatewaySubscriptionId: null, stripeSubscriptionId: 'sub_stripe' }));
    stripeRequest.mockRejectedValue(new StripeError('No such subscription', 404));
    const res = await call();
    expect(res.status).toBe(502);
    expect(saveSubscription).not.toHaveBeenCalled();
  });
});
