/**
 * Reading the real state of a subscription from the gateway.
 *
 * CloudMeter stored a subscription id at checkout and never looked at it
 * again, so an authorised subscription and an abandoned one were identical in
 * the database. Mobil80's production subscription sat at Razorpay status
 * `created` — invoice raised, mandate never authorised, no customer, no card —
 * from 27 August while the portal showed the workspace on a paid plan.
 *
 * The mapping below is the whole fix, so it is where a mistake would either
 * keep hiding a dead subscription or alarm a customer whose card is fine.
 */

// Declared inside the factories: jest.mock is hoisted above any const here.
jest.mock('../functions/shared/razorpay', () => ({ razorpayRequest: jest.fn() }));
jest.mock('../functions/shared/stripe', () => ({ stripeRequest: jest.fn() }));

import { paymentMethodFor } from '../functions/shared/payment-method';
import { razorpayRequest as rzp } from '../functions/shared/razorpay';
import { stripeRequest as stp } from '../functions/shared/stripe';
import type { Subscription } from '../functions/shared/subscription';

const razorpayRequest = rzp as jest.Mock;
const stripeRequest = stp as jest.Mock;

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  planId: 'growth', status: 'active',
  stripeCustomerId: null, stripeSubscriptionId: null,
  currentPeriodEnd: null, cancelAtPeriodEnd: false,
  gateway: 'razorpay', gatewaySubscriptionId: 'sub_TUVSPe4hnO75jI',
  currency: 'INR', ...over,
} as Subscription);

/** Answers /subscriptions/… and /customers/…/tokens by path. */
function razorpay(subscription: unknown, tokens: unknown = { items: [] }) {
  razorpayRequest.mockImplementation((path: string) =>
    Promise.resolve(path.includes('/tokens') ? tokens : subscription));
}

beforeEach(() => { razorpayRequest.mockReset(); stripeRequest.mockReset(); });

describe('the subscription that caused this', () => {
  it('reports an unauthorised Razorpay subscription as awaiting authorisation', async () => {
    // Exactly Mobil80's production record: invoice raised, nobody authorised.
    razorpay({ status: 'created', customer_id: null, charge_at: null, current_end: null });
    const info = await paymentMethodFor(sub());

    expect(info.state).toBe('awaiting_authorisation');
    expect(info.gatewayStatus).toBe('created');
    expect(info.label).toBeNull();
    expect(info.nextChargeAt).toBeNull();
  });

  it('does not claim a card when there is no customer to ask about', async () => {
    razorpay({ status: 'created', customer_id: null, charge_at: null, current_end: null });
    await paymentMethodFor(sub());
    // One call only: asking for tokens of a null customer is a 404 we would
    // then have to explain away as "unknown".
    expect(razorpayRequest).toHaveBeenCalledTimes(1);
  });
});

