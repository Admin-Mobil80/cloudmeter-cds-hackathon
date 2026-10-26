import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { statusGrantsAccess } from './subscription';
import { syncFrozen, currentPeriod, type SyncFreeze } from './subscription-period';

export interface Membership {
  tenantId: string;
  /**
   * The public demo workspace judges and app-store reviewers sign into. Its
   * login is published, so it can look at everything and change nothing — see
   * requireNotDemo in authz.ts.
   */
  readOnlyDemo: boolean;
  tenantName: string | null;
  role: string;
  status: string;
  tenantCreatedAt: string | null;
  lastActiveAt: string | null;
  name: string | null;
  /** Tenant's IANA timezone — drives when notifications fire. */
  timezone: string | null;
  /**
   * The tenant's plan, and whether it currently grants access. Carried here
   * because every page load already fetches this membership, and the trial
   * banner needs to know not to nag an account that has already subscribed —
   * whether through Stripe or set by hand in BMS.
   */
  planId: string | null;
  entitled: boolean;
  /**
   * Whether cost data is still being refreshed, and why not.
   *
   * NOT a synonym for `entitled`, and the two deliberately disagree on the two
   * cases that matter most:
   *
   *   live trial      entitled: false   syncStatus: 'active'
   *   failed card     entitled: true    syncStatus: 'payment_failed'
   *
   * A trial carries no subscriptionStatus, so `entitled` is false for every
   * healthy trial — gating a "your subscription expired" banner on it would
   * show that message to brand new signups. Conversely a failed card keeps
   * full product access while syncing stops. Read this field, not `entitled`,
   * for anything about data freshness.
   *
   * Advisory only: the sweep and accounts/refresh each re-derive the same
   * answer from syncFrozen(), so a wrong value here mis-renders a banner but
   * cannot grant or deny anything.
   */
  syncStatus: 'active' | SyncFreeze;
  /**
   * When the current trial or paid period ends — the date the portal shows
   * when it has to say *when* something lapsed.
   *
   * Read through currentPeriod() rather than picking a field, so this agrees
   * with the renewal sweep and BMS about which clock governs. Null for an
   * account that genuinely cannot be dated, which the portal must render as
   * "no date" rather than inventing one.
   */
  periodEndsAt: string | null;
  /**
   * Cloud accounts a Member is mapped to. Empty means they can see nothing
   * yet, which is the correct default for a new Member — access is granted
   * deliberately, never inherited by joining.
   *
   * Meaningless for Owners and Admins, who see every account in the tenant;
   * read it through visibleAccountIds() rather than directly, so that
   * distinction stays in one place.
   */
  accountIds: string[];
}

/** One row of "which CloudMeter accounts is this person in". */
export interface MembershipSummary {
  tenantId: string;
  tenantName: string | null;
  role: string;
}

/**
 * Every CloudMeter account this person belongs to.
 *
 * A person can be in more than one — their own, plus any they've been invited
 * into. Sorted oldest-joined first so the list, and the fallback choice of
 * active account, are stable between requests.
 */
export async function getMembershipsForUser(userId: string): Promise<Record<string, unknown>[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :u',
    ExpressionAttributeValues: { ':u': `USER#${userId}` },
  }));

  return (Items ?? []).sort((a, b) => {
    const at = String(a.joinedAt ?? a.invitedAt ?? '');
    const bt = String(b.joinedAt ?? b.invitedAt ?? '');
    return at.localeCompare(bt) || String(a.PK).localeCompare(String(b.PK));
  });
}

/**
 * The membership requests should act on: the one this person last switched to,
 * or their oldest if they've never chosen.
 *
 * The stored choice is validated against the memberships they actually hold, so
 * a stale pointer — to an account they were removed from, or one that has been
 * closed — falls back rather than granting anything.
 */
export async function getMembershipForUser(userId: string): Promise<Membership | null> {
  const memberships = await getMembershipsForUser(userId);
  if (memberships.length === 0) return null;

  let chosen = memberships[0];
  if (memberships.length > 1) {
    const activeTenantId = await getActiveTenantId(userId);
    const match = memberships.find((m) => String(m.PK).replace('TENANT#', '') === activeTenantId);
    if (match) chosen = match;
  }

  const tenantId = String(chosen.PK).replace('TENANT#', '');
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));

  return {
    tenantId,
    tenantName: tenant?.name ?? null,
    role: chosen.role as string,
    status: chosen.status as string,
    tenantCreatedAt: tenant?.createdAt ?? null,
    lastActiveAt: (chosen.lastActiveAt as string) ?? null,
    name: (chosen.name as string) ?? null,
    timezone: (tenant?.timezone as string) ?? null,
    planId: (tenant?.planId as string) ?? null,
    entitled: statusGrantsAccess(tenant?.subscriptionStatus as string | undefined),
    // Derived here rather than in the /me handler so the REST and AppSync
    // versions of /me — which both spread this object — cannot drift apart.
    // The tenant row above is fetched whole, so this costs no extra read.
    syncStatus: syncFrozen(tenant ?? {}) ?? 'active',
    periodEndsAt: currentPeriod(tenant ?? {})?.endsAt ?? null,
    accountIds: normalizeAccountIds(chosen.accountIds),
    readOnlyDemo: tenant?.readOnlyDemo === true,
  };
}

/** The same list as getMembershipsForUser, with each tenant's display name. */
export async function summarizeMemberships(userId: string): Promise<MembershipSummary[]> {
  const memberships = await getMembershipsForUser(userId);
  return Promise.all(memberships.map(async (m) => {
    const tenantId = String(m.PK).replace('TENANT#', '');
    const { Item: tenant } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
      ProjectionExpression: '#n',
      ExpressionAttributeNames: { '#n': 'name' },
    }));
    return { tenantId, tenantName: (tenant?.name as string) ?? null, role: m.role as string };
  }));
}

export async function getActiveTenantId(userId: string): Promise<string | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
    ProjectionExpression: 'activeTenantId',
  }));
  return (Item?.activeTenantId as string) ?? null;
}

/**
 * Records which CloudMeter account this person is currently working in.
 *
 * Callers must have already confirmed the membership exists — this only
 * stores the pointer, and every request re-validates it against the
 * memberships actually held.
 */
export async function setActiveTenantId(userId: string, tenantId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
    UpdateExpression: 'SET activeTenantId = :t, activeTenantSetAt = :now',
    ExpressionAttributeValues: { ':t': tenantId, ':now': new Date().toISOString() },
  }));
}

/**
 * Stored as a DynamoDB list of strings. Anything else — absent, a legacy
 * scalar, a set — resolves to no access rather than to full access, so a
 * malformed record can never widen someone's reach.
 */
export function normalizeAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}
