import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { json } from '../../../shared/authz';
import { getMembershipsForUser, setActiveTenantId } from '../../../shared/membership';
import { DEFAULT_TIMEZONE } from '../../../shared/schedule';
import { trialEndFrom } from '../../../shared/subscription-period';
import { getPricing } from '../../../shared/pricing';

const MAX_NAME_LENGTH = 80;

/**
 * One email address owns at most one CloudMeter account.
 *
 * Ownership is the billing relationship — an owner is who the subscription is
 * charged to and who can close the account — so tying it one-to-one with an
 * email keeps "who pays for this" unambiguous. It also closes the trial-farming
 * hole: every new account starts a fresh 7-day trial derived from its creation
 * date, so an unbounded limit would let one address mint them indefinitely.
 *
 * Being *in* several accounts is unaffected: the same person can be Admin or
 * Member of as many as they're invited to. Only owning is capped, and only
 * accounts they own count toward it.
 */
const MAX_OWNED_TENANTS = 1;

/**
 * Creates an additional CloudMeter account for someone who already has one.
 *
 * Sign-up can't do this: it is keyed on the email address, and Cognito
 * rightly refuses a second login for an address that already has one — so
 * anyone already on a team was told "an account with this email already
 * exists, try signing in", with no way forward. Being invited into a second
 * account worked; creating one didn't. This closes that.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub as string;
  const email = claims.email as string;

  let body: { name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { message: 'Give the new CloudMeter account a name.' });
  if (name.length > MAX_NAME_LENGTH) {
    return json(400, { message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  const memberships = await getMembershipsForUser(userId);
  const owned = memberships.filter((m) => m.role === 'owner');
  if (owned.length >= MAX_OWNED_TENANTS) {
    return json(409, {
      message: 'This email already owns a CloudMeter account, and one email can own only one. '
        + 'You can still be added to any number of other accounts as an Admin or Member — '
        + 'ask their owner to invite you.',
    });
  }

  // Carried over from an existing membership so the same person isn't listed
  // under a different name in each of their accounts.
  const displayName = (memberships.find((m) => m.name)?.name as string | undefined)
    ?? (claims.name as string | undefined)
    ?? email;

  const tenantId = randomUUID();
  const now = new Date().toISOString();
  // Read at creation, so a trial-length change in BMS applies to accounts
  // made from now on and never shifts a deadline someone is already on.
  const trialEnd = trialEndFrom(now, (await getPricing()).trialDays);

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
      timezone: DEFAULT_TIMEZONE,
      // Provenance, so BMS can tell an account somebody created for themselves
      // from one that came through sign-up — the two want different scrutiny.
      createdVia: 'self-service',
      createdByUserId: userId,
      createdByEmail: email,
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
      name: displayName,
      role: 'owner',
      status: 'active',
      joinedAt: now,
      lastActiveAt: now,
    },
  }));

  // They asked for this account; land them in it rather than making them
  // find it in the switcher straight afterwards.
  await setActiveTenantId(userId, tenantId);

  console.log('Self-service CloudMeter account created', { tenantId, by: email });

  return json(201, { tenantId, name });
};
