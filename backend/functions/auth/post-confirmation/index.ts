import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { acceptPendingInvites } from '../../shared/invites';

// Fires once, immediately after a new account is confirmed (which happens
// instantly since PreSignUp auto-confirms) — not after OTP sign-in.
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const userId = event.request.userAttributes.sub;
  const email = event.request.userAttributes.email;
  const name = event.request.userAttributes.name ?? email;
  const now = new Date().toISOString();

  // Someone invited before they signed up joins the account(s) they were
  // invited to rather than getting one of their own. Every pending invite is
  // honoured, not just the first — being invited to two accounts is a
  // perfectly ordinary thing that used to silently drop one of them.
  if (await acceptPendingInvites({ userId, email, name })) {
    return event;
  }

  const tenantId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `TENANT#${tenantId}`,
      tenantId,
      // Placeholder only: the sign-up form collects the real organization name
      // and applies it on the first authenticated request. A trigger can't see
      // that form, so it names the account after the email domain rather than
      // after the person — nobody wants a personal name labelling their org.
      name: email.split('@')[1] ?? name,
      ownerId: userId,
      planTier: 'trial',
      createdAt: now,
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
      name,
      role: 'owner',
      status: 'active',
      invitedAt: now,
      lastActiveAt: now,
    },
  }));

  return event;
};
