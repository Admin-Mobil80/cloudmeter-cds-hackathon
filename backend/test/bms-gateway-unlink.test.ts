/**
 * Setting a plan by hand in BMS takes the tenant over from its payment
 * gateway — but never while that gateway can still charge someone.
 *
 * Vandelay is why: renewed by hand in BMS while Razorpay went on charging a
 * colleague's card every month.
 */

// Declared inside the factories: jest.mock is hoisted above any const here.
jest.mock('../functions/shared/ddb', () => ({ ddb: { send: jest.fn() }, TABLE_NAME: 'cloudmeter_test' }));
jest.mock('../functions/shared/bms', () => {
  const actual = jest.requireActual('../functions/shared/bms');
  return { ...actual, resolveBmsCaller: jest.fn().mockResolvedValue({ email: 'staff@cloudmeter.io' }) };
});
jest.mock('../functions/shared/pricing', () => ({ getPricing: jest.fn().mockResolvedValue({ trialDays: 7 }) }));
jest.mock('../functions/shared/razorpay', () => ({ razorpayRequest: jest.fn() }));
jest.mock('../functions/shared/stripe', () => ({ stripeRequest: jest.fn() }));

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler } from '../functions/api/bms/tenant-subscription';
import { isLive, linkedSubscription } from '../functions/shared/gateway-link';
import { ddb } from '../functions/shared/ddb';
import { razorpayRequest as rzp } from '../functions/shared/razorpay';
import { stripeRequest as stp } from '../functions/shared/stripe';

const send = ddb.send as jest.Mock;
const razorpayRequest = rzp as jest.Mock;
const stripeRequest = stp as jest.Mock;

const VANDELAY = {
  PK: 'TENANT#t1', SK: 'TENANT#t1', createdAt: '2026-08-20T00:00:00Z', trialEndsAt: '2026-08-27T00:00:00Z',
  planId: 'growth', subscriptionStatus: 'active', currentPeriodEnd: '2026-11-25T18:30:00.000Z',
  gateway: 'razorpay', gatewaySubscriptionId: 'sub_TUTPdpJAu8SigZ', subscriptionSource: 'bms',
};

/** Answers the two GetItems (before and after) with `tenant`; records the update. */
function tenantIs(tenant: Record<string, unknown>) {
  send.mockImplementation((cmd: { constructor: { name: string } }) =>
    Promise.resolve(cmd.constructor.name === 'GetCommand' ? { Item: tenant } : {}));
}
const update = () => send.mock.calls.map(([c]) => c).find((c) => c.constructor.name === 'UpdateCommand')?.input;

async function call(body: object) {
  const event = { pathParameters: { tenantId: 't1' }, body: JSON.stringify(body) } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const res = await handler(event) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(() => jest.clearAllMocks());

describe('which gateway statuses can still charge', () => {
  it.each([
    ['razorpay', 'active', true], ['razorpay', 'authenticated', true], ['razorpay', 'halted', true],
    ['razorpay', 'created', false], ['razorpay', 'cancelled', false], ['razorpay', 'completed', false],
    ['stripe', 'active', true], ['stripe', 'past_due', true], ['stripe', 'canceled', false],
  ])('%s %s → live %s', (gateway, status, live) => {
    expect(isLive(gateway as 'razorpay' | 'stripe', status as string)).toBe(live);
  });

  it('reads the status from the gateway, not our record', async () => {
    razorpayRequest.mockResolvedValue({ status: 'active' });
    expect(await linkedSubscription(VANDELAY)).toMatchObject({ gateway: 'razorpay', id: 'sub_TUTPdpJAu8SigZ', live: true });
    expect(razorpayRequest).toHaveBeenCalledWith('/subscriptions/sub_TUTPdpJAu8SigZ');
    expect(await linkedSubscription({ planId: 'growth' })).toBeNull();
  });
});

describe('BMS set plan / renew', () => {
  it('refuses while the Razorpay subscription can still charge, and changes nothing', async () => {
    tenantIs(VANDELAY);
    razorpayRequest.mockResolvedValue({ status: 'active' });
    for (const body of [{ action: 'renew' }, { planId: 'growth' }, { planId: null }]) {
      const res = await call(body);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('live Razorpay subscription (sub_TUTPdpJAu8SigZ, active)');
      expect(res.body.message).toContain('after it ends on 2026-11-25');
    }
    expect(update()).toBeUndefined();
  });

  it('unlinks an ended subscription and clears "set to cancel" when renewing', async () => {
    tenantIs({ ...VANDELAY, subscriptionStatus: 'canceled', cancelAtPeriodEnd: true });
    razorpayRequest.mockResolvedValue({ status: 'cancelled' });
    expect((await call({ planId: 'growth' })).status).toBe(200);
    const u = update();
    expect(u.UpdateExpression).toContain('cancelAtPeriodEnd = :notCancelling');
    expect(u.UpdateExpression).toContain('REMOVE gateway, gatewaySubscriptionId, stripeSubscriptionId');
    expect(u.ExpressionAttributeValues[':notCancelling']).toBe(false);
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
  });

  it('unlinks a checkout that was never authorised (Hooli, Mobil80)', async () => {
    tenantIs({ ...VANDELAY, gatewaySubscriptionId: 'sub_TUTPEsQn5I4iFQ' });
    razorpayRequest.mockResolvedValue({ status: 'created' });
    expect((await call({ action: 'renew' })).status).toBe(200);
    expect(update().UpdateExpression).toContain('REMOVE gateway');
  });

  it('checks a Stripe subscription the same way', async () => {
    tenantIs({ ...VANDELAY, gateway: 'stripe', gatewaySubscriptionId: undefined, stripeSubscriptionId: 'sub_s' });
    stripeRequest.mockResolvedValue({ status: 'active' });
    expect((await call({ action: 'renew' })).status).toBe(409);
  });

  it('leaves a purely hand-managed account as it was', async () => {
    tenantIs({ ...VANDELAY, gateway: undefined, gatewaySubscriptionId: undefined });
    expect((await call({ action: 'renew' })).status).toBe(200);
    expect(update().UpdateExpression).not.toContain('REMOVE');
    expect(razorpayRequest).not.toHaveBeenCalled();
  });

  it('refuses rather than guesses when the gateway cannot be reached', async () => {
    tenantIs(VANDELAY);
    razorpayRequest.mockRejectedValue(new Error('timeout'));
    expect((await call({ action: 'renew' })).status).toBe(502);
    expect(update()).toBeUndefined();
  });

  it('does not check the gateway for a trial extension', async () => {
    tenantIs({ ...VANDELAY, planId: undefined });
    await call({ action: 'renew-trial' });
    expect(razorpayRequest).not.toHaveBeenCalled();
  });
});
