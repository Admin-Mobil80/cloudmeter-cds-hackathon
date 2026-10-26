import type { VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';
import { timingSafeEqual } from 'crypto';
import { GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { hashOtp } from '../../shared/otp';

const MAX_ATTEMPTS = 5;

/** Constant-time compare of two hex digests of the same length. */
function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email;
  const submitted = (event.request.challengeAnswer ?? '').trim();

  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `OTP#${email}`, SK: `OTP#${email}` },
  }));

  const now = Math.floor(Date.now() / 1000);

  if (!Item || Item.expiresAt < now || Item.attempts >= MAX_ATTEMPTS) {
    event.response.answerCorrect = false;
    return event;
  }

  // Constant-time, so the comparison itself leaks nothing about how much of
  // the hash matched. Five attempts and a six-digit code make a timing oracle
  // impractical anyway, but this is the same primitive the webhook signature
  // checks already use and it costs nothing to be consistent.
  const correct = hashesEqual(String(Item.codeHash ?? ''), hashOtp(submitted, email));

  if (correct) {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `OTP#${email}`, SK: `OTP#${email}` },
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `OTP#${email}`, SK: `OTP#${email}` },
      UpdateExpression: 'SET attempts = attempts + :one',
      ExpressionAttributeValues: { ':one': 1 },
    }));
  }

  event.response.answerCorrect = correct;
  return event;
};
