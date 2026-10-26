import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, canManageAccount, json, requireWritable } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import { deleteCredentials } from '../../../shared/secrets';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  // Owners and Admins both. A Member mapped to the account can read its costs
  // but never destroy it along with its stored history.
  if (!canManageAccount(caller, account)) {
    return json(403, {
      message: `Only an Admin or the account owner can remove ${account.name}.`,
    });
  }

  const { Items: monthly } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}` },
  }));

  await Promise.all([
    ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `ACCOUNT#${accountId}` },
    })),
    ...(monthly ?? []).map((m) =>
      ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: m.PK, SK: m.SK } })),
    ),
  ]);

  // Removing the account revokes CloudMeter's stored copy of the customer's
  // credentials too (scheduled deletion, so an accidental removal is
  // recoverable within the window).
  if (account.credentialsSecretArn) {
    await deleteCredentials(account.credentialsSecretArn);
  }

  return json(204, {});
};
