import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomBytes } from 'crypto';
import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, requireRoot, listBmsUsers, getBmsUser, json, BMS_PK } from '../../../shared/bms';
import { renderEmailHtml, renderEmailText, displayName } from '../../../shared/email-layout';

const cognito = new CognitoIdentityProviderClient({});
const ses = new SESClient({});
const USER_POOL_ID = process.env.BMS_USER_POOL_ID!;
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const BMS_URL = process.env.BMS_URL!;

/**
 * BMS staff: list, add, remove.
 *
 * Adding creates the Cognito identity too — the pool has self sign-up
 * disabled, so without that step the person could never complete the OTP flow
 * and the record would be a promise nothing honours.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  const method = event.requestContext.http.method;

  if (method === 'GET') {
    return json(200, { users: await listBmsUsers(), viewer: caller.user });
  }

  const notRoot = requireRoot(caller);
  if (notRoot) return notRoot;

  if (method === 'DELETE') {
    const email = decodeURIComponent(event.pathParameters?.email ?? '').toLowerCase();
    if (!email) return json(400, { message: 'email is required' });
    if (email === caller.email) {
      return json(400, { message: "You can't remove your own access." });
    }

    const target = await getBmsUser(email);
    if (!target) return json(404, { message: 'No such BMS user' });
    if (target.role === 'root') {
      return json(400, { message: 'The solution owner cannot be removed.' });
    }

    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: BMS_PK, SK: `USER#${email}` },
    }));
    // The login goes too: a BMS identity has no purpose outside this console.
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    } catch (err) {
      if (!(err instanceof UserNotFoundException)) throw err;
    }
    return json(204, {});
  }

  // POST — add a user.
  let body: { email?: unknown; name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { message: 'A valid email address is required' });
  }
  if (await getBmsUser(email)) {
    return json(409, { message: `${email} already has BMS access.` });
  }

  // Cognito requires a password even though CUSTOM_AUTH never uses one; it is
  // generated, set, and immediately forgotten.
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        ...(name ? [{ Name: 'name', Value: name }] : []),
      ],
    }));
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      Password: `Aa1!${randomBytes(18).toString('base64url')}`,
      Permanent: true,
    }));
  } catch (err) {
    // A login left over from a previous removal is fine to reuse.
    if (!(err instanceof UsernameExistsException)) throw err;
  }

  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: BMS_PK,
      SK: `USER#${email}`,
      email,
      name: name || null,
      role: 'staff',
      status: 'active',
      createdAt: now,
      createdBy: caller.email,
    },
  }));

  await notifyNewUser(email, name, caller.email);

  return json(201, { email, name: name || null, role: 'staff', status: 'active', createdAt: now });
};

async function notifyNewUser(email: string, name: string, actorEmail: string): Promise<void> {
  const mail = {
    title: 'You have access to the CloudMeter BMS',
    paragraphs: [
      `${displayName(null, actorEmail)} gave you access to the CloudMeter Business Management System.`,
      'Sign in with this address and we will email you a one-time code — no password to set up.',
      'The BMS administers every CloudMeter account on the platform, including their plans and subscriptions.',
    ],
    cta: { label: 'Open the BMS', url: BMS_URL },
    footnote: `Signing in with ${email}.`,
  };
  try {
    await ses.send(new SendEmailCommand({
      Source: `CloudMeter <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: mail.title },
        Body: { Text: { Data: renderEmailText(mail) }, Html: { Data: renderEmailHtml(mail) } },
      },
    }));
  } catch (err) {
    console.error('BMS welcome email failed', (err as Error).message);
  }
}