describe('a healthy Razorpay subscription', () => {
  // Vandelay's real record, which must keep reading as fine.
  const CHARGE_AT = 1792929600; // some future second

  it('names the card doing the charging', async () => {
    razorpay(
      { status: 'active', customer_id: 'cust_TUTRRifeA3F1fc', charge_at: CHARGE_AT, current_end: CHARGE_AT },
      { items: [{ method: 'card', recurring: true, card: { network: 'Visa', last4: '8940', expiry_month: 1, expiry_year: 2099 } }] },
    );
    const info = await paymentMethodFor(sub());

    expect(info.state).toBe('active');
    expect(info.label).toBe('Visa •••• 8940');
    expect(info.nextChargeAt).toBe(new Date(CHARGE_AT * 1000).toISOString());
  });

  it('hides a tokenised placeholder expiry rather than stating a falsehood', async () => {
    // Razorpay returns 01/2099 for a network token. The customer's card does
    // not expire in 2099, and printing it would be a lie on a billing page.
    razorpay(
      { status: 'active', customer_id: 'cust_x', charge_at: CHARGE_AT, current_end: CHARGE_AT },
      { items: [{ recurring: true, card: { network: 'Visa', last4: '8940', expiry_month: 1, expiry_year: 2099 } }] },
    );
    expect((await paymentMethodFor(sub())).expiry).toBeNull();
  });

  it('shows a real expiry when there is one', async () => {
    razorpay(
      { status: 'active', customer_id: 'cust_x', charge_at: CHARGE_AT, current_end: CHARGE_AT },
      { items: [{ recurring: true, card: { network: 'Visa', last4: '4242', expiry_month: 7, expiry_year: 2029 } }] },
    );
    expect((await paymentMethodFor(sub())).expiry).toBe('07/2029');
  });

  it('prefers the recurring token over a one-off card', async () => {
    // A customer may hold tokens from one-off payments that renew nothing.
    // Naming one of those would point at the wrong card.
    razorpay(
      { status: 'active', customer_id: 'cust_x', charge_at: CHARGE_AT, current_end: CHARGE_AT },
      { items: [
        { recurring: false, card: { network: 'Amex', last4: '0005' } },
        { recurring: true, card: { network: 'Visa', last4: '8940' } },
      ] },
    );
    expect((await paymentMethodFor(sub())).last4).toBe('8940');
  });

  it('treats an authenticated mandate as live', async () => {
    // Mandate authorised, first charge not yet landed. That is a working
    // subscription and must not read as a problem.
    razorpay({ status: 'authenticated', customer_id: 'cust_x', charge_at: CHARGE_AT, current_end: null });
    expect((await paymentMethodFor(sub())).state).toBe('active');
  });

  it('reports a cancelled subscription as inactive, not as awaiting anything', async () => {
    razorpay({ status: 'cancelled', customer_id: 'cust_x', charge_at: null, current_end: null });
    expect((await paymentMethodFor(sub())).state).toBe('inactive');
  });
});

describe('Stripe', () => {
  it('maps incomplete to the same message as Razorpay created', async () => {
    // Different word, same thing to tell the customer: the first payment
    // never succeeded and nothing will renew.
    stripeRequest.mockResolvedValue({ status: 'incomplete', items: { data: [] } });
    const info = await paymentMethodFor(sub({
      gateway: 'stripe', gatewaySubscriptionId: null, stripeSubscriptionId: 'sub_1UJ',
    }));
    expect(info.state).toBe('awaiting_authorisation');
    expect(info.gateway).toBe('stripe');
  });

  it('names the card on a live subscription', async () => {
    stripeRequest.mockImplementation((path: string) => Promise.resolve(
      path.startsWith('/payment_methods')
        ? { card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } }
        : { status: 'active', default_payment_method: 'pm_1', items: { data: [{ current_period_end: 1792929600 }] } },
    ));
    const info = await paymentMethodFor(sub({
      gateway: 'stripe', gatewaySubscriptionId: null, stripeSubscriptionId: 'sub_1UJ',
    }));
    expect(info.label).toBe('Visa •••• 4242');
    expect(info.expiry).toBe('04/2030');
    expect(info.state).toBe('active');
  });
});

describe('when there is nothing to read', () => {
  it('says none for a plan set by hand with no gateway subscription', async () => {
    // A BMS-set plan. Distinct from awaiting_authorisation: nobody started a
    // checkout at all, so there is no mandate to chase.
    const info = await paymentMethodFor(sub({ gatewaySubscriptionId: null, gateway: null }));
    expect(info.state).toBe('none');
    expect(razorpayRequest).not.toHaveBeenCalled();
  });

  it('says unknown when the gateway cannot be reached', async () => {
    /*
     * The distinction that matters on a billing page. 'none' asserts there is
     * no payment method; 'unknown' admits we could not check. Reporting an
     * outage as 'none' would tell a paying customer their card is missing.
     */
    razorpayRequest.mockRejectedValue(new Error('ETIMEDOUT'));
    const info = await paymentMethodFor(sub());
    expect(info.state).toBe('unknown');
    expect(info.label).toBeNull();
  });

  it('never throws, so a gateway outage cannot take Billing down', async () => {
    stripeRequest.mockRejectedValue(new Error('503'));
    await expect(paymentMethodFor(sub({
      gateway: 'stripe', gatewaySubscriptionId: null, stripeSubscriptionId: 'sub_x',
    }))).resolves.toBeDefined();
  });
});
