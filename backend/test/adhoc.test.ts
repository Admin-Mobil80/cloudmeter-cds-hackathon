import {
  chargeAmount, chargedIn, needsReview, needsCheckIn, adhocSnapshots, currentMonthSpend,
  isSubscriber, hasEnded, AdhocItem,
} from '../functions/shared/adhoc';

/**
 * Adhoc subscriptions are typed in by hand, so the arithmetic here is the only
 * thing standing between a customer and a wrong number on their dashboard.
 * There is no API to disagree with.
 */

const NOW = new Date('2026-09-16T00:00:00Z');

function item(over: Partial<AdhocItem> = {}): AdhocItem {
  return {
    id: 'i1', name: 'Claude Pro', type: 'individual', subscribers: ['Rohan'],
    amount: 100, cadence: 'monthly', startsAt: '2026-05-01', endsAt: null, ...over,
  };
}

describe('chargeAmount', () => {
  it('is the full amount, whatever the cadence', () => {
    // An annual charge is paid once, in full. Dividing it by twelve reported a
    // cost in eleven months where no money had moved; chargedIn() is what
    // keeps it out of those months instead.
    expect(chargeAmount({ amount: 100 })).toBe(100);
    expect(chargeAmount({ amount: 1200 })).toBe(1200);
  });

  it('treats a missing or unparseable amount as zero rather than NaN', () => {
    expect(chargeAmount({ amount: undefined as never })).toBe(0);
  });
});

