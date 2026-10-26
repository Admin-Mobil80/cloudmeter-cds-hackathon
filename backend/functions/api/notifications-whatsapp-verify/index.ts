import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, UpdateCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json, requireWritable } from '../../shared/authz';
import { hashOtp } from '../../shared/otp';

/** Enough for a mistyped digit, few enough that guessing 6 digits is hopeless. */
const MAX_ATTEMPTS = 5;

/**
 * Completes WhatsApp verification and switches the channel on.
 *
 * The number is only stored against the user once a code sent to it has come
 * back, so a typo can't quietly subscribe a stranger to a company's costs.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  let body: { code?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const code = typeof body.code === 'string' ? body.code.replace(/[^0-9]/g, '') : '';
  if (code.length !== 6) return json(400, { message: 'Enter the 6-digit code.' });

  const key = { PK: `USER#${caller.userId}`, SK: 'WHATSAPP_VERIFY' };
  const { Item: pending } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));

  // TTL deletion is eventual, so an expired row can still be present. Check the
  // timestamp rather than trusting the row's existence.
  const expired = !pending || (pending.expiresAt as number) * 1000 < Date.now();
  if (expired) {
    return json(400, { message: 'That code has expired — send a new one.', expired: true });
  }

  if ((pending.attempts as number) >= MAX_ATTEMPTS) {
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));
    return json(429, { message: 'Too many incorrect attempts. Send a new code.' });
  }

  if (hashOtp(code, caller.userId) !== pending.codeHash) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET attempts = attempts + :one',
      ExpressionAttributeValues: { ':one': 1 },
    }));
    const left = MAX_ATTEMPTS - ((pending.attempts as number) + 1);
    return json(400, {
      message: left > 0
        ? `That code didn't match. ${left} attempt${left === 1 ? '' : 's'} left.`
        : "That code didn't match. Send a new one.",
    });
  }

  const phone = `+${pending.phone as string}`;

  // Merged into whatever preferences already exist rather than written whole:
  // this endpoint knows about the WhatsApp channel and nothing else, and must
  // not flatten the user's anomaly or digest settings on the way past.
  const { Item: prefs } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
  }));
  const channels = {
    ...(prefs?.channels as Record<string, unknown> ?? {}),
    whatsapp: { connected: true, phone, verifiedAt: new Date().toISOString() },
  };

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' },
    UpdateExpression: 'SET channels = :c, updatedAt = :now',
    ExpressionAttributeValues: { ':c': channels, ':now': new Date().toISOString() },
  }));

  // A pointer from the number back to this user, so the WhatsApp assistant can
  // tell who is messaging. Only a pointer: the assistant re-reads the channel
  // above on every message, so disconnecting needs no matching delete here.
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `WAPHONE#${(pending.phone as string).replace(/\D/g, '')}`,
      SK: `USER#${caller.userId}`,
      verifiedAt: channels.whatsapp.verifiedAt,
    },
  }));

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));

  return json(200, { verified: true, phone });
};
