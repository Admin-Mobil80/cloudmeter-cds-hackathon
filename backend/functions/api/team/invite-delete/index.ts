import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';

// Revokes a pending invitation. Whoever can send an invite can withdraw one.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const token = event.pathParameters?.token;
  if (!token) return json(400, { message: 'token is required' });

  // Scoped to the caller's own tenant, so a token from another workspace
  // simply isn't found.
  const key = { PK: `TENANT#${caller.membership.tenantId}`, SK: `INVITE#${token}` };
  const { Item: invite } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (!invite) return json(404, { message: 'Invitation not found' });

  if (invite.status !== 'pending') {
    return json(400, { message: 'That invitation has already been accepted — remove the member instead.' });
  }

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));

  return json(204, {});
};
