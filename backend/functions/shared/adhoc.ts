import { MonthlySnapshot, buildSnapshots, monthKeyOf, monthStart } from './providers/types';

/**
 * Subscriptions that no billing API can report — Claude Pro seats, ChatGPT
 * Plus, Cursor, Midjourney. Entered by hand once and carried forward each
 * month, so they sit in the same ledger as AWS and Azure instead of a
 * spreadsheet nobody opens.
 *
 * There is nothing to poll, so an adhoc account is stored with
 * `dataSource: 'adhoc'` and the sweep skips it — it only syncs `'live'`.
 * Snapshots are recomputed whenever the items change, which is the only moment
 * the numbers can move.
 */
export interface AdhocItem {
  id: string;
  /** The tool, as the customer would say it: "Claude Pro". */
  name: string;
  /**
   * Individual — one person's own subscription. Shared — one subscription
   * several people use. It changes nothing about the arithmetic; `amount` is
   * the line total either way. It is recorded because "who is this for" is the
   * question asked when someone leaves and their tools need cancelling.
   */
  type: 'individual' | 'shared';
  /**
   * Who uses it. One name for individual, several for shared.
   *
   * Deliberately NOT a multiplier: three people each paying for Claude Pro is
   * three lines, not one line with three names. Making the count silently
   * multiply the cost is the kind of rule that produces a wrong total nobody
   * can explain.
   */
  subscribers: string[];
  /**
   * The workspace users behind `subscribers`, resolved server-side when the
   * line is written.
   *
   * `subscribers` is free text — a display name someone picked or typed — and
   * a display name is not an identity. Two people can share one, and anyone
   * renaming themselves would silently lose their own lines. A Member is only
   * shown, and only allowed to change, the lines they appear in, so that test
   * has to run against something stable.
   *
   * Absent on lines written before this existed. Those stay visible to Owners
   * and Admins and invisible to Members, which is the safe direction to fail:
   * a Member seeing somebody else's spend is the thing worth preventing.
   */
  subscriberUserIds?: string[];
  /**
   * Charge per `cadence`, in USD — the same base every provider reports in.
   *
   * Where `currency` is set this is the converted equivalent, worked out once
   * when the line was saved and never again. It exists so a rupee
   * subscription can be added to a dollar cloud bill in one total; it is
   * never what the subscriber is shown.
   */
  amount: number;
  /**
   * What the subscriber actually pays, in the currency they actually pay in.
   *
   * Stored because converting is not the same as knowing. A vendor charging
   * ₹1,999 is not charging $20 × today's rate, and re-deriving the rupees on
   * every page load made a fixed subscription drift day to day. When these
   * are present the card shows them verbatim and converts nothing.
   *
   * Absent on lines written before this existed, and on any line entered in
   * USD, where `amount` already is the paid figure.
   */
  paidAmount?: number;
  /** ISO code for `paidAmount` — "INR". */
  paidCurrency?: string;
  /** The rate used to fill `amount`, kept so the arithmetic can be audited. */
  paidRate?: number;
  /**
   * How often the charge recurs — every month, or every twelve.
   *
   * Not on the original field list, but without it an annual price would be
   * read as a monthly one and report twelve times the real cost, with nothing
   * to catch it. It decides when the charge falls, not how much: a yearly plan
   * is charged in full in its renewal month and in no other.
   */
  cadence: 'monthly' | 'yearly';
  /** First month this is charged, `yyyy-MM-dd`. */
  startsAt: string;
  /**
   * Last month this is charged, or null for open-ended.
   *
   * Past this date the item stops counting and is flagged for review rather
   * than quietly continuing. An end date is an explicit statement that the
   * charge stops; carrying on would invent spend for a tool that may well have
   * been cancelled. If it renewed, extending the date is one edit — and the
   * review flag is what prompts it.
   */
  endsAt: string | null;
  note?: string | null;
  /**
   * When this line was last created or edited, ISO.
   *
   * Exists for one reason: an open-ended subscription never stops being
   * charged, so a tool cancelled months ago goes on reporting its cost with
   * nothing to signal that it shouldn't. The review flag can't catch it — that
   * only fires on an end date that has passed, and this line has none. Knowing
   * when someone last looked at it is what lets the app ask.
   *
   * Optional because lines written before this existed have no value; those
   * fall back to startsAt, which is the last date anyone certainly confirmed.
   */
  updatedAt?: string;
}

/**
 * What one item costs in a month it is charged in.
 *
 * The full amount, whatever the cadence. An annual plan used to be divided by
 * twelve and carried across the year, which reported a cost in eleven months
 * where no money changed hands — the payment happens once, on the renewal
 * date, and belongs to that month like any other. chargedIn() is what keeps it
 * out of the other eleven.
 */
export function chargeAmount(item: Pick<AdhocItem, 'amount'>): number {
  return Number(item.amount) || 0;
}

