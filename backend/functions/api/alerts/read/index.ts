import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, canViewAccount, json } from '../../../shared/authz';

// Marks an alert read — an inbox-style "I've seen this," not a management
// action, so anyone who can see the alert can clear it from the unread
// count. No role check: unlike the removed acknowledge/snooze/escalate
// actions, this changes nothing about the alert itself.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const alertId = event.pathParameters?.alertId;
  if (!alertId) return json(400, { message: 'Missing alert id' });

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ALERT#' },
  }));

  const alert = (Items ?? []).find((a) => a.id === alertId);
  if (!alert) return json(404, { message: 'Alert not found' });

  if (!canViewAccount(caller, (alert.accountId as string) ?? '')) {
    return json(403, { message: 'Not visible to you' });
  }

  // ADD onto a string set: idempotent (adding a member already present is a
  // no-op) and per-person, so one person opening an alert doesn't clear it
  // for anyone else's unread count.
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: alert.PK, SK: alert.SK },
    UpdateExpression: 'ADD readBy :u',
    ExpressionAttributeValues: { ':u': new Set([caller.userId]) },
  }));

  return json(200, { id: alertId, read: true });
};
