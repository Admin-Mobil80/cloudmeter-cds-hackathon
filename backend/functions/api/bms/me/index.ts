import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, json, BMS_PK } from '../../../shared/bms';

/**
 * Who the signed-in staff member is.
 *
 * A 403 here is the console's cue that a valid BMS login has no access record —
 * the sign-in worked but somebody revoked them, which is worth saying plainly
 * rather than leaving every panel empty.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'This sign-in has no BMS access.' });

  // Cheap enough to write every load; the list uses it to show who is around.
  ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: BMS_PK, SK: `USER#${caller.email}` },
    UpdateExpression: 'SET lastActiveAt = :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
  })).catch((err) => console.error('lastActiveAt update failed', err.message));

  return json(200, caller.user);
};
