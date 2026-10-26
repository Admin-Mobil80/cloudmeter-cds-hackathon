import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';

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
  // `available` separates "this provider doesn't report a location dimension"
  // from "it does and the total is zero" — the UI says different things for
  // each, and an empty array alone can't tell them apart.
  if (!current) return json(200, { available: false, regions: [] });

  const regions = current.regionBreakdown ?? [];
  return json(200, {
    available: regions.length > 0,
    monthKey: current.monthKey,
    regions,
  });
};
