import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, requireRoot, json } from '../../../shared/bms';
import { purgeTenant } from '../../../shared/tenant-purge';
import { getSubscription, isEntitled } from '../../../shared/subscription';

const PORTAL_USER_POOL_ID = process.env.PORTAL_USER_POOL_ID!;

/**
 * Removes a CloudMeter account and everything under it, from the staff side.
 *
 * The reason this exists: a customer whose subscription lapsed often never
 * closes their account, so their cloud credentials and cost history sit with
 * us indefinitely. Holding a lapsed customer's provider keys is a liability,
 * not a courtesy.
 *
 * Three guards, because this is irreversible and the person triggering it is
 * not the account's owner:
 *  - root only, not any staff member;
 *  - refused while the subscription is live, so a paying customer cannot be
 *    deleted by picking the wrong row;
 *  - the business name must be typed, which forces a look at what is about to
 *    go. The portal's own close flow accepts "DELETE" because the owner has
 *    only one account to lose; here there is a list of them.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  const notRoot = requireRoot(caller);
  if (notRoot) return json(403, { message: 'Only the solution owner can delete a CloudMeter account.' });

  const tenantId = event.pathParameters?.tenantId;
  if (!tenantId) return json(400, { message: 'tenantId is required' });

  let body: { confirmName?: unknown; force?: unknown };
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

  const name = (tenant.name as string) ?? '';
  if (typeof body.confirmName !== 'string' || body.confirmName.trim() !== name) {
    return json(400, { message: `Type the business name exactly — ${name} — to confirm.` });
  }

  const subscription = await getSubscription(tenantId);
  if (isEntitled(subscription) && body.force !== true) {
    return json(409, {
      message: `${name} still has an active subscription. End the plan first, or confirm you mean to delete a paying account.`,
      activeSubscription: true,
      planId: subscription.planId,
      currentPeriodEnd: subscription.currentPeriodEnd,
    });
  }

  const result = await purgeTenant(tenantId, PORTAL_USER_POOL_ID);

  // The one durable record that this happened: everything else is now gone.
  console.log('BMS deleted a CloudMeter account', {
    tenantId, name, by: caller.email, forced: body.force === true, ...result,
  });

  return json(200, { deleted: true, tenantId, name, ...result });
};
