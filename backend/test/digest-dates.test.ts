import { reportableDay, daysBehind, localDateIn, observedAfterClose, isDigestDue } from '../functions/shared/schedule';
import { daysInMonth } from '../functions/shared/digest';

/**
 * Cost Explorer buckets DAILY data on UTC boundaries, so every stored dayKey is
 * a UTC calendar day. Most of what these tests pin down is the consequence of
 * that: which UTC day is finished, from the point of view of a tenant who is
 * not on UTC.
 */

const IST = 'Asia/Calcutta';           // UTC+5:30, ahead of UTC
const NY = 'America/New_York';         // UTC-4/-5, behind UTC

/** Every UTC day in [from, to], as stored dayKeys. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`);
       d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Rows as they exist on records written before `syncedAt` was introduced.
 * These must stay reportable, or deploying the freshness check would silence
 * every digest until each account had resynced.
 */
const unsynced = (days: string[]) => days.map((dayKey) => ({ dayKey }));

/** Rows observed 30h after each day started — i.e. 6h after it closed. */
const fresh = (days: string[]) => days.map((dayKey) => ({
  dayKey,
  syncedAt: new Date(Date.parse(`${dayKey}T00:00:00Z`) + 30 * 3_600_000).toISOString(),
}));

describe('reportableDay — UTC day completeness', () => {
  const available = daysBetween('2026-08-25', '2026-09-01');

  it('reports 31 Aug at the 19:00 IST digest hour on 1 Sep', () => {
    // 13:30Z = 19:00 IST. UTC day 31 Aug closed 13.5h earlier.
    expect(reportableDay(unsynced(available), IST, new Date('2026-09-01T13:30:00Z'))).toBe('2026-08-31');
  });

  it('does not report a UTC day that is still accruing, early morning IST', () => {
    // 20:30Z on 1 Sep is 02:00 IST on 2 Sep. Local date has rolled to the 2nd,
    // but UTC day 2026-09-01 does not end for another 3.5 hours. Reporting it
    // would quote a part-day as a complete one — the bug this guards.
    const t = new Date('2026-09-01T20:30:00Z');
    expect(localDateIn(IST, t)).toBe('2026-09-02');       // local has rolled over
    expect(localDateIn('UTC', t)).toBe('2026-09-01');     // UTC has not
    expect(reportableDay(unsynced(available), IST, t)).toBe('2026-08-31');
  });

  it('reports the UTC day once it truly closes', () => {
    // 00:30Z on 2 Sep — UTC day 1 Sep is now complete.
    expect(reportableDay(unsynced(available), IST, new Date('2026-09-02T00:30:00Z'))).toBe('2026-09-01');
  });

  it('west of UTC, never reports a day the tenant has not reached yet', () => {
    // 02:00Z on 2 Sep is 22:00 on 1 Sep in New York. UTC day 1 Sep is closed,
    // but locally it is still the 1st, so the 1st must not be reported.
    const t = new Date('2026-09-02T02:00:00Z');
    expect(localDateIn(NY, t)).toBe('2026-09-01');
    expect(reportableDay(unsynced(available), NY, t)).toBe('2026-08-31');
  });

  it('returns null when no day is complete yet', () => {
    expect(reportableDay(unsynced(['2026-09-01']), IST, new Date('2026-09-01T10:00:00Z'))).toBeNull();
  });

  it('skips gaps rather than inventing a day', () => {
    const gappy = ['2026-08-20', '2026-08-21', '2026-08-30'];
    expect(reportableDay(unsynced(gappy), IST, new Date('2026-09-01T13:30:00Z'))).toBe('2026-08-30');
  });
});

describe('reportableDay — was the row actually observed after the day ended', () => {
  const available = daysBetween('2026-08-25', '2026-09-02');
  const at = new Date('2026-09-03T13:30:00Z');      // 19:00 IST, the digest hour

  it('reports a day whose row was captured after it closed', () => {
    expect(reportableDay(fresh(available), IST, at)).toBe('2026-09-02');
  });

  it('skips a day whose row was captured while it was still running', () => {
    // The production bug. 2 Sep is over by the time the digest fires, so the
    // calendar check passes — but the row was written at midday on the 2nd and
    // holds a part-day figure, usually zero.
    const rows = fresh(available).map((r) => r.dayKey === '2026-09-02'
      ? { dayKey: r.dayKey, syncedAt: '2026-09-02T12:00:00Z' }
      : r);
    expect(reportableDay(rows, IST, at)).toBe('2026-09-01');
  });

  it('falls back past several unobserved days rather than inventing one', () => {
    const rows = fresh(available).map((r) => r.dayKey >= '2026-08-31'
      ? { dayKey: r.dayKey, syncedAt: `${r.dayKey}T09:00:00Z` }
      : r);
    expect(reportableDay(rows, IST, at)).toBe('2026-08-30');
  });

  it('still reports rows written before syncedAt existed', () => {
    // Or deploying this would silence every digest until each account resynced.
    expect(reportableDay(unsynced(available), IST, at)).toBe('2026-09-02');
  });

  it('treats an unparseable syncedAt as unobserved, not as trusted', () => {
    const rows = fresh(available).map((r) => r.dayKey === '2026-09-02'
      ? { dayKey: r.dayKey, syncedAt: 'not-a-date' }
      : r);
    expect(reportableDay(rows, IST, at)).toBe('2026-09-01');
  });

  it('returns null when nothing has been observed after closing', () => {
    const rows = available.map((d) => ({ dayKey: d, syncedAt: `${d}T06:00:00Z` }));
    expect(reportableDay(rows, IST, at)).toBeNull();
  });

  describe('regression: the Globex digest of 3 Sep 2026', () => {
    // Sent 13:31Z quoting "Spend on 2 Sept 2026: ₹0, month to date ₹0, down
    // 100%" while the portal showed $2.49 and $7.07. The row for 2 Sep existed
    // and the day was over; it had simply been captured at 16:05 on the 2nd,
    // before the day closed. 1 Sep had been observed properly.
    const rows = [
      { dayKey: '2026-09-02', syncedAt: '2026-09-02T16:05:17Z' },
      { dayKey: '2026-09-01', syncedAt: '2026-09-02T16:05:17Z' },
      { dayKey: '2026-08-31', syncedAt: '2026-09-02T16:05:17Z' },
    ];

    it('reports 1 Sep — real figures, a day late — instead of a false zero', () => {
      expect(reportableDay(rows, IST, new Date('2026-09-03T13:31:00Z'))).toBe('2026-09-01');
    });
  });
});

