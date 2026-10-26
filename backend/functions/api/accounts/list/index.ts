import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, visibleAccountIds, json } from '../../../shared/authz';
import { AdhocItem, ownMonthSpend, subscriberCount, subscriptionCount } from '../../../shared/adhoc';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ACCOUNT#' },
  }));

  // One extra query on the same partition tells us which managers are still on
  // the team. Without it an account handed to someone who has since left keeps
  // showing their name as if they were still answerable for it.
  const { Items: memberItems } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: 'userId',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'MEMBER#' },
  }));
  const activeMembers = new Set((memberItems ?? []).map((m) => m.userId as string));

  // Members see only the accounts they are mapped to; null means unrestricted.
  // Adhoc accounts are the exception — everyone records their own
  // subscriptions in them, so they are listed for the whole workspace and the
  // adhoc-items route filters what is inside. See loadAccountForCaller().
  const visible = visibleAccountIds(caller);
  const rows = visible === null
    ? (Items ?? [])
    : (Items ?? []).filter((a) => visible.includes(a.accountId as string) || a.provider === 'adhoc');

  // A Member's row for a shared adhoc account reads as their own spend, like
  // every other row on the page. The stored column is the whole workspace's,
  // and quoting that here would put their colleagues' subscriptions in a
  // figure labelled as theirs.
  const scoped = caller.membership.role === 'member';
  const spendFor = (a: Record<string, unknown>) => (
    scoped && a.provider === 'adhoc'
      ? ownMonthSpend((Array.isArray(a.adhocItems) ? a.adhocItems : []) as AdhocItem[], caller.userId)
      : a.spend
  );

  const accounts = rows.map((a) => ({
    id: a.accountId,
    provider: a.provider,
    name: a.name,
    externalId: a.externalId,
    status: a.status,
    dataSource: a.dataSource ?? 'seed',
    spend: spendFor(a),
    sync: a.sync,
    // Lets the UI hide a Remove button an Admin isn't allowed to use, rather
    // than offering it and failing the request.
    owner: a.owner ?? null,
    createdBy: a.createdBy ?? null,
    createdByEmail: a.createdByEmail ?? null,
    connectedByEmail: a.connectedByEmail ?? null,
    // null = nobody assigned, so there's nothing to be stale.
    managerActive: a.createdBy ? activeMembers.has(a.createdBy as string) : null,
    /*
     * How many people are on this tool. null where there is no figure to
     * give: a cloud provider, where the question has no meaning — an AWS bill
     * has no subscribers — and a Member, who is not shown it.
     *
     * Withheld here rather than hidden in the page. A Member sees only their
     * own lines inside an adhoc account, so how many colleagues are on a tool
     * is not theirs to read; leaving the number in the response and dropping
     * it in the UI would put it one network tab away, which is not the same
     * as not sending it.
     */
    subscribers: a.dataSource === 'adhoc' && !scoped
      ? subscriberCount((Array.isArray(a.adhocItems) ? a.adhocItems : []) as AdhocItem[])
      : null,
    /*
     * How many subscriptions are running on this tool — lines, not people.
     *
     * Beside the head count it says whether a tool is bought once or over and
     * over: "11 users · 11 subscriptions" is eleven separate purchases of the
     * same thing and an argument for a team plan, while "11 users · 1" is
     * already consolidated. Neither number alone distinguishes them.
     *
     * Withheld on exactly the same terms as `subscribers`, and for the same
     * reason: a Member reads only their own lines, so the account's total is
     * not theirs, and dropping it in the page rather than here would leave it
     * one network tab away.
     */
    subscriptions: a.dataSource === 'adhoc' && !scoped
      ? subscriptionCount((Array.isArray(a.adhocItems) ? a.adhocItems : []) as AdhocItem[])
      : null,
  }));

  return json(200, {
    accounts,
    // How many accounts this tenant has that the caller isn't mapped to.
    //
    // Free — the unfiltered query above already fetched them — and it is the
    // difference between "nothing is connected here" and "nothing has been
    // shared with you", which are opposite problems with opposite fixes. A
    // Member invited but never mapped to an account was being told the
    // organisation had connected nothing at all.
    //
    // Deliberately a count and nothing else: names, providers and spend are
    // exactly what this Member has not been granted.
    hiddenByScope: (Items ?? []).length - rows.length,
  });
};
