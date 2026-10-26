import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, requireRole, json } from '../../shared/authz';
import { purgeTenant } from '../../shared/tenant-purge';

const USER_POOL_ID = process.env.USER_POOL_ID!;

/**
 * Permanently closes a workspace: every trace of it is destroyed with no
 * recovery path, per the product decision to make closure an immediate purge.
 *
 * Ordering matters. Provider credentials go first (the most sensitive thing we
 * hold), then application data, then the logins themselves — deleting logins
 * first would leave orphaned data no one could ever reach to clean up.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const forbidden = requireRole(caller, ['owner']);
  if (forbidden) return forbidden;

  const tenantId = caller.membership.tenantId;

  let body: { confirm?: string; confirmName?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));
  if (!tenant) return json(404, { message: 'CloudMeter account not found' });

  // Typing something deliberate is the last line of defence against an
  // irreversible action — never accept a bare boolean flag for this. The word
  // DELETE replaced the organization name: people rename their organization,
  // and having to go and look up its exact current spelling made an already
  // stressful confirmation into a guessing game. `confirmName` is still
  // accepted so an older cached page keeps working.
  const typed = (body.confirm ?? body.confirmName ?? '').trim();
  const accepted = typed.toUpperCase() === 'DELETE' || typed === tenant.name;
  if (!accepted) {
    return json(400, { message: 'Type DELETE to confirm closure.' });
  }

  const result = await purgeTenant(tenantId, USER_POOL_ID);

  return json(200, {
    closed: true,
    deleted: {
      cloudAccounts: result.cloudAccounts,
      members: result.members,
      records: result.records,
      credentials: result.credentials,
      logins: result.logins,
    },
    keptLogins: result.keptLogins,
    // Surfaced rather than swallowed: a leftover secret or login is exactly
    // the kind of residue someone closing their account needs to know about.
    warnings: result.warnings,
  });
};
