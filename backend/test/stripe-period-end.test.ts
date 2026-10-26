import { periodEnd } from '../functions/api/billing/webhook';
import { currentPeriod } from '../functions/shared/subscription-period';

/**
 * Where Stripe keeps the renewal date.
 *
 * It moved off the subscription and onto its items — a subscription may hold
 * items on different cycles, so there is no single subscription-level answer
 * any more. The webhook kept reading the old top-level field, got undefined
 * from every event, and stored a null period end for every Stripe customer.
 *
 * That did not send anything wrong, because currentPeriod() refuses to date a
 * plan with no end rather than falling through to the trial clock. It did make
 * every paying Stripe customer undateable, which the last case here pins down.
 */

const AUG = 1_787_000_000; // seconds; a fixed point, value unimportant
const SEP = AUG + 30 * 86_400;

describe('reading the period end off a subscription', () => {
  it('takes it from the item, where Stripe now puts it', () => {
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      items: { data: [{ current_period_end: SEP }] },
    })).toBe(SEP);
  });

  it('still reads the old top-level field, for an older API version', () => {
    // The destination's API version is a dropdown someone can move. Dropping
    // to an older one should degrade to the old shape, not to no date at all.
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      current_period_end: SEP,
    })).toBe(SEP);
  });

  it('prefers the item when both are present', () => {
    // During the transition Stripe sends both, and the item is authoritative.
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      current_period_end: AUG,
      items: { data: [{ current_period_end: SEP }] },
    })).toBe(SEP);
  });

  it('takes the latest item, never the first', () => {
    /*
     * CloudMeter sells one item per subscription, so [0] would work today.
     * It would also quietly become a too-early renewal date the first time
     * that stops being true — billing a customer as lapsed while they are
     * still paying. The furthest end is the one the subscription runs to.
     */
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      items: { data: [{ current_period_end: AUG }, { current_period_end: SEP }] },
    })).toBe(SEP);
  });

  it('answers null rather than guessing when neither is there', () => {
    expect(periodEnd({ id: 'sub_1', customer: 'cus_1', status: 'active' })).toBeNull();
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [] },
    })).toBeNull();
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active', items: {},
    })).toBeNull();
  });

  it('ignores an item whose end is missing or not a number', () => {
    expect(periodEnd({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      items: { data: [{}, { current_period_end: SEP }] },
    })).toBe(SEP);
  });
});

describe('what the null did downstream', () => {
  const paid = { planId: 'starter', createdAt: '2026-01-01T00:00:00.000Z' };

  it('left a paying customer undateable — the bug, as it was', () => {
    expect(currentPeriod({ ...paid, currentPeriodEnd: null })).toBeNull();
  });

  it('dates them properly once the end is stored', () => {
    const end = new Date(SEP * 1000).toISOString();
    const period = currentPeriod(
      { ...paid, currentPeriodEnd: end },
      new Date(SEP * 1000 - 5 * 86_400_000),
    );
    expect(period).not.toBeNull();
    expect(period!.kind).toBe('subscription');
    expect(period!.endsAt).toBe(end);
    expect(period!.daysLeft).toBe(5);
    expect(period!.expired).toBe(false);
  });

  it('does not date them from signup, which would call them expired', () => {
    // The failure the null was protecting against: a January account on a paid
    // plan, judged by the trial clock, is months past its trial end.
    const period = currentPeriod({ ...paid, currentPeriodEnd: null });
    expect(period).toBeNull();
  });
});
