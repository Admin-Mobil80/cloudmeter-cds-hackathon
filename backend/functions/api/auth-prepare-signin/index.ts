import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomBytes } from 'crypto';
import { GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { setActiveTenantId } from '../../shared/membership';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

/**
 * Public (unauthenticated) endpoint called before sign-in.
 *
 * Two jobs:
 *
 * 1. An invited teammate was already vouched for by someone in the workspace,
 *    so making them "sign up" is wrong — they should just sign in. Cognito
 *    requires the user to exist before CUSTOM_AUTH works, so this provisions
 *    the account on their behalf, but *only* when a genuine pending invite
 *    exists for that exact address. It is not an open sign-up path.
 *
 * 2. It answers whether sign-in can actually succeed, so the login page can
 *    say "you don't have access" instead of sending an OTP to someone with no
 *    workspace and parking them on a code screen no code will ever satisfy.
 *
 * `canSignIn` means both halves are in place: a Cognito login *and* a
 * workspace membership. Either alone is a dead end.
 */
export const handler = async (event: APIGatewayProxyEventV2) => {
  const reply = (canSignIn: boolean) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, canSignIn }),
  });

  let email: string;
  try {
    const body = JSON.parse(event.body ?? '{}') as { email?: string };
    email = (body.email ?? '').trim().toLowerCase();
  } catch {
    return reply(false);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(false);

  try {
    return reply(await prepare(email));
  } catch (err) {
    // Never surface internals to an unauthenticated caller. Fail open on the
    // decision: a transient AWS error shouldn't lock out a legitimate user, so
    // let sign-in proceed and let Cognito be the authority.
    console.error('prepare-signin failed', (err as Error).message);
    return reply(true);
  }
};

async function prepare(email: string): Promise<boolean> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :e',
    FilterExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':e': `EMAIL#${email}`, ':pending': 'pending' },
  }));
  const invite = Items?.[0];

  // No invite to act on: this is an ordinary sign-in, so just report whether
  // there's actually an account behind the address. Nothing is provisioned.
  if (!invite) {
    const login = await lookupLogin(email);
    return !!login && !!(await findMembership(login.sub));
  }

  const tenantId = String(invite.PK).replace('TENANT#', '');

  // The Cognito login and the workspace membership are two separate things,
  // and either can exist without the other. Removing someone from a team
  // deletes their membership but leaves their login intact, so "the login
  // already exists" must not be read as "they're already set up" — that's
  // how a re-invited teammate ended up able to sign in with no membership,
  // leaving every page stuck because /me had no tenant to return.
  const login = (await lookupLogin(email)) ?? { sub: await createConfirmedUser(email) };
  const sub = login.sub;
  const now = new Date().toISOString();

  // Already in this CloudMeter account — nothing to create, just settle the
  // outstanding invite.
  if (await hasMembershipIn(sub, tenantId)) {
    await acceptInvite(invite.PK, invite.SK, now);
    return true;
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `MEMBER#${sub}`,
      GSI1PK: `USER#${sub}`,
      GSI1SK: `TENANT#${tenantId}`,
      userId: sub,
      email,
      // Precedence: the name they gave at sign-up, then the one the inviter
      // typed, then a slice of the address as a last resort.
      name: login.name || (invite.name as string) || email.split('@')[0],
      role: invite.role,
      status: 'active',
      // Mapped at invite time, so a Member's first sign-in shows the accounts
      // they were brought in for rather than an empty portal. Only Members
      // carry a mapping; an invited Admin sees everything regardless.
      ...(invite.role === 'member' && Array.isArray(invite.accountIds) && invite.accountIds.length
        ? { accountIds: invite.accountIds }
        : {}),
      invitedAt: invite.invitedAt ?? now,
      joinedAt: now,
      lastActiveAt: now,
    },
  }));

  await acceptInvite(invite.PK, invite.SK, now);

  // Land them in the account they were just invited to. Someone who already
  // belonged elsewhere would otherwise sign in, see their old account, and
  // conclude the invitation silently failed.
  await setActiveTenantId(sub, tenantId);
  return true;
}

// Returns the existing login's sub and name, or null when there is no such
// login. The name is whatever they gave at sign-up, and is a better label for
// the team list than a slice of their email address.
async function lookupLogin(email: string): Promise<{ sub: string; name?: string } | null> {
  try {
    const user = await cognito.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
    }));
    const attr = (n: string) => user.UserAttributes?.find((a) => a.Name === n)?.Value;
    const sub = attr('sub');
    if (!sub) throw new Error('existing Cognito user has no sub attribute');
    return { sub, name: attr('name') };
  } catch (err) {
    if (err instanceof UserNotFoundException) return null;
    throw err;
  }
}

/** Whether this user is already a member of one specific tenant. */
async function hasMembershipIn(sub: string, tenantId: string): Promise<boolean> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `MEMBER#${sub}` },
    ProjectionExpression: 'userId',
  }));
  return !!Item;
}

// Whether this user belongs to any tenant at all. Sign-in needs a login *and*
// somewhere to sign in to; either alone is a dead end.
async function findMembership(sub: string): Promise<string | null> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :u',
    ExpressionAttributeValues: { ':u': `USER#${sub}` },
    Limit: 1,
  }));
  const item = Items?.[0];
  return item ? String(item.PK).replace('TENANT#', '') : null;
}

async function acceptInvite(pk: string, sk: string, now: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
    UpdateExpression: 'SET #status = :accepted, acceptedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':accepted': 'accepted', ':now': now },
  }));
}

async function createConfirmedUser(email: string): Promise<string> {
  const created = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    // The address is already proven by the invite, and the OTP challenge
    // proves control at sign-in — so no Cognito invitation email is needed.
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
  }));

  // AdminCreateUser leaves the user in FORCE_CHANGE_PASSWORD, which blocks the
  // custom-auth flow. This pool is passwordless (OTP only), so a throwaway
  // permanent password exists purely to move the account to CONFIRMED; it is
  // never used or returned to anyone.
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    Password: `Aa1!${randomBytes(24).toString('base64url')}`,
    Permanent: true,
  }));

  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error('Cognito did not return a sub for the new user');
  return sub;
}
