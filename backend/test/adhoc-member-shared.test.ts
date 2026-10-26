/**
 * A Member naming colleagues on a shared adhoc subscription.
 *
 * Before this, a Member's submitted names were discarded and replaced with
 * their own, while the Individual/Shared switch above the field stayed live —
 * so choosing Shared appeared to do nothing at all. Three people sharing one
 * Claude Pro seat had to file three lines for one payment, or wait for an
 * Admin.
 *
 * The relaxation keeps one rule, which is what these tests are mostly about:
 * a Member is always on their own line. Recording somebody else's spending
 * with no involvement of their own is the one case with no honest reading.
 */

import { withSubscribers } from '../functions/api/adhoc-items';
import type { AdhocItem } from '../functions/shared/adhoc';

type Caller = {
  userId: string;
  membership: { role: string; name?: string; tenantId: string };
};

/** Drives the real withSubscribers, rather than a copy of its rules. */
function resolveSubscribers(
  submitted: string[],
  caller: Caller,
  roster: Map<string, string>,
) {
  const item = {
    id: 'i1', name: 'Claude Pro', type: 'shared', subscribers: submitted,
    amount: 20, cadence: 'monthly', startsAt: '2026-09-01', endsAt: '',
  } as unknown as AdhocItem;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = withSubscribers(item, caller as any, roster);
  // subscriberUserIds is optional on AdhocItem; withSubscribers always sets it.
  return { subscribers: out.subscribers, subscriberUserIds: out.subscriberUserIds ?? [] };
}

const ROSTER = new Map<string, string>([
  ['ravi pal', 'u-ravi'],
  ['rijo varghese', 'u-rijo'],
  ['neeta kumar', 'u-neeta'],
]);

const member = (name: string, userId: string): Caller =>
  ({ userId, membership: { role: 'member', name, tenantId: 't1' } });
const admin: Caller = { userId: 'u-neeta', membership: { role: 'admin', name: 'Neeta Kumar', tenantId: 't1' } };

describe('a Member on a shared line', () => {
  it('may name a colleague, which used to be discarded', () => {
    const r = resolveSubscribers(['Ravi Pal', 'Rijo Varghese'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal', 'Rijo Varghese']);
    expect(r.subscriberUserIds.sort()).toEqual(['u-rijo', 'u-ravi'].sort());
  });

  it('is added to a line they left themselves off', () => {
    /*
     * The rule that makes the relaxation safe. A Member filing a line naming
     * only colleagues would be recording someone else's spending with no
     * involvement of their own — so they are put back on it.
     *
     * Added rather than rejected: the server can simply make it true, and a
     * refusal here would only invite guessing at the payload.
     */
    const r = resolveSubscribers(['Rijo Varghese'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toContain('Ravi Pal');
    expect(r.subscriberUserIds).toContain('u-ravi');
  });

  it('is not added twice when they already named themselves', () => {
    const r = resolveSubscribers(['Ravi Pal', 'Rijo Varghese'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers.filter((n) => n === 'Ravi Pal')).toHaveLength(1);
  });

  it('matches their own name case-insensitively before adding it', () => {
    // The form resolves what was typed to the team's spelling, but a stored
    // line from before that may carry any casing. Adding "Ravi Pal" beside an
    // existing "ravi pal" would show one person twice.
    const r = resolveSubscribers(['ravi pal'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toHaveLength(1);
  });

  it('still files a line for themselves when they name nobody', () => {
    const r = resolveSubscribers([], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal']);
  });
});

describe('names are still matched against the workspace', () => {
  it('drops an id for a name nobody has', () => {
    // The name is kept for display, but it attributes to nobody — so it can
    // never grant access to a line, and the user count cannot be inflated by
    // an invention.
    const r = resolveSubscribers(['Ghost User'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toContain('Ghost User');
    expect(r.subscriberUserIds).toEqual(['u-ravi']);
  });

  it('does not double-count one person named twice', () => {
    const r = resolveSubscribers(['Ravi Pal', 'ravi pal'], admin, ROSTER);
    expect(r.subscriberUserIds).toEqual(['u-ravi']);
  });
});

describe('one row per person', () => {
  /*
   * The form refuses a repeated name with a message; this is the backstop for
   * anything that does not come from the form, and the repair for a line
   * already stored with a duplicate.
   *
   * The head count was never wrong — subscriberCount counts distinct people —
   * so a duplicate is invisible in every figure and visible only in the list,
   * where it reads "lavanya, lavanya" and looks like the record is wrong about
   * who is on it.
   */
  it('stores one row for a name given twice', () => {
    const r = resolveSubscribers(['Ravi Pal', 'Ravi Pal'], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal']);
  });

  it('matches case and padding, the way the count and the roster do', () => {
    // The box stores what was typed, so the same person arrives spelled
    // differently. Anything the roster resolves to one user must collapse to
    // one row, or the stored list disagrees with the head count beside it.
    const r = resolveSubscribers(['Ravi Pal', '  ravi pal ', 'RAVI PAL'], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal']);
    expect(r.subscriberUserIds).toEqual(['u-ravi']);
  });

  it('keeps the first spelling', () => {
    const r = resolveSubscribers(['ravi pal', 'Ravi Pal'], admin, ROSTER);
    expect(r.subscribers).toEqual(['ravi pal']);
  });

  it('leaves distinct people alone', () => {
    const r = resolveSubscribers(['Ravi Pal', 'Rijo Varghese'], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal', 'Rijo Varghese']);
  });

  it('drops a blank row rather than storing an empty subscriber', () => {
    const r = resolveSubscribers(['Ravi Pal', '   ', ''], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal']);
  });

  it('dedupes a name nobody in the workspace has, too', () => {
    // An unresolvable name is still one name. It attributes to nobody either
    // way; showing it twice is the only thing at stake, and that is the bug.
    const r = resolveSubscribers(['Ghost User', 'ghost user'], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ghost User']);
  });

  it('does not add a Member again under a different spelling', () => {
    // The Member rule runs after the dedupe and does its own case-insensitive
    // check; between them they must not produce two rows for one person.
    const r = resolveSubscribers(['ravi pal', 'Rijo Varghese'], member('Ravi Pal', 'u-ravi'), ROSTER);
    expect(r.subscribers).toEqual(['ravi pal', 'Rijo Varghese']);
  });
});

describe('an Admin is unaffected', () => {
  it('may file a line naming only other people', () => {
    // The whole point of the Member rule is that it does not apply here: an
    // Admin records the workspace's subscriptions, including ones they have
    // no part in.
    const r = resolveSubscribers(['Ravi Pal', 'Rijo Varghese'], admin, ROSTER);
    expect(r.subscribers).toEqual(['Ravi Pal', 'Rijo Varghese']);
    expect(r.subscriberUserIds).not.toContain('u-neeta');
  });
});
