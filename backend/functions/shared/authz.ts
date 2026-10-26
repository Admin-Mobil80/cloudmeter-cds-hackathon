import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getMembershipForUser, Membership } from './membership';

export interface Caller {
  userId: string;
  email: string;
  membership: Membership;
}

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Re-derives the caller's identity + current tenant/role from the JWT
 * claims + a fresh DynamoDB lookup — never trusts a client-supplied role. */
export async function resolveCaller(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Caller | null> {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub as string;
  const email = claims.email as string;

  const membership = await getMembershipForUser(userId);
  if (!membership) return null;

  return { userId, email, membership };
}

/**
 * Whether this caller may act on a given cloud account — remove it, edit its
 * owner/contact, act on its alerts, or grant a Member access to it.
 *
 * Owners and Admins both may, on any account in the tenant. Admins were once
 * limited to accounts they connected; that was lifted deliberately, because an
 * Admin who cannot clean up a colleague's stale account has to escalate to the
 * Owner for routine work. Managing accounts is what the Admin role is for.
 *
 * Members never may, whatever they are mapped to — being able to read an
 * account's costs is not the same as being able to destroy it.
 */
export function canManageAccount(
  caller: Caller,
  _account: { createdBy?: string } = {},
): boolean {
  const role = caller.membership.role;
  return role === 'owner' || role === 'admin';
}

/**
 * Whether this caller may force a cost pull.
 *
 * Owners and Admins may, on anything. Beyond them, the person the account is
 * assigned to may pull their own — they are the one answerable for its spend,
 * and that is the whole point of naming them. It stays gated because each pull
 * is a billed provider API call.
 */
export function canRefreshAccount(
  caller: Caller,
  account: { createdBy?: string },
): boolean {
  if (canManageAccount(caller)) return true;
  return !!account.createdBy && account.createdBy === caller.userId;
}

/**
 * Refuses changes in the read-only demo workspace.
 *
 * Its login (appreview@cloudmeter.io) is published for hackathon judges and
 * app-store reviewers, so anyone may sign in. It keeps the Owner role, because a
 * Member cannot open the dashboard, and instead every change is refused here:
 * invites, accounts, settings, billing, closing or transferring the workspace,
 * ad-hoc spend, Slack. Connecting WhatsApp is deliberately left open — that is
 * how judges try the WhatsApp assistant — and it changes only the person's own
 * notification settings.
 */
export function requireNotDemo(caller: Caller): APIGatewayProxyResultV2 | null {
  if (caller.membership.readOnlyDemo) {
    return json(403, { message: 'This demo workspace is read-only.', readOnlyDemo: true });
  }
  return null;
}

export function requireRole(caller: Caller, allowed: Array<'owner' | 'admin' | 'member'>): APIGatewayProxyResultV2 | null {
  // Every caller of requireRole guards a change, so the demo check lives here
  // rather than being repeated in each handler.
  const demo = requireNotDemo(caller);
  if (demo) return demo;
  if (!allowed.includes(caller.membership.role as 'owner' | 'admin' | 'member')) {
    return json(403, { message: 'Forbidden' });
  }
  return null;
}

/**
 * Members see only the cloud accounts they have been mapped to. Owners and
 * Admins see everything in the tenant.
 *
 * Returns null for "no restriction" rather than a list of every account id, so
 * that unrestricted access is a distinct value a caller must handle, and can't
 * be confused with an empty list — which means the opposite.
 */
export function visibleAccountIds(caller: Caller): string[] | null {
  return caller.membership.role === 'member' ? caller.membership.accountIds : null;
}

/** Whether this caller may see a given account at all. */
export function canViewAccount(caller: Caller, accountId: string): boolean {
  const visible = visibleAccountIds(caller);
  return visible === null || visible.includes(accountId);
}

/**
 * Guards the views that describe the organisation as a whole — the roll-up
 * dashboard and the team list. A Member is scoped to individual accounts, so
 * tenant-wide totals would tell them about spend they have no access to.
 */
export function requireOrgScope(caller: Caller): APIGatewayProxyResultV2 | null {
  if (caller.membership.role === 'member') {
    return json(403, {
      message: 'Your access is limited to specific cloud accounts.',
      scoped: true,
    });
  }
  return null;
}

/**
 * Guards everything that *changes* something, once a tenant's subscription has
 * lapsed or its payment has failed. Reading stays open — the whole point of the
 * frozen state is that a customer keeps the history they paid for.
 *
 * Applied per endpoint rather than by HTTP verb, because three things that
 * write must stay reachable and a blanket rule would trap people:
 *
 *   - billing checkout and portal, which are how a tenant renews;
 *   - PUT /me/active-account, or someone whose *first* workspace is frozen
 *     could never switch to a healthy one;
 *   - the gateway webhooks, which is how the renewal actually arrives.
 *
 * Reads `syncStatus` off the membership resolveCaller already loaded, so this
 * costs nothing. That field is derived from the same syncFrozen() the sweep
 * and accounts/refresh use, so the three cannot disagree about who is frozen.
 */
export function requireWritable(caller: Caller): APIGatewayProxyResultV2 | null {
  const status = caller.membership.syncStatus;
  if (status === 'active') return null;

  return json(403, {
    message: status === 'payment_failed'
      ? 'This workspace is read-only because the last payment failed. '
        + 'Update your payment method to make changes again.'
      : 'This workspace is read-only because the subscription has expired. '
        + 'Renew to make changes again.',
    // Lets the portal tell this apart from a role refusal, which is permanent
    // for that person, where this clears the moment billing is sorted out.
    syncStatus: status,
    readOnly: true,
  });
}
