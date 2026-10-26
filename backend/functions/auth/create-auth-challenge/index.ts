import type { CreateAuthChallengeTriggerHandler } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { generateOtp, hashOtp } from '../../shared/otp';

const ses = new SESClient({});
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const OTP_TTL_SECONDS = 5 * 60;

/*
 * The app-store review login.
 *
 * Apple and Google require a working demo account, and their reviewers cannot
 * receive our one-time code: sign-in emails it, and they have no access to the
 * mailbox. Without this, the reviewer reaches the code screen, waits, and
 * rejects the build as "unable to sign in" — the most common rejection for an
 * OTP app.
 *
 * So exactly one address gets a fixed code and no email. It is a standing
 * credential, and it is contained on purpose:
 *
 *   - one address, compared exactly, lower-cased — not a pattern or a domain;
 *   - it unlocks a demo workspace holding generated sample data and no cloud
 *     credentials, so the worst case is a stranger reading invented numbers;
 *   - the code still goes through the same storage and the same constant-time
 *     verification as a real one. Nothing here weakens verify-auth-challenge,
 *     and no other account is affected by any of it;
 *   - both values come from the environment, so deleting them from the stack
 *     removes the login without touching this file.
 *
 * Empty env vars disable it entirely, which is the state of any environment
 * that has not deliberately set them.
 */
const DEMO_EMAIL = (process.env.DEMO_LOGIN_EMAIL ?? '').trim().toLowerCase();
const DEMO_CODE = (process.env.DEMO_LOGIN_CODE ?? '').trim();
// Longer than a real code's five minutes: a reviewer reads the notes, types
// the address, and may well be interrupted before entering the code. An
// expiry they have to work around reads to them as a broken login.
const DEMO_TTL_SECONDS = 60 * 60;

function isDemoLogin(email: string): boolean {
  if (!DEMO_EMAIL || !DEMO_CODE) return false;
  return email.trim().toLowerCase() === DEMO_EMAIL;
}

// Fires on first challenge issuance and on every resend — a fresh code is
// generated each time and overwrites the prior one for this email.
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email;
  const demo = isDemoLogin(email);
  const code = demo ? DEMO_CODE : generateOtp();
  const now = Math.floor(Date.now() / 1000);

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `OTP#${email}`,
      SK: `OTP#${email}`,
      codeHash: hashOtp(code, email),
      attempts: 0,
      expiresAt: now + (demo ? DEMO_TTL_SECONDS : OTP_TTL_SECONDS),
      createdAt: now,
    },
  }));

  // No email for the demo login: the address has no mailbox behind it, and a
  // bounce per sign-in would sit in our SES reputation for nothing.
  if (!demo) await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [email] },
    Message: {
      // The code leads the subject so a phone's lock-screen notification
      // carries it: most people read it there and never open the message.
      Subject: { Data: `${code} is your CloudMeter sign-in code` },
      Body: {
        Text: { Data: `Your CloudMeter one-time code is ${code}. It expires in 5 minutes.` },
        Html: {
          Data: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1a1a1a">
            <p>Your CloudMeter one-time code is:</p>
            <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
            <p style="color:#6b7280">It expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
          </div>`,
        },
      },
    },
  }));

  event.response.publicChallengeParameters = { email };
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = demo ? 'OTP_DEMO' : 'OTP_EMAIL';
  return event;
};
