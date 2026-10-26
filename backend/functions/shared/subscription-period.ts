/**
 * When a CloudMeter account's current access runs out.
 *
 * Every account has an end date — a trial's, or a paid period's. There is no
 * open-ended state by design: an account with no end date is one nobody ever
 * revisits, which is how a pilot quietly becomes a permanent free tier and how
 * a lapsed customer keeps full access indefinitely. Making the date mandatory
 * means every account is on somebody's calendar.
 *
 * Both kinds of end date are read through here so the renewal reminder, the
 * BMS list and the portal banner cannot disagree about when access lapses.
 */

/**
 * Length of the free trial, in days.
 *
 * The compiled-in default only. BMS can change it (see pricing.ts), and the
 * configured value is what account creation uses — this is the fallback for
 * callers that have no config to hand, such as dating an old account that
 * predates stored trial ends.
 */
export const TRIAL_DAYS = 7;

const DAY_MS = 86_400_000;

export type PeriodKind = 'trial' | 'subscription';

export interface Period {
  kind: PeriodKind;
  /** ISO timestamp access ends. */
  endsAt: string;
  /** Negative once it has passed. */
  daysLeft: number;
  expired: boolean;
}

/** A trial's end, derived from when the account was created. */
export function trialEndFrom(
  createdAt: string | null | undefined,
  days: number = TRIAL_DAYS,
): string | null {
  if (!createdAt) return null;
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return null;
  return new Date(start + days * DAY_MS).toISOString();
}

/**
 * The end date that actually governs this account right now.
 *
 * A paid period wins over a trial: someone who subscribes mid-trial is on the
 * subscription's clock, and their trial end is no longer a date anyone should
 * be reminded about.
 *
 * Returns null only for an account we genuinely cannot date — no stored end
 * and no creation timestamp — which the sweep reports rather than guessing at.
 */
export function currentPeriod(
  tenant: {
    planId?: string | null;
    currentPeriodEnd?: string | null;
    trialEndsAt?: string | null;
    createdAt?: string | null;
  },
  now = new Date(),
): Period | null {
  // A plan with no end date is not a trial that lapsed — it is a subscription
  // missing its date. Falling through to the trial clock would date it from
  // the account's creation and, for anything older than the trial length,
  // declare a paying customer expired: the renewal sweep would have emailed
  // "your trial has ended" to accounts on Growth. Undateable is the honest
  // answer, and the sweep reports it for a human to fix.
  if (tenant.planId && !tenant.currentPeriodEnd) return null;

  const paid = !!tenant.planId && !!tenant.currentPeriodEnd;
  const endsAt = paid
    ? tenant.currentPeriodEnd!
    : (tenant.trialEndsAt ?? trialEndFrom(tenant.createdAt));

  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;

  // Rounded up, so "0 days left" means today rather than "some time in the
  // last 24 hours" — a reminder that says 0 when there is still an afternoon
  // to act in reads as already-too-late.
  const daysLeft = Math.ceil((end - now.getTime()) / DAY_MS);

  return {
    kind: paid ? 'subscription' : 'trial',
    endsAt,
    daysLeft,
    expired: end <= now.getTime(),
  };
}

/** Why a tenant's data refreshes are paused. */
export type SyncFreeze = 'expired' | 'payment_failed';

/**
 * Whether to stop refreshing a tenant's cost data, and why.
 *
 * Deliberately separate from `isEntitled`. Entitlement answers "may this
 * account use the product", and is shared by /me, the BMS tenant list, the
 * billing page and the guard on tenant deletion. This answers a narrower
 * question — "is it still right to spend Cost Explorer calls on them" — and
 * the two must be free to differ: a customer whose card just failed keeps
 * their plan limits, their portal and their history, and only loses new data.
 * Folding this into the shared status set would strip all of that instead.
 *
 * Two conditions, neither sufficient alone:
 *
 *  - `past_due` catches a failed card *within* a paid period, which no date
 *    check can see. Both gateways produce it — Stripe's status is stored raw,
 *    and razorpay.ts maps `pending`/`halted` onto it.
 *  - An elapsed period catches a lapsed trial or an unrenewed subscription,
 *    which no status check can see: a trial carries no subscriptionStatus at
 *    all, so status alone would freeze every trial from the day it signed up.
 *
 * An account we cannot date is NOT frozen. `currentPeriod` returns null for a
 * plan missing its end date, and refusing to refresh a paying customer over a
 * missing field is the wrong way to fail — renewal-sweep already reports those
 * for a human to fix.
 */
export function syncFrozen(
  tenant: {
    planId?: string | null;
    currentPeriodEnd?: string | null;
    trialEndsAt?: string | null;
    createdAt?: string | null;
    subscriptionStatus?: string | null;
  },
  now = new Date(),
): SyncFreeze | null {
  if (tenant.subscriptionStatus === 'past_due') return 'payment_failed';
  return currentPeriod(tenant, now)?.expired ? 'expired' : null;
}

/**
 * One month on from a given date, for a manually-set plan that arrives without
 * an end date of its own.
 *
 * Clamps rather than rolling over: a period starting 31 January ends 28/29
 * February, not 3 March. Rolling into the next month would hand out a few free
 * days every time and drift further each cycle.
 */
export function oneMonthOn(from = new Date()): string {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < day) {
    // Overflowed into the following month — step back to that month's last day.
    d.setUTCDate(0);
  }
  return d.toISOString();
}

/**
 * The new end date when a subscription is renewed for another month.
 *
 * Extends from the current end when that is still in the future, so renewing
 * early does not cost the customer the days they have already paid for and
 * the billing cycle stays on the same day of the month. A period that has
 * already lapsed restarts from today instead — back-dating a renewal into a
 * window that has passed would hand over a month that is partly spent.
 */
export function renewFrom(currentEnd: string | null | undefined, now = new Date()): string {
  if (!currentEnd) return oneMonthOn(now);
  const end = Date.parse(currentEnd);
  if (Number.isNaN(end)) return oneMonthOn(now);
  return oneMonthOn(end > now.getTime() ? new Date(end) : now);
}

/**
 * The new trial end when a trial is extended by another full length.
 *
 * Same rule as a subscription renewal: from the current end when it is still
 * ahead, so extending early costs nobody the days they already had, and from
 * today once it has lapsed, so a re-opened trial is a whole one rather than a
 * window that expired days ago.
 *
 * `days` is whatever the trial is configured to at the moment of extending —
 * a 7-day trial extended after the setting moved to 10 gets 10, because the
 * decision being made now is "give them another trial", not "replay the old
 * one".
 */
export function extendTrialFrom(
  currentEnd: string | null | undefined,
  days: number,
  now = new Date(),
): string {
  const base = (() => {
    if (!currentEnd) return now;
    const end = Date.parse(currentEnd);
    if (Number.isNaN(end)) return now;
    return end > now.getTime() ? new Date(end) : now;
  })();
  return new Date(base.getTime() + days * DAY_MS).toISOString();
}