describe('the pre-digest refresh window', () => {
  /**
   * These times are the real cron minutes, not convenient ones.
   *
   * SyncSchedule is cron(minute: '5') and DigestSchedule cron(minute: '30'),
   * so the sweep asks this question at :05 UTC about a digest that fires at
   * :30 UTC. An earlier version of this suite asserted at 13:35 — a time the
   * sweep never runs — and so passed while production did the opposite: at
   * 13:05 UTC an IST tenant is in local hour 18, not 19, and the pull never
   * fired for a single Indian tenant. Three were a day behind on 6 Sep.
   *
   * Anchor every case to SYNC_AT / DIGEST_AT rather than a hand-picked time.
   */
  const SYNC_AT = new Date('2026-09-06T13:05:00Z');     // cron(minute: '5')
  const DIGEST_AT = new Date('2026-09-06T13:30:00Z');   // cron(minute: '30')
  const LEAD_MS = DIGEST_AT.getTime() - SYNC_AT.getTime();
  const lookAhead = (at: Date) => new Date(at.getTime() + LEAD_MS);

  const ist = { timezone: IST, digestHour: 19, lastDigestDate: undefined };

  it('the two schedules sit in different local hours at a half-hour offset', () => {
    // The fact that broke it: 13:05Z is 18:35 IST, 13:30Z is 19:00 IST.
    expect(localDateIn(IST, SYNC_AT)).toBe('2026-09-06');
    expect(isDigestDue(ist, SYNC_AT).due).toBe(false);     // asking about now
    expect(isDigestDue(ist, DIGEST_AT).due).toBe(true);    // asking about then
  });

  it('the sweep sees the digest as due when it looks ahead', () => {
    expect(isDigestDue(ist, lookAhead(SYNC_AT)).due).toBe(true);
  });

  it('works at a three-quarter-hour offset too', () => {
    // Nepal, UTC+5:45: 13:05Z is 18:50, 13:30Z is 19:15 — again different hours.
    const np = { timezone: 'Asia/Kathmandu', digestHour: 19, lastDigestDate: undefined };
    expect(isDigestDue(np, SYNC_AT).due).toBe(false);
    expect(isDigestDue(np, lookAhead(SYNC_AT)).due).toBe(true);
  });

  it('works at a whole-hour offset, which is where the old code accidentally passed', () => {
    const utc = { timezone: 'UTC', digestHour: 13, lastDigestDate: undefined };
    expect(isDigestDue(utc, SYNC_AT).due).toBe(true);
    expect(isDigestDue(utc, lookAhead(SYNC_AT)).due).toBe(true);
  });

  it('does not pull every hour — only the one before the digest', () => {
    const anHourEarlier = new Date(SYNC_AT.getTime() - 3_600_000);
    expect(isDigestDue(ist, lookAhead(anHourEarlier)).due).toBe(false);
  });

  it('stops being due once the digest has gone out, so no second pull', () => {
    expect(isDigestDue({ ...ist, lastDigestDate: '2026-09-06' },
      lookAhead(SYNC_AT)).due).toBe(false);
  });
});

describe('observedAfterClose', () => {
  it('accepts a capture after the UTC day ended', () => {
    expect(observedAfterClose('2026-09-02', '2026-09-03T00:00:01Z')).toBe(true);
  });

  it('rejects a capture during the day, and exactly at the boundary is fine', () => {
    expect(observedAfterClose('2026-09-02', '2026-09-02T23:59:59Z')).toBe(false);
    expect(observedAfterClose('2026-09-02', '2026-09-03T00:00:00Z')).toBe(true);
  });

  it('rejects a malformed timestamp', () => {
    expect(observedAfterClose('2026-09-02', 'whenever')).toBe(false);
  });
});

describe('daysBehind', () => {
  it('counts a same-day-boundary report as one day behind', () => {
    expect(daysBehind('2026-08-31', IST, new Date('2026-09-01T13:30:00Z'))).toBe(1);
  });

  it('grows as data goes stale', () => {
    expect(daysBehind('2026-08-28', IST, new Date('2026-09-02T13:30:00Z'))).toBe(5);
  });
});

describe('daysInMonth', () => {
  it('handles 31, 30 and 28 day months', () => {
    expect(daysInMonth('2026-08')).toBe(31);
    expect(daysInMonth('2026-07')).toBe(31);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-02')).toBe(28);
  });

  it('handles a leap February', () => {
    expect(daysInMonth('2028-02')).toBe(29);
  });
});
