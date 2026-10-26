import { subscriberCount, subscriptionCount } from '../functions/shared/adhoc';
import type { AdhocItem } from '../functions/shared/adhoc';

/**
 * How many people are on a tool.
 *
 * Shown on the Cloud Accounts row, where it replaces an id that for a tool was
 * only the name again. It counts people rather than lines, which is the whole
 * difficulty: one person can hold two plans, and one shared plan can carry
 * four people.
 */

const NOW = new Date('2026-09-24T12:00:00Z');
const item = (over: Partial<AdhocItem> = {}): AdhocItem => ({
  id: 'i1', name: 'Pro', type: 'individual', subscribers: ['Neeta'],
  amount: 20, cadence: 'monthly', startsAt: '2026-01-01', endsAt: null,
  note: null, updatedAt: NOW.toISOString(), ...over,
} as AdhocItem);

describe('subscriberCount', () => {
  it('counts nobody on an empty tool', () => {
    expect(subscriberCount([], NOW)).toBe(0);
  });

  it('counts one person on one line', () => {
    expect(subscriberCount([item()], NOW)).toBe(1);
  });

  it('counts a shared line as everyone named on it', () => {
    expect(subscriberCount([
      item({ type: 'shared', subscribers: ['Neeta', 'Rohan', 'Lavanya', 'Kundan'] }),
    ], NOW)).toBe(4);
  });

  it('counts one person on two plans once', () => {
    // A user of the tool, not a count of subscriptions — someone on both Pro
    // and a Team seat is one colleague using Claude.
    expect(subscriberCount([
      item({ id: 'a', name: 'Pro' }),
      item({ id: 'b', name: 'Team Standard' }),
    ], NOW)).toBe(1);
  });

  it('treats the same name in different case or spacing as one person', () => {
    // The field is typed, and a real workspace already holds both spellings.
    expect(subscriberCount([
      item({ id: 'a', subscribers: ['Lavanya'] }),
      item({ id: 'b', subscribers: ['lavanya'] }),
      item({ id: 'c', subscribers: ['  Lavanya  '] }),
    ], NOW)).toBe(1);
  });

  it('leaves out a subscription that has ended', () => {
    // Somebody whose plan lapsed in July is not using the tool now.
    expect(subscriberCount([item({ endsAt: '2026-07-20' })], NOW)).toBe(0);
  });

  it('leaves out a subscription that has not begun', () => {
    expect(subscriberCount([
      item({ startsAt: '2026-10-21', endsAt: '2026-11-21' }),
    ], NOW)).toBe(0);
  });

  it('counts a subscription starting today', () => {
    expect(subscriberCount([item({ startsAt: '2026-09-24' })], NOW)).toBe(1);
  });

  it('counts nobody between a lapsed line and its renewal', () => {
    /*
     * Exactly the shape on a real Cursor account: one line ended on the 20th,
     * the next begins on the 21st of next month, and today falls in the gap.
     * This read "1 user" beside a spend of zero and a card showing nothing
     * running — the count has to agree with the money next to it.
     */
    expect(subscriberCount([
      item({ id: 'a', subscribers: ['Lavanya'], startsAt: '2026-07-21', endsAt: '2026-09-20' }),
      item({ id: 'b', subscribers: ['Lavanya'], startsAt: '2026-10-21', endsAt: '2026-11-21' }),
    ], NOW)).toBe(0);
  });

  it('counts them again once the renewal has started', () => {
    const later = new Date('2026-10-22T12:00:00Z');
    expect(subscriberCount([
      item({ id: 'a', subscribers: ['Lavanya'], startsAt: '2026-07-21', endsAt: '2026-09-20' }),
      item({ id: 'b', subscribers: ['Lavanya'], startsAt: '2026-10-21', endsAt: '2026-11-21' }),
    ], later)).toBe(1);
  });

  it('ignores blank and missing names rather than counting them as people', () => {
    expect(subscriberCount([
      item({ id: 'a', subscribers: ['', '   '] }),
      item({ id: 'b', subscribers: [] }),
    ], NOW)).toBe(0);
  });

  it('survives a line with no subscribers field at all', () => {
    expect(subscriberCount([{ ...item(), subscribers: undefined } as unknown as AdhocItem], NOW)).toBe(0);
  });
});

