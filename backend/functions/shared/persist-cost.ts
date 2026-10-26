import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

interface HasMonthKey { monthKey: string }
interface HasDayKey { dayKey: string }

// Daily rows are far more numerous than monthly ones, so they carry a TTL and
// age out on their own rather than growing the table forever. Comfortably
// longer than any window the UI offers, so nothing on screen can expire.
const DAILY_TTL_DAYS = 400;

export async function persistMonthlySnapshots(accountId: string, snapshots: HasMonthKey[]): Promise<void> {
  await Promise.all(snapshots.map(async (s) => {
    const Key = { PK: `ACCOUNT#${accountId}`, SK: `MONTHLY#${s.monthKey}` };
    const { tagBreakdownUnavailable, ...row } = s as HasMonthKey & {
      tagBreakdownUnavailable?: boolean;
      tagBreakdown?: Record<string, unknown>;
    };

    /**
     * The provider couldn't be asked for tags this time — a rate limit, a
     * timeout, a refused scope. Carry forward whatever is already stored
     * rather than replacing real history with an empty object.
     *
     * Every sync rewrites the whole window, so without this one refused call
     * erases every month at once. That is exactly how OpenAI's project
     * breakdown disappeared: the request was 429'd, the failure was silent,
     * and six months were overwritten with nothing.
     */
    if (tagBreakdownUnavailable) {
      try {
        const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key }));
        const kept = Item?.tagBreakdown;
        if (kept && Object.keys(kept).length > 0) row.tagBreakdown = kept as Record<string, unknown>;
      } catch (err) {
        // Losing the old breakdown is bad; failing the whole sync over it is
        // worse. Fall through and write what we have.
        console.error('Could not read existing tagBreakdown', (err as Error).message);
      }
    }

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...Key, ...row } }));
  }));
}

/**
 * How many trailing empty days may be treated as "not reported yet".
 *
 * Bounded deliberately. Beyond this an unbroken run of zeros stops being a
 * reporting delay and starts being the truth about an account that was shut
 * down, and refusing to record that would freeze its history at the last day
 * it ever spent anything. Three days covers every lag observed on prod — AWS
 * is the slowest and settles within two.
 */
export const MAX_UNREPORTED_TAIL_DAYS = 3;

/**
 * Drops the newest days that the provider has not actually reported yet.
 *
 * Cost Explorer answers for every day in the requested range whether or not it
 * has computed it, and an uncomputed day comes back as zero. Stored as-is,
 * that zero is indistinguishable from a day that genuinely cost nothing — and
 * everything downstream then states it as fact. On 2026-10-02 a customer was
 * told "Spend on 1 Oct: ₹0" for what turned out to be their most expensive day
 * of the month ($23.67, about 150% of a normal day); the same figures grew
 * under us afterwards, 3 Oct reading $0.00, then $11.12, then $11.49 as AWS
 * filled it in.
 *
 * Only the *trailing* run is dropped. A zero day with real spend after it has
 * been confirmed by a later answer and is genuinely a quiet day, so it stays.
 *
 * A window that is entirely zero is left alone: an account that costs nothing
 * every day is not waiting on anybody, and trimming it would leave a dormant
 * account with no rows at all and silence its digest.
 *
 * Nothing is deleted — days already stored keep whatever they hold. This only
 * declines to *write* a figure that has not arrived, which is what lets
 * `reportableDay` fall back to the last day actually answered for.
 */
export function trimUnreportedTail<T extends HasDayKey>(snapshots: T[]): T[] {
  const spendOf = (s: T) => Number((s as T & { totalSpend?: unknown }).totalSpend ?? 0);
  const ordered = [...snapshots].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  if (!ordered.some((s) => spendOf(s) > 0)) return snapshots;

  let drop = 0;
  while (
    drop < MAX_UNREPORTED_TAIL_DAYS
    && drop < ordered.length
    && spendOf(ordered[ordered.length - 1 - drop]) <= 0
  ) drop += 1;

  return drop === 0 ? snapshots : ordered.slice(0, ordered.length - drop);
}

export async function persistDailySnapshots(accountId: string, snapshots: HasDayKey[]): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + DAILY_TTL_DAYS * 86400;

  /**
   * When this row was captured from the provider.
   *
   * A day's row can exist while holding a partial figure: a sync that runs at
   * noon writes that day with whatever has accrued so far, and Cost Explorer
   * reports close to nothing for a day still in progress. The calendar alone
   * cannot tell those apart from a genuinely quiet day — both look like a
   * complete day with a small number — so the digest needs to know not just
   * which day a row is for, but when we actually looked.
   *
   * Deliberately not derived from `expiresAt`: that works today only because
   * the TTL is a fixed 400 days, and would silently start lying the moment
   * anyone changed DAILY_TTL_DAYS.
   */
  const syncedAt = new Date().toISOString();

  // Days the provider has not answered for yet are left unwritten rather than
  // recorded as zero — see trimUnreportedTail.
  const writable = trimUnreportedTail(snapshots);

  // Chunked rather than one giant Promise.all: 90 days x N accounts of
  // unbounded concurrency is a good way to get throttled.
  const CHUNK = 25;
  for (let i = 0; i < writable.length; i += CHUNK) {
    await Promise.all(writable.slice(i, i + CHUNK).map(async (s) => {
      /*
       * A zero never overwrites a figure already stored.
       *
       * The trailing trim handles the common case, but a provider can also
       * return zero for an older day it has temporarily lost — a partial
       * outage, a permissions blip — and every sync rewrites the whole
       * window. Replacing a real $11.49 with $0 would be the same bug one day
       * further back, where nothing would catch it.
       *
       * Only read for rows that are actually zero, so a normal sync costs no
       * extra calls.
       */
      const Key = { PK: `ACCOUNT#${accountId}`, SK: `DAILY#${s.dayKey}` };
      const spend = Number((s as HasDayKey & { totalSpend?: unknown }).totalSpend ?? 0);
      if (spend <= 0) {
        try {
          const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key }));
          if (Number(Item?.totalSpend ?? 0) > 0) return;
        } catch (err) {
          // Keeping the old figure matters; failing the sync over it does not.
          console.error('Could not check existing daily row', (err as Error).message);
        }
      }
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        // `syncedAt` after the spread: a snapshot must never be able to
        // declare its own capture time and defeat the freshness check.
        Item: { ...Key, expiresAt, ...s, syncedAt },
      }));
    }));
  }
}
