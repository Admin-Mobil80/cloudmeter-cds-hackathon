import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireOrgScope, json } from '../../../shared/authz';

const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };
/**
 * An unknown role sorts last rather than throwing the row to the top: a role
 * added server-side later should appear at the bottom, not above the owner.
 */
const rank = (role: unknown) => ROLE_RANK[String(role)] ?? 99;

/**
 * Owner, then Admins, then Members; alphabetical by name inside each group.
 *
 * It used to be owner first and everyone else oldest-joined first, which
 * mirrored how the workspace grew. That reads well at eight people and stops
 * working at thirty-one: join order is invisible on screen, so the list looked
 * unsorted, and finding one person meant scanning every row. Role then name is
 * the order someone can actually navigate — who can do what, and then where to
 * look for a name.
 *
 * Pending invites are sorted with this too but kept after the active roster by
 * the caller. They are a different kind of row — not yet anybody's colleague,
 * and cancellable rather than removable — and mixing them into the alphabet
 * would hide that.
 */
export function byRoleThenName<T extends { role?: unknown; name?: unknown; email?: unknown }>(
  a: T,
  b: T,
): number {
  const byRole = rank(a.role) - rank(b.role);
  if (byRole !== 0) return byRole;

  // Falls back to the email where a name is missing, so a blank row lands
  // somewhere predictable instead of drifting to the front.
  const an = String(a.name ?? '').trim() || String(a.email ?? '');
  const bn = String(b.name ?? '').trim() || String(b.email ?? '');
  // Case- and accent-insensitive: the list is read as an alphabet, not
  // compared byte by byte, so "aditya" must not sort after "Zain".
  const byLabel = an.localeCompare(bn, undefined, { sensitivity: 'base' });
  if (byLabel !== 0) return byLabel;

  // Two colleagues can share a display name; email breaks the tie so the order
  // is stable between requests rather than however the query happened to
  // return them.
  return String(a.email ?? '').localeCompare(String(b.email ?? ''));
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const outOfScope = requireOrgScope(caller);
  if (outOfScope) return outOfScope;

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}` },
  }));

  // Every timestamp is returned as a raw ISO string and labelled by its own
  // field. Previously one `lastActive` field carried either a timestamp or
  // prose like "Invited 8/19/2026", and the client guessed which by trying to
  // parse it — lenient Date parsers read that prose as midnight today, so
  // fresh invites displayed as hours old.
  const members = (Items ?? [])
    .filter((i) => String(i.SK).startsWith('MEMBER#'))
    .map((m) => ({
      id: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      lastActiveAt: (m.lastActiveAt ?? null) as string | null,
      // Only meaningful for Members; Owners and Admins see the whole tenant.
      accountIds: Array.isArray(m.accountIds) ? (m.accountIds as string[]) : [],
      joinedAt: (m.joinedAt ?? null) as string | null,
      isYou: m.userId === caller.userId,
    }));

  const invites = (Items ?? [])
    .filter((i) => String(i.SK).startsWith('INVITE#') && i.status === 'pending')
    .map((inv) => ({
      // The bare token, so the UI can call DELETE /team/invites/{token}.
      id: String(inv.SK).replace('INVITE#', ''),
      pendingInvite: true,
      name: (inv.name as string) || String(inv.email).split('@')[0],
      email: inv.email,
      role: inv.role,
      status: 'pending',
      accountIds: Array.isArray(inv.accountIds) ? (inv.accountIds as string[]) : [],
      invitedAt: (inv.invitedAt ?? null) as string | null,
      isYou: false,
    }));

  // Each list ordered the same way; invites stay after the active roster.
  members.sort(byRoleThenName);
  invites.sort(byRoleThenName);

  return json(200, { members: [...members, ...invites] });
};