/**
 * How many subscriptions are running on a tool.
 *
 * The companion figure, shown beside the head count on the same row. It
 * counts lines rather than people, and the pair is the point: three
 * colleagues each buying their own Pro seat is 3 users and 3 subscriptions,
 * while one shared Team seat naming those same three is 3 users and 1. The
 * head count alone reads identically in both, and only the pair says whether
 * a tool is worth consolidating.
 */
describe('subscriptionCount', () => {
  it('counts nothing on an empty tool', () => {
    expect(subscriptionCount([], NOW)).toBe(0);
  });

  it('counts lines, not people, on a shared plan', () => {
    // The case the second number exists for. One purchase, four colleagues.
    const shared = item({ type: 'shared', subscribers: ['Neeta', 'Rohan', 'Ravi', 'Rijo'] });
    expect(subscriptionCount([shared], NOW)).toBe(1);
    expect(subscriberCount([shared], NOW)).toBe(4);
  });

  it('counts each individual line separately', () => {
    // The opposite case, which the head count alone cannot tell from the one
    // above: four people, four separate purchases of the same tool.
    const lines = [
      item({ id: 'a', subscribers: ['Neeta'] }),
      item({ id: 'b', subscribers: ['Rohan'] }),
      item({ id: 'c', subscribers: ['Ravi'] }),
      item({ id: 'd', subscribers: ['Rijo'] }),
    ];
    expect(subscriptionCount(lines, NOW)).toBe(4);
    expect(subscriberCount(lines, NOW)).toBe(4);
  });

  it('counts one person holding two plans as two subscriptions', () => {
    // The mirror of the shared case: one user, two lines. Both figures are
    // right and they disagree, which is exactly what the row should show.
    const lines = [item({ id: 'a' }), item({ id: 'b', name: 'Team' })];
    expect(subscriptionCount(lines, NOW)).toBe(2);
    expect(subscriberCount(lines, NOW)).toBe(1);
  });

  it('leaves out a line that has ended', () => {
    expect(subscriptionCount([item({ endsAt: '2026-07-20' })], NOW)).toBe(0);
  });

  it('leaves out a line that has not begun', () => {
    expect(subscriptionCount([item({ startsAt: '2026-12-01' })], NOW)).toBe(0);
  });

  it('agrees with the head count about which lines are live', () => {
    /*
     * The two numbers sit side by side on one row, so a line either counts
     * for both or for neither. A window that drifted between them would show
     * "0 users · 1 subscription" on a tool nobody is on, or the reverse —
     * either of which reads as a bug in the figures rather than a fact about
     * the tool.
     */
    const mixed = [
      item({ id: 'live' }),
      item({ id: 'ended', endsAt: '2026-07-20' }),
      item({ id: 'future', startsAt: '2026-12-01' }),
    ];
    expect(subscriptionCount(mixed, NOW)).toBe(1);
    expect(subscriberCount(mixed, NOW)).toBe(1);
  });

  it('counts a line ending today, which has not ended yet', () => {
    // hasEnded is strictly "before today"; the last day is still paid for.
    expect(subscriptionCount([item({ endsAt: '2026-09-24' })], NOW)).toBe(1);
  });

  it('counts a line with no subscribers on it', () => {
    // A subscription with nobody named is still money going out, and this is
    // the figure that says so — the head count cannot.
    expect(subscriptionCount([item({ subscribers: [] })], NOW)).toBe(1);
    expect(subscriberCount([item({ subscribers: [] })], NOW)).toBe(0);
  });
});
