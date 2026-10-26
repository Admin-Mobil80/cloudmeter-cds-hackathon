import { accountNotificationsOn, unmutedAccounts } from '../functions/shared/alert-notify';

/**
 * Muting one cloud account.
 *
 * The switches were offered to everyone on the Notifications page but honoured
 * only for Members, so an Owner could untick an account, watch it save, see it
 * unticked on reload, and keep receiving every alert from it. These pin the
 * two halves of the fix: the switch itself, and the roll-up an Owner gets.
 */

const A = 'acc-aws';
const B = 'acc-azure';
const C = 'acc-gcp';

const muted = (...ids: string[]) => ({
  accounts: Object.fromEntries(ids.map((id) => [
    id, { anomaly: { enabled: false }, digest: { enabled: false } },
  ])),
});

describe('accountNotificationsOn', () => {
  it('treats a missing record as on', () => {
    // Someone newly given an account hears about it without enabling anything.
    expect(accountNotificationsOn(undefined, A, 'anomaly')).toBe(true);
    expect(accountNotificationsOn({}, A, 'digest')).toBe(true);
  });

  it('treats an account with no entry as on', () => {
    expect(accountNotificationsOn(muted(B), A, 'anomaly')).toBe(true);
  });

  it('honours an explicit mute', () => {
    expect(accountNotificationsOn(muted(A), A, 'anomaly')).toBe(false);
    expect(accountNotificationsOn(muted(A), A, 'digest')).toBe(false);
  });

  it('keeps the two kinds apart', () => {
    // Muting the digest for an account must not silence its spike alerts:
    // a daily summary and "your bill just jumped" are different questions.
    const prefs = { accounts: { [A]: { digest: { enabled: false } } } };
    expect(accountNotificationsOn(prefs, A, 'digest')).toBe(false);
    expect(accountNotificationsOn(prefs, A, 'anomaly')).toBe(true);
  });
});

describe("an Owner's roll-up", () => {
  const all = [A, B, C];

  it('keeps every account when nothing is muted', () => {
    expect(unmutedAccounts(undefined, all, 'digest')).toEqual(all);
    expect(unmutedAccounts({}, all, 'digest')).toEqual(all);
  });

  it('drops only the muted one, rather than the whole digest', () => {
    // The point of the fix: silencing one noisy account still leaves someone
    // hearing about the rest.
    expect(unmutedAccounts(muted(B), all, 'digest')).toEqual([A, C]);
  });

  it('returns nothing when every account is muted', () => {
    // The one case where no digest should go out at all.
    expect(unmutedAccounts(muted(A, B, C), all, 'digest')).toEqual([]);
  });

  it('is unaffected by a mute on an account that is not theirs', () => {
    expect(unmutedAccounts(muted('acc-someone-else'), all, 'digest')).toEqual(all);
  });

  it('reads the anomaly switch separately from the digest one', () => {
    const prefs = { accounts: { [B]: { digest: { enabled: false } } } };
    expect(unmutedAccounts(prefs, all, 'digest')).toEqual([A, C]);
    expect(unmutedAccounts(prefs, all, 'anomaly')).toEqual(all);
  });
});
