import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireWritable } from '../functions/shared/authz';
import type { Membership } from '../functions/shared/membership';

/**
 * A frozen tenant is read-only: it keeps everything it has, and changes
 * nothing until billing is sorted out.
 *
 * Two things are pinned here. First the guard itself. Second — and the more
 * useful of the two — which endpoints carry it, because the failure mode for
 * this feature is not a wrong answer but an endpoint somebody forgets to
 * guard, and that is invisible until a frozen tenant writes through the gap.
 */

const caller = (syncStatus: Membership['syncStatus'], role = 'owner') => ({
  userId: 'u1',
  email: 'someone@example.com',
  membership: { role, syncStatus } as unknown as Membership,
});

const bodyOf = (res: unknown) => JSON.parse((res as { body: string }).body);

describe('requireWritable', () => {
  it('lets an active tenant through', () => {
    expect(requireWritable(caller('active'))).toBeNull();
  });

  it('blocks an expired subscription with a renew message', () => {
    const res = requireWritable(caller('expired'));
    expect(res).not.toBeNull();
    expect((res as { statusCode: number }).statusCode).toBe(403);
    const b = bodyOf(res);
    expect(b.readOnly).toBe(true);
    expect(b.syncStatus).toBe('expired');
    expect(b.message).toMatch(/subscription has expired/i);
    expect(b.message).toMatch(/renew/i);
  });

  it('blocks a failed payment with payment wording, not renewal wording', () => {
    const b = bodyOf(requireWritable(caller('payment_failed')));
    expect(b.syncStatus).toBe('payment_failed');
    expect(b.message).toMatch(/payment/i);
    expect(b.message).not.toMatch(/expired/i);
  });

  it('blocks every role equally — this is about billing, not permissions', () => {
    for (const role of ['owner', 'admin', 'member']) {
      expect(requireWritable(caller('expired', role))).not.toBeNull();
    }
  });

  it('is distinguishable from a role refusal', () => {
    // requireRole returns a bare Forbidden; the portal needs to tell a
    // permanent "not your job" apart from a state that clears on renewal.
    expect(bodyOf(requireWritable(caller('expired'))).readOnly).toBe(true);
  });
});

/** Every handler under functions/api, as repo-relative directories. */
function handlerDirs(root = 'functions/api'): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'index.ts') out.push(dir);
    }
  })(root);
  return out.sort();
}

describe('guard coverage', () => {
  // Shared functions that apply the guard themselves, so a handler that hands
  // its whole request to one is guarded too. Checked below, so this list
  // can't vouch for a function that has quietly lost its guard.
  const GUARDED_SHARED = { createTeamInvite: 'functions/shared/team-invite.ts' };
  const guarded = handlerDirs().filter((d) => {
    const src = readFileSync(join(d, 'index.ts'), 'utf8');
    return src.includes('requireWritable') || Object.keys(GUARDED_SHARED).some((fn) => src.includes(`${fn}(`));
  });

  it('shared write functions apply the guard themselves', () => {
    for (const file of Object.values(GUARDED_SHARED)) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(src).toContain('requireWritable(caller)');
      expect(src).toContain('requireRole(caller');
    }
  });

  /**
   * Deliberately unguarded, each for a reason that would trap someone:
   *   billing/*        how a tenant renews — blocking it is a locked door
   *   webhooks         how the renewal actually arrives
   *   me/active-account  or a frozen first workspace is inescapable
   *   alerts/read      housekeeping on data they already have; blocking it
   *                    leaves the unread badge stuck forever
   *   tenant/close     refusing to let someone leave is hostile
   *   bms/*            staff tooling, never subject to a tenant's billing
   */
  it('covers every tenant-scoped write endpoint', () => {
    expect(guarded).toEqual([
      'functions/api/accounts/connect-params',
      'functions/api/accounts/create',
      'functions/api/accounts/delete',
      'functions/api/accounts/update',
      // Adding or editing a subscription is a write like any other: a lapsed
      // tenant keeps its history and loses the ability to change it.
      'functions/api/adhoc-items',
      'functions/api/notification-prefs/account',
      'functions/api/notification-prefs/put',
      'functions/api/notifications-slack-connect',
      'functions/api/notifications-test-digest',
      'functions/api/notifications-whatsapp-start',
      'functions/api/notifications-whatsapp-verify',
      // slack-oauth-callback beside it is deliberately unguarded: Slack
      // redirects a browser to it carrying no CloudMeter credentials, exactly
      // like the billing webhooks. Its security is the single-use state.
      'functions/api/slack-oauth-start',
      'functions/api/team/accounts',
      'functions/api/team/invite',
      'functions/api/team/invite-delete',
      'functions/api/team/remove',
      'functions/api/team/transfer-ownership',
      'functions/api/team/update',
      'functions/api/tenant-settings/put',
    ]);
  });

  it('guards accounts/refresh differently, and on purpose', () => {
    // Refresh is not a change being forbidden — it is the paused thing itself
    // being asked for. So it answers 200 with `refreshed: false` and a reason,
    // the shape the account page already renders as a neutral note, rather
    // than a 403 the page would render red. It calls syncFrozen directly for
    // that reason; both paths read the same function, so they cannot disagree
    // about who is frozen.
    const src = readFileSync('functions/api/accounts/refresh/index.ts', 'utf8');
    expect(src).toContain('syncFrozen');
    expect(src).not.toContain('requireWritable');
  });

  it('never guards the paths a frozen tenant needs to escape', () => {
    for (const escape of [
      'functions/api/billing/checkout',
      'functions/api/billing/portal',
      'functions/api/billing/webhook',
      'functions/api/billing/razorpay-webhook',
      'functions/api/me/active-account',
    ]) {
      expect(guarded).not.toContain(escape);
    }
  });

  it('leaves every read endpoint alone', () => {
    for (const read of [
      'functions/api/me',
      'functions/api/accounts/list',
      'functions/api/alerts/list',
      'functions/api/team/list',
      'functions/api/tenant-settings/get',
    ]) {
      expect(guarded).not.toContain(read);
    }
  });
});
