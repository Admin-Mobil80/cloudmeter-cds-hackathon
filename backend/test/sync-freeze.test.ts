import { syncFrozen, currentPeriod, TRIAL_DAYS } from '../functions/shared/subscription-period';
import { statusGrantsAccess } from '../functions/shared/subscription';

/**
 * When cost syncing stops.
 *
 * Two independent conditions have to be caught — an elapsed period and a
 * failed card — and neither can see what the other does. These tests pin both,
 * and pin the cases that must NOT freeze, which is where the damage would be:
 * a frozen trial is a signup that never sees data, and a frozen undateable
 * plan is a paying customer punished for a missing field.
 */

const NOW = new Date('2026-09-02T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe('a failed card', () => {
  it('freezes even while the paid period is still open', () => {
    // The case a date check cannot see: Razorpay has halted the mandate but
    // the period runs for another three weeks.
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(21), subscriptionStatus: 'past_due',
    }, NOW)).toBe('payment_failed');
  });

  it('freezes a past_due account whose period has also elapsed', () => {
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(-5), subscriptionStatus: 'past_due',
    }, NOW)).toBe('payment_failed');
  });
});

describe('an elapsed period', () => {
  it('freezes a lapsed trial', () => {
    expect(syncFrozen({ trialEndsAt: days(-1), createdAt: days(-8) }, NOW)).toBe('expired');
  });

  it('freezes an unrenewed subscription', () => {
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(-1), subscriptionStatus: 'active',
    }, NOW)).toBe('expired');
  });
});

describe('what must keep syncing', () => {
  it('does not freeze a live trial', () => {
    // The trap. A trial carries no subscriptionStatus at all, so any rule
    // written on status alone would freeze every new signup on day one.
    const trial = { createdAt: days(-1), trialEndsAt: days(TRIAL_DAYS - 1) };
    expect(trial).not.toHaveProperty('subscriptionStatus');
    expect(syncFrozen(trial, NOW)).toBeNull();
  });

  it('does not freeze a trial signed up moments ago with no stored end', () => {
    expect(syncFrozen({ createdAt: days(0) }, NOW)).toBeNull();
  });

  it('does not freeze a healthy subscription', () => {
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(21), subscriptionStatus: 'active',
    }, NOW)).toBeNull();
  });

  it('does not freeze a plan missing its end date', () => {
    // currentPeriod returns null here rather than falling back to the trial
    // clock. Refusing to refresh a paying customer over a missing field is the
    // wrong way to fail; renewal-sweep reports it for a human instead.
    const undateable = { planId: 'growth', currentPeriodEnd: null, createdAt: days(-400) };
    expect(currentPeriod(undateable, NOW)).toBeNull();
    expect(syncFrozen(undateable, NOW)).toBeNull();
  });

  it('keeps syncing a cancelled subscription until the period it paid for ends', () => {
    // Cancel-at-period-end. They have paid through the date; the date governs.
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(10), subscriptionStatus: 'canceled',
    }, NOW)).toBeNull();
    expect(syncFrozen({
      planId: 'growth', currentPeriodEnd: days(-1), subscriptionStatus: 'canceled',
    }, NOW)).toBe('expired');
  });
});

describe('freezing is not the same as losing entitlement', () => {
  it('a failed card stops syncing but keeps plan access', () => {
    // The blast-radius guard. past_due still grants access, so the portal,
    // plan limits and the BMS delete guard are unaffected by the freeze.
    // If someone ever removes past_due from ACTIVE_STATUSES, this fails and
    // says why.
    const tenant = {
      planId: 'growth', currentPeriodEnd: days(21), subscriptionStatus: 'past_due',
    };
    expect(syncFrozen(tenant, NOW)).toBe('payment_failed');
    expect(statusGrantsAccess(tenant.subscriptionStatus)).toBe(true);
  });

  it('a live trial has no access-granting status yet still syncs', () => {
    expect(statusGrantsAccess(null)).toBe(false);
    expect(syncFrozen({ createdAt: days(-1), trialEndsAt: days(6) }, NOW)).toBeNull();
  });
});
