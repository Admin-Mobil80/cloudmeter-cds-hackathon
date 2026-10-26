import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, canViewAccount, json, requireWritable } from '../../../shared/authz';

/**
 * Per-cloud-account notification switches.
 *
 * A Member has no organisation-wide Notifications page — nothing there is
 * theirs to set — so anomaly alerts and the daily digest are chosen on each
 * account they hold, one account at a time.
 *
 * Absent means on. Someone newly given an account should hear about it without
 * having to go and enable anything; these switches exist to quieten a specific
 * account, not to opt into one.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  // Only for accounts they can already see — the same rule the rest of the
  // account's data follows.
  if (!canViewAccount(caller, accountId)) return json(404, { message: 'Account not found' });

  let body: { anomaly?: unknown; digest?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const anomaly = body.anomaly === undefined ? undefined : !!body.anomaly;
  const digest = body.digest === undefined ? undefined : !!body.digest;
  if (anomaly === undefined && digest === undefined) {
    return json(400, { message: 'Nothing to update' });
  }

  // if_not_exists keeps this from clobbering the map when two accounts are
  // changed in quick succession, and from needing a read first.
  const sets: string[] = [];
  const names: Record<string, string> = { '#a': 'accounts', '#id': accountId };
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };

  if (anomaly !== undefined) {
    sets.push('#a.#id.#an = :anomaly');
    names['#an'] = 'anomaly';
    values[':anomaly'] = { enabled: anomaly };
  }
  if (digest !== undefined) {
    sets.push('#a.#id.#dg = :digest');
    names['#dg'] = 'digest';
    values[':digest'] = { enabled: digest };
  }

  // The nested map has to exist before its children can be set, and DynamoDB
  // won't create intermediate levels — so seed both, then write the leaves.
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
    UpdateExpression: 'SET #a = if_not_exists(#a, :empty)',
    ExpressionAttributeNames: { '#a': 'accounts' },
    ExpressionAttributeValues: { ':empty': {} },
  }));
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
    UpdateExpression: 'SET #a.#id = if_not_exists(#a.#id, :empty)',
    ExpressionAttributeNames: { '#a': 'accounts', '#id': accountId },
    ExpressionAttributeValues: { ':empty': {} },
  }));
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
    UpdateExpression: `SET ${sets.join(', ')}, accountPrefsUpdatedAt = :now`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return json(200, { accountId, anomaly, digest });
};
