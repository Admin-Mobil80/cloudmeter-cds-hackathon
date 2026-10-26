import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import type { ServiceBreakdownItem } from '../../../shared/seed-cost-data';
import { comparisonWindow, sumServicesInRange, deltaPct } from '../../../shared/period';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'MONTHLY#' },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const current = Items?.[0];
  if (!current) return json(200, { services: [] });

  const services = (current.serviceBreakdown ?? []) as ServiceBreakdownItem[];

  // The stored `trend` on each service is the part-month set against the whole
  // of the previous one, computed at write time — the same mistake the
  // dashboard tile had, baked into the row. It is recomputed here from the
  // daily rows over matching windows instead, so the answer does not depend on
  // how far through the month the sync happened to run.
  const window = comparisonWindow();
  if (!window) {
    // The 1st of the month: no complete day to compare. Say so rather than
    // carrying the stale stored figure through.
    return json(200, { services: services.map((s) => ({ ...s, trend: null })) });
  }

  const { Items: daily } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': `ACCOUNT#${accountId}`,
      ':from': `DAILY#${window.previousFrom}`,
      ':to': `DAILY#${window.currentTo}`,
    },
  }));

  const rows = (daily ?? []).map((d) => ({
    date: String(d.SK).replace('DAILY#', ''),
    services: (d.serviceBreakdown ?? []) as Array<{ name: string; spend: number }>,
  }));

  const nowWindow = sumServicesInRange(rows, window.currentFrom, window.currentTo);
  const thenWindow = sumServicesInRange(rows, window.previousFrom, window.previousTo);

  return json(200, {
    comparisonDays: window.days,
    services: services.map((s) => ({
      ...s,
      // Null where the service has no measured history to compare against —
      // a new service has not "stayed flat", and 0% would claim it had.
      trend: deltaPct(nowWindow.get(s.name) ?? 0, thenWindow.get(s.name) ?? 0),
    })),
  });
};
