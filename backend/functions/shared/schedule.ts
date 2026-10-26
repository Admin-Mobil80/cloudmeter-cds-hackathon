/**
 * When notifications fire, and why.
 *
 * Two constraints shape this:
 *
 * 1. **Provider lag.** Cost APIs are hours behind. AWS Cost Explorer typically
 *    posts a day's usage 8–24h after it happens, and keeps adjusting it for up
 *    to another day as usage records finalise. So a digest must report the last
 *    *complete* day, never "today so far" — otherwise every morning's message
 *    would claim spend had collapsed overnight.
 *
 * 2. **The reader's clock.** A digest is only useful if it lands when someone's
 *    actually going to read it — end of the workday by default, which means we
 *    need the tenant's timezone — an account in Sydney and one in San Francisco
 *    share no useful UTC hour.
 */

/** Local hour of day a daily digest is sent, unless the tenant changes it. */
export const DEFAULT_DIGEST_HOUR = 19;

/** IANA zone assumed when a tenant hasn't set one. */
export const DEFAULT_TIMEZONE = 'UTC';

/**
 * How stale the newest stored day may be before a digest is worth suppressing.
 *
 * Rather than modelling each provider's lag with a constant, the digest asks a
 * question we can actually answer: which day do we *hold* complete data for?
 * Provider lag then takes care of itself — if AWS hasn't posted yesterday yet,
 * we simply don't have the row, and the digest reports the most recent day we
 * do have, naming the date so nobody mistakes it for today.
 *
 * This matters most in the far east. A Sydney tenant's 10:00 local is 00:30
 * UTC, hours before Cost Explorer finishes posting the previous day — a fixed
 * "send yesterday's numbers" rule would mail them a half-empty day every
 * morning.
 *
 * Beyond this many days behind, the data is too old to be worth a daily
 * digest; that's a broken sync to report, not a cost summary to send.
 */
export const MAX_DIGEST_STALENESS_DAYS = 3;

/**
 * Validates an IANA timezone using the runtime's own tz database, so the list
 * can't drift out of date the way a hardcoded array would.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(tz: unknown): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

export function normalizeDigestHour(hour: unknown): number {
  const n = Number(hour);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_DIGEST_HOUR;
}

/** The hour (0–23) it currently is in `timezone`. */
export function localHourIn(timezone: string, now = new Date()): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  // Intl renders midnight as "24" in some locales/engines; normalise it.
  return Number(formatted) % 24;
}

/** A stored daily row, reduced to what deciding "is this reportable" needs. */
export interface DayFreshness {
  dayKey: string;
  /** When the row was captured. Absent on rows written before this existed. */
  syncedAt?: string | null;
}

/**
 * The newest stored day that is safe to report, given what we actually hold.
 *
 * `days` is what we have rows for. The answer is the newest one that is both
 * over — today itself is always partial, and yesterday may not have arrived —
 * and actually observed after it ended.
 *
 * That second condition is the one that matters in practice. A row exists for
 * a day as soon as any sync touches it, including a sync that ran while the
 * day was still open, and such a row holds a partial figure — usually zero,
 * because Cost Explorer reports almost nothing for a day in progress. Judging
 * on the calendar alone, the digest quoted those as finished totals: a real
 * tenant was mailed "Spend on 2 Sept: ₹0, month to date ₹0, down 100%" while
 * the portal showed the correct $2.49 and $7.07, because the portal refreshes
 * on view and the digest only ever read what was already stored.
 *
 * A day that fails the freshness test is skipped rather than corrected, and
 * the search falls back to the previous one — the same behaviour gaps already
 * get. Reporting yesterday's real figures a day late is a nuisance; reporting
 * today's imaginary zero destroys trust in every number we send.
 */
export function reportableDay(
  days: DayFreshness[],
  timezone: string,
  now = new Date(),
): string | null {
  const availableDays = days
    // A row with no `syncedAt` predates this field. Treated as trustworthy so
    // that shipping this does not silence every digest until each account has
    // resynced; the check starts biting as rows are rewritten, which happens
    // on every sync because persistDailySnapshots rewrites the whole window.
    .filter((d) => d.syncedAt == null || observedAfterClose(d.dayKey, d.syncedAt))
    .map((d) => d.dayKey);
  // Two separate conditions have to hold, and they are not the same date.
  //
  // Cost Explorer buckets DAILY data on UTC boundaries, so a stored dayKey is a
  // UTC calendar day and is only finished once the UTC date has moved past it.
  // Comparing solely against the tenant's local date got this wrong east of
  // UTC: at 02:00 IST on the 2nd it is still the 1st in UTC, so "2026-09-01"
  // passed a `< localToday` test while that UTC day was still accruing, and the
  // digest reported a part-day as complete. Ahead of UTC the local date is the
  // stricter of the two, and reporting a day the tenant has not lived through
  // yet would be its own kind of wrong — so the earlier date governs.
  const localToday = localDateIn(timezone, now);
  const utcToday = localDateIn('UTC', now);
  const cutoff = localToday < utcToday ? localToday : utcToday;
  const past = availableDays.filter((d) => d < cutoff).sort();
  return past.length ? past[past.length - 1] : null;
}

/**
 * Whether a row was captured after its own UTC day finished.
 *
 * Stored dayKeys are UTC calendar days, so the day ends at the next midnight
 * UTC. An unparseable timestamp is treated as not-observed rather than
 * trusted: a malformed value is a reason to fall back to the previous day,
 * not to quote a figure we cannot vouch for.
 */
export function observedAfterClose(dayKey: string, syncedAt: string): boolean {
  const observed = Date.parse(syncedAt);
  if (Number.isNaN(observed)) return false;
  const dayEnds = Date.parse(`${dayKey}T00:00:00Z`) + 86_400_000;
  return observed >= dayEnds;
}

/** How many days behind the tenant's local today a given day is. */
export function daysBehind(dayKey: string, timezone: string, now = new Date()): number {
  const today = Date.parse(`${localDateIn(timezone, now)}T00:00:00Z`);
  return Math.round((today - Date.parse(`${dayKey}T00:00:00Z`)) / 86_400_000);
}

/** The calendar date (yyyy-MM-dd) it currently is in `timezone`. */
export function localDateIn(timezone: string, now = new Date()): string {
  // en-CA formats as yyyy-MM-dd, which is exactly the key format used for
  // stored daily rows — no manual padding or reassembly needed.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Whether a tenant's digest is due right now.
 *
 * Called by an hourly sweep rather than a per-tenant EventBridge schedule.
 * One schedule per tenant would mean creating, updating and deleting a
 * scheduler resource on every signup, timezone change and account closure —
 * three more things to leave orphaned. A single hourly rule that asks each
 * tenant "is it your hour?" has no such lifecycle, and an hour's granularity
 * is all a daily digest needs.
 *
 * `lastSentDate` is the local date of the last digest, which makes the check
 * idempotent: a retry, or a sweep that runs twice in one hour, can't send
 * the same digest again.
 */
export function isDigestDue(
  tenant: { timezone?: string; digestHour?: number; lastDigestDate?: string },
  now = new Date(),
): { due: boolean; localDate: string; reason?: string } {
  const timezone = normalizeTimezone(tenant.timezone);
  const digestHour = normalizeDigestHour(tenant.digestHour);
  const localDate = localDateIn(timezone, now);

  if (localHourIn(timezone, now) !== digestHour) {
    return { due: false, localDate, reason: 'not the digest hour here' };
  }
  if (tenant.lastDigestDate === localDate) {
    return { due: false, localDate, reason: 'already sent today' };
  }
  return { due: true, localDate };
}
