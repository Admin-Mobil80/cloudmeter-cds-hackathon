/**
 * Not recording a day the provider has not answered for yet.
 *
 * Cost Explorer replies for every day in the requested range whether or not it
 * has computed it, and an uncomputed day comes back as zero. Written down,
 * that zero is indistinguishable from a day that genuinely cost nothing — and
 * the digest then states it as fact.
 *
 * On 2026-10-02 ACME were told "Spend on 1 Oct 2026: ₹0 / Month to date: ₹0
 * (down 100% vs the same point last month)". 1 October was in fact their most
 * expensive day of the month: $23.67, about 150% of a normal day, because the
 * 1st carries the monthly and reserved charges. The figures settled afterwards
 * — 3 October read $0.00, then $11.12, then $11.49 across successive syncs.
 *
 * Measured on prod the same week, the trailing day was partial for every live
 * AWS account, not just this one: Vandelay at 6% of a normal day, ACME 10%,
 * Umbrella 12%, AL STARK 23%, and Wayne Health and WONKA at exactly zero.
 */

import { trimUnreportedTail, MAX_UNREPORTED_TAIL_DAYS } from '../functions/shared/persist-cost';

type Snap = { dayKey: string; totalSpend: number };
const day = (d: string, totalSpend: number): Snap => ({ dayKey: d, totalSpend });

/** Drives the real trimUnreportedTail, and reports what would be stored. */
const kept = (snaps: Snap[]) => trimUnreportedTail(snaps).map((s) => s.dayKey);

describe('the day that has not been reported yet', () => {
  it('is not written, so nothing downstream can quote it', () => {
    expect(kept([
      day('2026-10-03', 11.49),
      day('2026-10-04', 8.33),
      day('2026-10-05', 0),
    ])).toEqual(['2026-10-03', '2026-10-04']);
  });

  it('drops a run of them, which is what 1 October was', () => {
    /*
     * The exact shape of the failure. Syncing on 2 October, AWS had answered
     * for September but not for the 1st or the 2nd. Both were stored as zero,
     * the 1st was judged reportable, and the digest announced ₹0.
     *
     * With the trim, the newest day actually answered for is 30 September —
     * two days behind, inside MAX_DIGEST_STALENESS_DAYS — so the digest
     * reports that real figure instead of inventing a zero.
     */
    expect(kept([
      day('2026-09-29', 15.91),
      day('2026-09-30', 15.22),
      day('2026-10-01', 0),
      day('2026-10-02', 0),
    ])).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('keeps a zero day that has real spend after it', () => {
    // Confirmed by a later answer: the provider has moved past this day and
    // still says nothing was spent, so it is a genuinely quiet day.
    expect(kept([
      day('2026-10-01', 23.67),
      day('2026-10-02', 0),
      day('2026-10-03', 11.49),
    ])).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('writes everything when the newest day has a figure', () => {
    const snaps = [day('2026-10-04', 8.33), day('2026-10-05', 1.2)];
    expect(kept(snaps)).toEqual(['2026-10-04', '2026-10-05']);
  });
});

describe('an account that genuinely costs nothing', () => {
  it('still records its zeros, so its digest is not silenced', () => {
    /*
     * Several prod accounts are legitimately zero every day — the WhatsApp
     * ones, for instance. They are not waiting on anybody, and trimming them
     * would leave a dormant account with no rows at all, which reads to the
     * digest sweep as "no reportable cost data" and skips the tenant.
     */
    expect(kept([
      day('2026-10-03', 0),
      day('2026-10-04', 0),
      day('2026-10-05', 0),
    ])).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
  });

  it('records its zeros once the run outlives any plausible delay', () => {
    // An account that really did stop spending. The trim is bounded, so its
    // history does not freeze at the last day it ever cost anything — the
    // older zeros are written, only the newest few wait for confirmation.
    const snaps = [
      day('2026-09-28', 15.0),
      day('2026-09-29', 0), day('2026-09-30', 0), day('2026-10-01', 0),
      day('2026-10-02', 0), day('2026-10-03', 0), day('2026-10-04', 0),
    ];
    expect(kept(snaps)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('never withholds more than the bound', () => {
    const snaps = [day('2026-09-28', 15.0), ...Array.from({ length: 20 }, (_, i) =>
      day(`2026-10-${String(i + 1).padStart(2, '0')}`, 0))];
    expect(snaps.length - trimUnreportedTail(snaps).length).toBe(MAX_UNREPORTED_TAIL_DAYS);
  });
});

describe('inputs that are not in order', () => {
  it('trims by date, not by array position', () => {
    // Providers are not required to return days in order, and trimming the end
    // of an unsorted array would drop whichever day happened to land last.
    expect(kept([
      day('2026-10-05', 0),
      day('2026-10-03', 11.49),
      day('2026-10-04', 8.33),
    ])).toEqual(['2026-10-03', '2026-10-04']);
  });

  it('treats a missing or unparseable total as nothing reported', () => {
    const snaps = [
      { dayKey: '2026-10-03', totalSpend: 11.49 },
      { dayKey: '2026-10-04' } as Snap,
    ];
    expect(kept(snaps)).toEqual(['2026-10-03']);
  });

  it('leaves an empty batch alone', () => {
    expect(trimUnreportedTail([])).toEqual([]);
  });

  it('does not treat a negative total as spend', () => {
    // Credits and refunds land as negatives. They are not evidence that the
    // day has been answered for.
    expect(kept([day('2026-10-03', 11.49), day('2026-10-04', -2)])).toEqual(['2026-10-03']);
  });
});
