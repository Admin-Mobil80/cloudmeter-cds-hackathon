import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { getMembershipForUser, summarizeMemberships } from '../../shared/membership';
import { acceptPendingInvites } from '../../shared/invites';
import { resolveDisplayCurrency } from '../../shared/display-currency';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

// /me runs on every authenticated page load, which makes it the natural place
// to record activity — but writing on every view would be wasteful, so only
// refresh once the stored value is this stale.
const ACTIVITY_REFRESH_MS = 15 * 60 * 1000;

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub as string;
  const email = claims.email as string;

  // The only place an invitation to an *existing* CloudMeter user can be
  // accepted. The Cognito trigger that accepts invites fires on sign-up,
  // which for someone who already has an account never happens again — so
  // without this their invite stays pending forever and the account switcher
  // never appears. Best-effort: a failure here must not cost them a session.
  try {
    await acceptPendingInvites({ userId, email, name: claims.name as string | undefined });
  } catch (err) {
    console.error('Failed to accept pending invites', (err as Error).message);
  }

  const membership = await getMembershipForUser(userId);
  if (!membership) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'No tenant membership found' }),
    };
  }

  await touchLastActive(membership.tenantId, userId, membership.lastActiveAt);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      email,
      ...membership,
      // The sidebar badge is on every page, so it's answered here rather than
      // making each page fetch the whole alert list to count it.
      activeAlerts: await countActiveAlerts(membership.tenantId, userId, scopeFor(membership)),
      // Carried on /me so every page can format money without its own fetch.
      currency: await tenantCurrency(membership.tenantId),
      // What this role can reach, resolved server-side so the navigation and
      // the API can't disagree about it. These hide controls; they do not
      // enforce anything — every endpoint re-derives the same answer.
      canSeeOrgRollup: membership.role !== 'member',
      canSeeTeam: membership.role !== 'member',
      canManageAccounts: membership.role === 'owner' || membership.role === 'admin',
      // Every CloudMeter account this person belongs to. More than one means
      // the sidebar offers a switch; the active one is `tenantId` above.
      memberships: await summarizeMemberships(userId),
    }),
  };
};

/** null = every account in the tenant; a list = a Member's mapped accounts. */
function scopeFor(membership: { role: string; accountIds: string[] }): string[] | null {
  return membership.role === 'member' ? membership.accountIds : null;
}

/**
 * Unread alerts — the number the sidebar badge shows, inbox-style, per
 * person: `readBy` is a set of user IDs who've opened an alert, so one
 * person reading it doesn't clear anyone else's badge. A Member's badge
 * counts only alerts on accounts they can open, or it would advertise
 * problems they can't look at.
 */
async function countActiveAlerts(tenantId: string, userId: string, visible: string[] | null): Promise<number> {
  try {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ALERT#' },
      ProjectionExpression: 'accountId, readBy, seenBefore',
    }));
    const seen = (set: unknown) => set instanceof Set && set.has(userId);
    return (Items ?? [])
      // Never opened by this person. An alert they read and the sweep has
      // since refreshed sits in `seenBefore` and is deliberately excluded:
      // the list marks it "updated", and counting it here would put the badge
      // straight back to climbing on its own — which is the whole reason the
      // read state is now carried forward instead of cleared.
      .filter((a) => !seen(a.readBy) && !seen(a.seenBefore))
      .filter((a) => visible === null || visible.includes((a.accountId as string) ?? ''))
      .length;
  } catch (err) {
    // A badge is not worth failing the session lookup over.
    console.error('Failed to count alerts', (err as Error).message);
    return 0;
  }
}

async function touchLastActive(tenantId: string, userId: string, current: string | null): Promise<void> {
  const now = Date.now();
  if (current && now - new Date(current).getTime() < ACTIVITY_REFRESH_MS) return;

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `MEMBER#${userId}` },
      UpdateExpression: 'SET lastActiveAt = :now',
      ExpressionAttributeValues: { ':now': new Date(now).toISOString() },
    }));
  } catch (err) {
    // Activity tracking is cosmetic — never fail the session lookup over it.
    console.error('Failed to update lastActiveAt', (err as Error).message);
  }
}

/** The tenant's display currency, resolved for the money formatter in the UI. */
async function tenantCurrency(tenantId: string) {
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    }));
    return await resolveDisplayCurrency(Item ?? {});
  } catch (err) {
    // Money must still render if this fails; USD is the stored unit.
    console.error('Display currency lookup failed', (err as Error).message);
    return { code: 'USD', symbol: '$', rate: 1, localCode: 'USD', mode: 'USD', source: 'auto', rateSource: 'unavailable', rateAsOf: null };
  }
}
