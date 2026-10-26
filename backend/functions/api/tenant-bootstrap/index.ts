import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { json } from '../../shared/authz';
import { getMembershipForUser } from '../../shared/membership';
import { isValidTimezone, DEFAULT_TIMEZONE } from '../../shared/schedule';
import { trialEndFrom } from '../../shared/subscription-period';
import { getPricing } from '../../shared/pricing';

const MAX_NAME_LENGTH = 80;

/**
 * Called once, right after a sign-up's first successful authentication, to
 * make sure the caller has a CloudMeter account named after their business.
 *
 * It exists because a Cognito login and a CloudMeter account are separate
 * things. The sign-up trigger creates both for a brand-new login — but someone
 * who was invited to a workspace and later removed keeps their login with no
 * membership behind it. Signing up again used to fail ("an account with this
 * email already exists") while signing in reported no access: a dead end where
 * their own email could never start a workspace. This closes it.
 *
 * Deliberately not an escalation path. It only ever *adds* a membership where
 * the caller had none; anyone who already belongs somewhere keeps exactly the
 * role they had, and only an owner can rename.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub as string;
  const email = claims.email as string;
  const cognitoName = (claims.name as string) || email.split('@')[0];

  let body: { name?: unknown; timezone?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const requested = typeof body.name === 'string' ? body.name.trim() : '';
  // Read from the browser at sign-up rather than asked for on the form. The
  // browser already knows it, and making someone pick from four hundred zone
  // names is friction at the step with the highest drop-off — for a value we
  // can infer correctly and they can change later in Settings.
  const timezone = isValidTimezone(body.timezone) ? body.timezone : null;
  if (requested.length > MAX_NAME_LENGTH) {
    return json(400, { message: `Organization name must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  const existing = await getMembershipForUser(userId);

  if (existing) {
    // Normal sign-up: the Cognito trigger already made the account, so this
    // just applies the organization name from the form. Owner-only, same as
    // renaming from Settings.
    if (requested && existing.role === 'owner') {
      // Backfills the timezone for accounts created before it was captured,
      // but never overwrites one that's already set — Settings wins.
      const setTz = timezone && !existing.timezone;
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${existing.tenantId}`, SK: `TENANT#${existing.tenantId}` },
        UpdateExpression: `SET #name = :n, nameUpdatedAt = :now${setTz ? ', #tz = :tz' : ''}`,
        ExpressionAttributeNames: {
          '#name': 'name',
          ...(setTz ? { '#tz': 'timezone' } : {}),
        },
        ExpressionAttributeValues: {
          ':n': requested,
          ':now': new Date().toISOString(),
          ...(setTz ? { ':tz': timezone } : {}),
        },
      }));
      return json(200, { created: false, renamed: true, tenantId: existing.tenantId, name: requested });
    }
    return json(200, { created: false, renamed: false, tenantId: existing.tenantId, name: existing.tenantName });
  }

  // A login with nothing behind it. Give them their own account, as sign-up
  // would have done had the login not already existed.
  const tenantId = randomUUID();
  const now = new Date().toISOString();
  // Read at creation, so a trial-length change in BMS applies to accounts
  // made from now on and never shifts a deadline someone is already on.
  const trialEnd = trialEndFrom(now, (await getPricing()).trialDays);
  const name = requested || (email.split('@')[1] ?? cognitoName);

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `TENANT#${tenantId}`,
      tenantId,
      name,
      ownerId: userId,
      planTier: 'trial',
      // Stored, not derived on read. A trial is a period with an end date like
      // any other, so it appears in BMS, drives the renewal reminder, and can
      // be extended for one account without special-casing anything.
      trialEndsAt: trialEnd,
      createdAt: now,
      timezone: timezone ?? DEFAULT_TIMEZONE,
    },
  }));

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `MEMBER#${userId}`,
      GSI1PK: `USER#${userId}`,
      GSI1SK: `TENANT#${tenantId}`,
      userId,
      email,
      name: cognitoName,
      role: 'owner',
      status: 'active',
      invitedAt: now,
      joinedAt: now,
      lastActiveAt: now,
    },
    // Two tabs finishing sign-up at once must not create two accounts for the
    // same person; whichever loses simply falls through to the existing one.
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));

  return json(201, { created: true, tenantId, name, timezone: timezone ?? DEFAULT_TIMEZONE });
};
