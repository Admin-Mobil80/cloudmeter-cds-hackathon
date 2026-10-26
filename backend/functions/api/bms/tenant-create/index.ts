import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID, randomBytes } from 'crypto';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, json } from '../../../shared/bms';
import { planById } from '../../../shared/plans';
import { oneMonthOn, trialEndFrom } from '../../../shared/subscription-period';
import { getPricing } from '../../../shared/pricing';
import { renderEmailHtml, renderEmailText, displayName } from '../../../shared/email-layout';

const cognito = new CognitoIdentityProviderClient({});
const ses = new SESClient({});
const PORTAL_USER_POOL_ID = process.env.PORTAL_USER_POOL_ID!;
const PORTAL_URL = process.env.PORTAL_URL!;
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;

/**
 * Onboards a business from the staff console.
 *
 * The self-serve path creates a tenant as a side effect of someone signing up;
 * this is the sales path, where the account exists before its owner has ever
 * visited. It provisions the portal login too, so the owner's first action is
 * to sign in rather than to sign up — an account they were told exists should
 * exist.
 *
 * A plan can be set at the same time, which is the point: these are the
 * accounts billed outside Stripe.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  let body: {
    businessName?: unknown; ownerEmail?: unknown; ownerName?: unknown;
    planId?: unknown; currentPeriodEnd?: unknown; timezone?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const businessName = typeof body.businessName === 'string' ? body.businessName.trim().slice(0, 80) : '';
  const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
  const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim().slice(0, 80) : '';

  if (!businessName) return json(400, { message: 'A business name is required' });
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return json(400, { message: 'A valid owner email is required' });
  }

  const plan = body.planId ? planById(String(body.planId)) : null;
  if (body.planId && !plan) return json(400, { message: 'Unknown plan' });

  // Derived, not supplied — same rule as every other subscription: one month
  // from the start, extended only by renewing. A date sent here is refused
  // rather than ignored, so a caller never believes it was used.
  if (body.currentPeriodEnd !== undefined) {
    return json(400, {
      message: 'The end date is always one month from the start and cannot be set directly.',
    });
  }
  const periodEnd: string | null = plan ? oneMonthOn() : null;

  // Reuse the login if they already have one — the same person can own more
  // than one CloudMeter account, and a second Cognito user for one address is
  // impossible anyway.
  let userId: string;
  try {
    const existing = await cognito.send(new AdminGetUserCommand({
      UserPoolId: PORTAL_USER_POOL_ID,
      Username: ownerEmail,
    }));
    userId = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? '';
    if (!userId) return json(500, { message: 'Existing login has no sub attribute' });
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
    const created = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: PORTAL_USER_POOL_ID,
      Username: ownerEmail,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: ownerEmail },
        { Name: 'email_verified', Value: 'true' },
        ...(ownerName ? [{ Name: 'name', Value: ownerName }] : []),
      ],
    }));
    userId = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? '';
    if (!userId) return json(500, { message: 'Could not create the portal login' });

    // CUSTOM_AUTH never uses a password, but Cognito insists one exists.
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: PORTAL_USER_POOL_ID,
      Username: ownerEmail,
      Password: `Aa1!${randomBytes(18).toString('base64url')}`,
      Permanent: true,
    }));
  }

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
      name: businessName,
      ownerId: userId,
      createdAt: now,
      createdVia: 'bms',
      createdBy: caller.email,
      // Dated even when a plan is set — the trial clock is what applies if the
      // plan is later cleared, and an account with no dates at all is exactly
      // what the renewal sweep cannot act on.
      trialEndsAt: trialEnd,
      ...(typeof body.timezone === 'string' && body.timezone ? { timezone: body.timezone } : {}),
      ...(plan ? {
        planId: plan.id,
        subscriptionStatus: 'active',
        subscriptionSource: 'bms',
        subscriptionSetBy: caller.email,
        subscriptionUpdatedAt: now,
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      } : {}),
    },
    // Refuses rather than overwriting, however unlikely a UUID collision is.
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `MEMBER#${userId}`,
      GSI1PK: `USER#${userId}`,
      GSI1SK: `TENANT#${tenantId}`,
      userId,
      email: ownerEmail,
      name: ownerName || ownerEmail.split('@')[0],
      role: 'owner',
      status: 'active',
      invitedAt: now,
      joinedAt: now,
    },
  }));

  // Land them here on next sign-in. Someone who already owns another account
  // would otherwise see that one and wonder where the new one went.
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: `USER#${userId}`, SK: 'PROFILE', activeTenantId: tenantId, activeTenantSetAt: now },
  }));

  await welcomeOwner(ownerEmail, ownerName, businessName, plan?.name ?? null);

  console.log('BMS onboarded a business', { tenantId, businessName, ownerEmail, by: caller.email, plan: plan?.id ?? null });

  return json(201, {
    tenantId,
    name: businessName,
    ownerEmail,
    planId: plan?.id ?? null,
    currentPeriodEnd: periodEnd,
  });
};

async function welcomeOwner(
  email: string, name: string, businessName: string, planName: string | null,
): Promise<void> {
  const mail = {
    title: `${businessName} is ready on CloudMeter`,
    paragraphs: [
      `Hello ${displayName(name || null, email)} — your CloudMeter account for ${businessName} has been set up.`,
      planName
        ? `You're on the ${planName} plan. Nothing to pay online; we'll invoice you directly.`
        : 'You can connect your cloud accounts and see costs straight away.',
      'Sign in with this address and we will email you a one-time code — there is no password to set.',
    ],
    cta: { label: 'Sign in to CloudMeter', url: `${PORTAL_URL}/login.html?mode=signin&email=${encodeURIComponent(email)}` },
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
    // The account exists either way; a failed welcome must not undo it.
    console.error('Onboarding welcome email failed', (err as Error).message);
  }
}