/** `yyyy-MM` for a `yyyy-MM-dd` date, ignoring the day. */
function monthOf(date: string): string {
  return String(date ?? '').slice(0, 7);
}

/** Whether the end date has already passed — what flags a line for review. */
export function hasEnded(item: Pick<AdhocItem, 'endsAt'>, now = new Date()): boolean {
  return !!item.endsAt && item.endsAt < now.toISOString().slice(0, 10);
}

/**
 * How many distinct people are on a tool today.
 *
 * Counts people, not lines: one person on both Pro and a Team seat is one
 * user of the tool, and a shared line naming four people is four. Matched on
 * the trimmed, case-folded name, because the field is typed and "Lena" and
 * "lena" are plainly the same colleague.
 *
 * Today, strictly: a lapsed line does not count, and neither does one that
 * has not begun. Counting future seats was the first attempt, on the argument
 * that a renewal booked in advance should not read as a departure — but it
 * put "1 user" on a Cursor account whose only two lines had ended in
 * September and would restart in October, beside a spend of zero on the same
 * row and a card showing nothing running. A count that disagrees with the
 * money beside it is worse than one that shows a gap, and the gap is real:
 * in that window nobody is paying for the tool.
 */
export function subscriberCount(items: AdhocItem[], now = new Date()): number {
  const today = now.toISOString().slice(0, 10);
  const people = new Set<string>();
  for (const item of items ?? []) {
    if (hasEnded(item, now)) continue;
    if (item.startsAt && item.startsAt > today) continue;
    for (const name of item.subscribers ?? []) {
      const key = String(name ?? '').trim().toLowerCase();
      if (key) people.add(key);
    }
  }
  return people.size;
}

/**
 * How many subscriptions are running on a tool today.
 *
 * The companion figure to subscriberCount, and deliberately a different
 * question: that one counts people, this one counts lines. Three colleagues
 * each on their own Claude Pro is 3 users and 3 subscriptions; one shared
 * Team seat naming those same three is 3 users and 1 subscription. The two
 * together say what one of them alone cannot — whether a tool is being bought
 * once or over and over, which is the whole case for consolidating it.
 *
 * Shares subscriberCount's window to the letter: a lapsed line does not
 * count, and neither does one that has not begun. Two figures on one row
 * disagreeing about which lines are live would be worse than either figure
 * missing, so the rule is not restated here — the same two guards, in the
 * same order, against the same `today`.
 */
export function subscriptionCount(items: AdhocItem[], now = new Date()): number {
  const today = now.toISOString().slice(0, 10);
  let live = 0;
  for (const item of items ?? []) {
    if (hasEnded(item, now)) continue;
    if (item.startsAt && item.startsAt > today) continue;
    live++;
  }
  return live;
}

/** Whole months from one `yyyy-MM` to another. Negative if `to` is earlier. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** Days in a given month, so a renewal on the 31st survives February. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The renewal date that falls inside `monthKey`, or null if none does.
 *
 * A subscription is paid on its start date and again on that day each month.
 * One starting 26 August renews on 26 September, 26 October, and so on; the
 * day is clamped where the month is too short, so a 31 January start renews on
 * 28 February.
 */
function renewalDateIn(item: AdhocItem, monthKey: string): string | null {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return null;
  const day = Number(String(item.startsAt).slice(8, 10));
  if (!day) return null;
  const clamped = Math.min(day, daysInMonth(y, m));
  return `${monthKey}-${String(clamped).padStart(2, '0')}`;
}

/**
 * Whether an item is charged in a given month.
 *
 * A monthly subscription is paid once, on its renewal date, and that payment
 * belongs to the month it was made in — not spread across the period it
 * covers. So one running 15 August to 14 September was paid on 15 August and
 * shows its whole cost in August; September carries nothing, because no
 * payment was made in September. The renewal on 15 September never happens —
 * it falls past the end date.
 *
 * The end date is exclusive: it marks the last day covered, not a day money
 * moves. One running 26 August to 26 September is therefore a single payment
 * in August, not two — which is what "26 Aug -> 26 Sep" means to the person
 * typing it in. The same rule shortens a longer line by its final renewal:
 * 26 August to 26 October is charged in August and September only.
 *
 * That is also why this takes no `now`. An earlier version excluded ended
 * subscriptions from the *current* month only, which fixed the visible symptom
 * but meant a month's reported figure changed once that month was behind us.
 * Deciding from the dates alone gives the same answer whenever it is asked.
 *
 * An annual plan works the same way, twelve months apart: paid once in its
 * renewal month and charged nothing in the eleven between. It used to be
 * divided by twelve and carried across the year, which reported a cost in
 * eleven months where no money had moved.
 */
