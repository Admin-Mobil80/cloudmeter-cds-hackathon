import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, json } from '../../../shared/authz';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { loadAccountForCaller } from '../../../shared/accounts';
import { AdhocItem, ownMonthSpend } from '../../../shared/adhoc';
import { coveredDaysFrom } from '../../../shared/period';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  // A Member may open any adhoc account — it is where they record their own
  // subscriptions. What they are shown inside it is filtered by the
  // adhoc-items route, and `spend` below is narrowed to their own lines.
  const account = await loadAccountForCaller(caller, accountId, { sharedAdhoc: true });
  if (!account) return json(404, { message: 'Account not found' });

  const scoped = caller.membership.role === 'member' && account.provider === 'adhoc';
  const spend = scoped
    ? ownMonthSpend(
      (Array.isArray(account.adhocItems) ? account.adhocItems : []) as AdhocItem[],
      caller.userId,
    )
    : account.spend;

  // Whether whoever this account is assigned to is still on the team — an
  // account managed by someone who has left needs reassigning, not a name that
  // looks current.
  let managerActive: boolean | null = null;
  if (account.createdBy) {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `MEMBER#${account.createdBy}` },
      ProjectionExpression: 'userId',
    }));
    managerActive = !!Item;
  }

  /*
   * How many days of this month the `spend` figure above actually covers.
   *
   * The page projects month-end from `spend`, and was dividing it by today's
   * date. But `spend` only contains days the provider has reported, and they
   * report a day behind — so every morning today sat in the divisor having
   * contributed nothing, and the projection read low by a day's worth. The
   * browser cannot work this out: it is handed a single total with no notion
   * of how many days made it.
   *
   * Only the keys are read, not the rows — enough to find the newest day
   * reported, which is all `coveredDaysFrom` needs.
   */
  const thisMonthKey = new Date().toISOString().slice(0, 7);
  const { Items: dayRows } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': `DAILY#${thisMonthKey}` },
    ProjectionExpression: 'SK',
  }));
  const coveredDays = coveredDaysFrom(
    (dayRows ?? []).map((r) => String(r.SK)),
    new Date().getDate(),
  );

  // The caller's own notification switches for this account. Absent means on.
  const { Item: prefs } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
  }));
  const mine = (prefs?.accounts as Record<string, Record<string, { enabled?: boolean }>> | undefined)?.[accountId];
  // A Member has no organisation-wide Notifications page, so this is where
  // they find out whether WhatsApp is set up — and where they set it up.
  const wa = (prefs?.channels as { whatsapp?: { connected?: boolean; phone?: string } } | undefined)?.whatsapp;

  return json(200, {
    id: account.accountId,
    notifications: {
      anomaly: mine?.anomaly?.enabled !== false,
      digest: mine?.digest?.enabled !== false,
      whatsapp: { connected: !!wa?.connected, phone: wa?.phone ?? null },
    },
    provider: account.provider,
    name: account.name,
    externalId: account.externalId,
    owner: account.owner ?? null,
    createdBy: account.createdBy ?? null,
    createdByEmail: account.createdByEmail ?? null,
    connectedByEmail: account.connectedByEmail ?? null,
    managerActive,
    status: account.status,
    dataSource: account.dataSource ?? 'seed',
    spend,
    // How many days of this month `spend` covers, so the page's month-end
    // projection divides by the days it is actually made of.
    coveredDays,
    sync: account.sync,
    lastSyncError: account.lastSyncError,
  });
};