describe('chargedIn', () => {
  it('charges the starting month, whatever day it began', () => {
    expect(chargedIn(item({ startsAt: '2026-05-14' }), '2026-05')).toBe(true);
  });

  it('does not charge months before it started', () => {
    expect(chargedIn(item({ startsAt: '2026-05-01' }), '2026-04')).toBe(false);
  });

  it('puts the whole charge in the month it was paid, not the months it covers', () => {
    // Paid on 15 August for 15 Aug - 14 Sep. August carries the cost;
    // September carries nothing, because no payment falls in September.
    const i = item({ startsAt: '2026-08-15', endsAt: '2026-09-14' });
    expect(chargedIn(i, '2026-08')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
  });

  it('charges a full calendar month once', () => {
    const i = item({ startsAt: '2026-08-01', endsAt: '2026-08-31' });
    expect(chargedIn(i, '2026-08')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
  });

  it('keeps renewing while it runs', () => {
    const i = item({ startsAt: '2026-08-26', endsAt: null });
    ['2026-08', '2026-09', '2026-10', '2027-01'].forEach((m) => {
      expect(chargedIn(i, m)).toBe(true);
    });
  });

  it('does not charge a renewal that lands on the end date', () => {
    // The end date is the last day covered, not a day money moves. Renewing on
    // the 26th and ending 26 Oct, October's renewal is what the end date stops.
    const i = item({ startsAt: '2026-08-26', endsAt: '2026-10-26' });
    expect(chargedIn(i, '2026-08')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(true);
    expect(chargedIn(i, '2026-10')).toBe(false);
    expect(chargedIn(i, '2026-11')).toBe(false);
  });

  it('reads one month bought on the 26th as a single payment', () => {
    // Straight from a real account: "26 Aug -> 26 Sep" is how someone writes
    // one month paid for on the 26th. Charging the end date too reported two
    // payments for one, and doubled the account's six-month average.
    const i = item({ startsAt: '2026-08-26', endsAt: '2026-09-26' });
    expect(chargedIn(i, '2026-08')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
  });

  it('still charges the opening payment when start and end are the same day', () => {
    // Validation allows it (only endsAt < startsAt is rejected), and that day's
    // payment was really made — the end date must not swallow the first charge.
    const i = item({ startsAt: '2026-08-26', endsAt: '2026-08-26' });
    expect(chargedIn(i, '2026-08')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
  });

  it('clamps a renewal day to months too short to hold it', () => {
    // A 31 January subscription renews on 28 February, not on a date that
    // doesn't exist — and must not silently skip the month.
    const i = item({ startsAt: '2026-01-31', endsAt: null });
    expect(chargedIn(i, '2026-02')).toBe(true);
    expect(chargedIn(i, '2026-04')).toBe(true);
  });

  it('gives the same answer regardless of when it is asked', () => {
    // The rule this replaced excluded ended items from the current month only,
    // so a month's figure changed once that month was behind us. Reading from
    // the dates alone is what stops reported history moving.
    const i = item({ startsAt: '2026-08-15', endsAt: '2026-09-14' });
    expect(chargedIn(i, '2026-09')).toBe(false);
    expect(chargedIn(i, '2026-08')).toBe(true);
  });

  it('charges an annual plan only in its renewal month', () => {
    const i = item({ cadence: 'yearly', startsAt: '2026-01-15', endsAt: null });
    expect(chargedIn(i, '2026-01')).toBe(true);
    ['2026-02', '2026-03', '2026-09', '2026-12'].forEach((m) => {
      expect(chargedIn(i, m)).toBe(false);
    });
  });

  it('charges an annual plan again on its anniversary', () => {
    const i = item({ cadence: 'yearly', startsAt: '2026-01-15', endsAt: null });
    expect(chargedIn(i, '2027-01')).toBe(true);
    expect(chargedIn(i, '2028-01')).toBe(true);
  });

  it('does not renew an annual plan that ends before its anniversary', () => {
    // Bought 19 Sep 2025, ending 18 Sep 2026: one payment, in Sep 2025. The
    // 19 Sep 2026 renewal falls a day past the end date and never happens.
    const i = item({ cadence: 'yearly', startsAt: '2025-09-19', endsAt: '2026-09-18' });
    expect(chargedIn(i, '2025-09')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
    expect(chargedIn(i, '2026-01')).toBe(false);
  });

  it('does not renew an annual plan that ends on its anniversary', () => {
    // A year bought 19 Sep 2025 and ending 19 Sep 2026 is one payment, not two:
    // the anniversary is where the cover stops, not a second charge.
    const i = item({ cadence: 'yearly', startsAt: '2025-09-19', endsAt: '2026-09-19' });
    expect(chargedIn(i, '2025-09')).toBe(true);
    expect(chargedIn(i, '2026-09')).toBe(false);
  });

  it('runs indefinitely with no end date', () => {
    expect(chargedIn(item({ endsAt: null }), '2030-01')).toBe(true);
  });
});

describe('needsReview', () => {
  it('flags items whose end date has passed', () => {
    const ended = item({ id: 'a', name: 'Cursor', endsAt: '2026-08-31' });
    const live = item({ id: 'b', endsAt: '2026-12-01' });
    const open = item({ id: 'c', endsAt: null });

    const flagged = needsReview([ended, live, open], NOW);
    expect(flagged.map((i) => i.id)).toEqual(['a']);
  });

  it('does not flag one ending today — it is still charged this month', () => {
    expect(needsReview([item({ endsAt: '2026-09-16' })], NOW)).toHaveLength(0);
  });

  it('lists the most recently ended first', () => {
    const old = item({ id: 'old', endsAt: '2026-06-01' });
    const recent = item({ id: 'recent', endsAt: '2026-08-01' });
    expect(needsReview([old, recent], NOW).map((i) => i.id)).toEqual(['recent', 'old']);
  });
});

describe('isSubscriber', () => {
  it('matches on the resolved user id, not the display name', () => {
    // The whole reason the ids exist: two colleagues can share a display name,
    // and anyone may rename themselves. Either would silently hand one
    // person's spend to another if this compared names.
    const mine = item({ subscribers: ['Neeta Kumar'], subscriberUserIds: ['u-neeta'] });
    expect(isSubscriber(mine, 'u-neeta')).toBe(true);
    expect(isSubscriber(mine, 'u-someone-else')).toBe(false);
  });

  it('treats a line with no resolved ids as belonging to nobody', () => {
    // Lines written before ids existed. Owners and Admins still see them;
    // Members see nothing, which is the safe direction to fail.
    const legacy = item({ subscribers: ['Neeta Kumar'] });
    expect(isSubscriber(legacy, 'u-neeta')).toBe(false);
  });

  it('matches any one of several names on a shared line', () => {
    const shared = item({
      type: 'shared',
      subscribers: ['Rohan', 'Neeta'],
      subscriberUserIds: ['u-rohan', 'u-neeta'],
    });
    expect(isSubscriber(shared, 'u-rohan')).toBe(true);
    expect(isSubscriber(shared, 'u-neeta')).toBe(true);
    expect(isSubscriber(shared, 'u-kevin')).toBe(false);
  });

  it('is unmoved by an empty id list', () => {
    expect(isSubscriber(item({ subscriberUserIds: [] }), 'u-neeta')).toBe(false);
  });
});

describe('a finished subscription keeps its start date', () => {
  // Enforced in the PATCH route rather than here, but the rule it rests on is
  // hasEnded(), and these pin the boundary the route asks about.
  it('is ended once the end date is behind us', () => {
    expect(hasEnded({ endsAt: '2026-09-15' }, NOW)).toBe(true);
  });

  it('is not ended on the end date itself', () => {
    // NOW is 16 Sep 2026. A line ending today is still today's business, and
    // its start date stays editable until the day is out.
    expect(hasEnded({ endsAt: '2026-09-16' }, NOW)).toBe(false);
  });

  it('is never ended while open-ended', () => {
    expect(hasEnded({ endsAt: null }, NOW)).toBe(false);
  });
});

describe('needsCheckIn', () => {
  it('prompts on an open-ended line nobody has touched in months', () => {
    // The case nothing else can see: no end date, so it charges forever, and
    // no review flag because there is no date to have passed.
    const i = item({ endsAt: null, updatedAt: '2026-01-05T00:00:00Z' });
    expect(needsCheckIn(i, NOW)).toBe(true);
  });

  it('stays quiet on one edited recently', () => {
    expect(needsCheckIn(item({ endsAt: null, updatedAt: '2026-08-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it('never prompts where an end date exists', () => {
    // That line stops on its own, and needsReview covers it when the date
    // passes. Two prompts about the same row would be noise.
    const i = item({ endsAt: '2027-01-01', updatedAt: '2025-01-01T00:00:00Z' });
    expect(needsCheckIn(i, NOW)).toBe(false);
  });

  it('falls back to the start date on a line written before timestamps', () => {
    // Everything recorded before updatedAt existed has none; the start date is
    // the last moment anyone certainly confirmed it.
    expect(needsCheckIn(item({ endsAt: null, startsAt: '2025-06-01' }), NOW)).toBe(true);
    expect(needsCheckIn(item({ endsAt: null, startsAt: '2026-08-01' }), NOW)).toBe(false);
  });

  it('does not prompt exactly on the boundary', () => {
    // NOW is 16 Sep 2026; six months back is 16 Mar 2026.
    expect(needsCheckIn(item({ endsAt: null, updatedAt: '2026-03-16T00:00:00Z' }), NOW)).toBe(false);
    expect(needsCheckIn(item({ endsAt: null, updatedAt: '2026-03-15T00:00:00Z' }), NOW)).toBe(true);
  });
});

describe('adhocSnapshots', () => {
  it('builds one service per charged item', () => {
    const snaps = adhocSnapshots([
      item({ id: 'a', name: 'Claude Pro', amount: 100 }),
      item({ id: 'b', name: 'ChatGPT Plus', amount: 60 }),
    ], 6, NOW);

    const current = snaps[snaps.length - 1];
    expect(current.totalSpend).toBe(160);
    expect(current.serviceBreakdown.map((s) => s.name).sort()).toEqual(['ChatGPT Plus', 'Claude Pro']);
  });

  it('leaves months before the start date empty', () => {
    const snaps = adhocSnapshots([item({ startsAt: '2026-09-01' })], 6, NOW);
    // Only the current month is charged; the five before it are zero.
    expect(snaps.filter((s) => s.totalSpend > 0)).toHaveLength(1);
    expect(snaps[snaps.length - 1].totalSpend).toBe(100);
  });

  it('stops charging after the end date rather than carrying on', () => {
    // An end date is an explicit statement that the charge stops. Continuing
    // would invent spend for a tool that may well have been cancelled.
    const snaps = adhocSnapshots([item({ endsAt: '2026-07-31' })], 6, NOW);
    const byMonth = Object.fromEntries(snaps.map((s) => [s.monthKey, s.totalSpend]));
    expect(byMonth['2026-07']).toBe(100);
    expect(byMonth['2026-08']).toBe(0);
    expect(byMonth['2026-09']).toBe(0);
  });

  it('produces a full run of months even with no items at all', () => {
    const snaps = adhocSnapshots([], 6, NOW);
    expect(snaps).toHaveLength(6);
    expect(snaps.every((s) => s.totalSpend === 0)).toBe(true);
  });
});

describe('currentMonthSpend', () => {
  it('counts nothing in a month that saw no payment', () => {
    // Taken from a real dev account. All three were paid in August and none
    // renews in September, so September is genuinely zero — the account was
    // reporting the full amount for a month nothing had been charged in.
    const rows = [
      item({ id: 'a', amount: 25, startsAt: '2026-08-26', endsAt: '2026-09-25' }),
      item({ id: 'b', amount: 25, startsAt: '2026-08-12', endsAt: '2026-09-11' }),
      item({ id: 'c', amount: 25, startsAt: '2026-08-01', endsAt: '2026-08-31' }),
    ];

    expect(currentMonthSpend(rows, NOW)).toBe(0);
    expect(rows.filter((i) => chargedIn(i, '2026-08')).length).toBe(3);
  });

  it('totals only what is charged this month', () => {
    const spend = currentMonthSpend([
      item({ id: 'a', amount: 100 }),
      item({ id: 'b', amount: 60, endsAt: '2026-07-01' }),   // ended
      item({ id: 'c', amount: 40, startsAt: '2026-12-01' }), // not started
      // Yearly, bought 1 May: its next payment is May 2027, so September
      // carries none of it. Under the old rule it added 100 every month.
      item({ id: 'd', amount: 1200, cadence: 'yearly' }),
    ], NOW);

    expect(spend).toBe(100);
  });

  it('puts the whole annual charge in its renewal month', () => {
    const yearly = [item({ id: 'y', amount: 1200, cadence: 'yearly', startsAt: '2026-09-01' })];
    expect(currentMonthSpend(yearly, NOW)).toBe(1200);
  });
});

describe('subscribers do not change the cost', () => {
  it('charges the line total however many names are listed', () => {
    // Three people each paying $20 is three lines, not one line tripled. A
    // count that silently multiplies is how a total becomes unexplainable.
    const one = currentMonthSpend([item({ subscribers: ['Rohan'], amount: 20 })], NOW);
    const three = currentMonthSpend([
      item({ type: 'shared', subscribers: ['Rohan', 'Neeta', 'Kevin'], amount: 20 }),
    ], NOW);

    expect(one).toBe(20);
    expect(three).toBe(20);
  });

  it('costs the same whether individual or shared', () => {
    const ind = currentMonthSpend([item({ type: 'individual', amount: 60 })], NOW);
    const shr = currentMonthSpend([item({ type: 'shared', amount: 60 })], NOW);
    expect(ind).toBe(shr);
  });
});