export function chargedIn(item: AdhocItem, monthKey: string): boolean {
  if (!item.startsAt) return false;
  if (monthKey < monthOf(item.startsAt)) return false;
  if (item.endsAt && monthKey > monthOf(item.endsAt)) return false;

  // A yearly plan only renews on its anniversary month; the eleven in between
  // hold no payment at all.
  if (item.cadence === 'yearly' && monthsBetween(monthOf(item.startsAt), monthKey) % 12 !== 0) {
    return false;
  }

  const renewal = renewalDateIn(item, monthKey);
  if (!renewal) return false;
  if (renewal < item.startsAt) return false;

  // The end date is the last day the subscription *covers*, never a day it is
  // charged on. "26 Aug -> 26 Sep" is how people write a single month bought on
  // the 26th, so treating the end date as a chargeable renewal billed them
  // twice for one payment.
  //
  // `renewal > item.startsAt` keeps the opening payment out of this: an item
  // whose start and end are the same day was still paid for on the day it
  // began, and validation permits that (only endsAt < startsAt is rejected).
  // Without the guard that first, real payment would disappear.
  if (item.endsAt && renewal >= item.endsAt && renewal > item.startsAt) return false;
  return true;
}

/**
 * How long an open-ended subscription may sit untouched before the app asks
 * whether it is still being paid for.
 *
 * Six months because that is long enough not to nag about a seat somebody
 * reviews yearly, and short enough that a cancelled tool doesn't spend a whole
 * financial year inflating reported spend.
 */
export const CHECK_IN_MONTHS = 6;

/**
 * Whether an open-ended line has gone long enough without being looked at that
 * it is worth confirming.
 *
 * Only open-ended lines: one with an end date already stops on its own, and
 * needsReview() prompts when that date passes. This is the case nothing else
 * can see — a charge with no natural end, which keeps counting whether or not
 * anyone is still paying it.
 */
/**
 * Whether a line belongs to a given user.
 *
 * The single test behind both halves of a Member's access: which lines they
 * are shown, and which they may change. Keeping it in one function is what
 * stops those two drifting apart — a line a Member can see but not edit, or
 * worse, edit but not see, would both be bugs nobody would think to look for.
 *
 * A line with no resolved ids belongs to nobody. See `subscriberUserIds`.
 */
export function isSubscriber(item: AdhocItem, userId: string): boolean {
  return Array.isArray(item.subscriberUserIds) && item.subscriberUserIds.includes(userId);
}

export function needsCheckIn(item: AdhocItem, now = new Date()): boolean {
  if (item.endsAt) return false;
  const since = (item.updatedAt || item.startsAt || '').slice(0, 10);
  if (!since) return false;

  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - CHECK_IN_MONTHS, now.getUTCDate()));
  return since < cutoff.toISOString().slice(0, 10);
}

/**
 * Items whose end date has passed, newest first.
 *
 * Surfaced in the app and the digest so an ended subscription is a decision
 * rather than a silent drop in reported spend.
 */
export function needsReview(items: AdhocItem[], now = new Date()): AdhocItem[] {
  return items
    .filter((i) => hasEnded(i, now))
    .sort((a, b) => String(b.endsAt).localeCompare(String(a.endsAt)));
}

/**
 * Six months of snapshots built from the items alone.
 *
 * Each item is a "service", which is what makes this work everywhere else
 * without a special case: the account page's service breakdown, the dashboard
 * roll-up and the digest all read serviceBreakdown and neither know nor care
 * that these figures were typed rather than fetched.
 */
export function adhocSnapshots(items: AdhocItem[], months: number, now = new Date()): MonthlySnapshot[] {
  const monthly: Array<{ date: Date; services: Array<{ name: string; spend: number }> }> = [];

  for (let i = months - 1; i >= 0; i--) {
    const date = monthStart(now, -i);
    const key = monthKeyOf(date);
    const services = items
      .filter((item) => chargedIn(item, key))
      .map((item) => ({ name: item.name, spend: chargeAmount(item) }))
      .filter((s) => s.spend > 0);

    monthly.push({ date, services });
  }

  return buildSnapshots(monthly);
}

/**
 * One person's share of an account's current month.
 *
 * The account's own `spend` column is the whole workspace's, which is right
 * for the roll-up and wrong to hand a Member — it would quote a figure made up
 * mostly of lines they are not allowed to see, in the same column that reads
 * as "yours" beside every other account.
 */
export function ownMonthSpend(items: AdhocItem[], userId: string, now = new Date()): number {
  return currentMonthSpend(items.filter((i) => isSubscriber(i, userId)), now);
}

/** What the account record's `spend` column should read — the current month. */
export function currentMonthSpend(items: AdhocItem[], now = new Date()): number {
  const key = monthKeyOf(now);
  return items
    .filter((item) => chargedIn(item, key))
    .reduce((sum, item) => sum + chargeAmount(item), 0);
}
