import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, json } from '../../../shared/bms';
import { planById } from '../../../shared/plans';
import {
  oneMonthOn, trialEndFrom, renewFrom, extendTrialFrom,
} from '../../../shared/subscription-period';
import { getPricing } from '../../../shared/pricing';

/**
 * Sets a tenant's plan and end date by hand.
 *
 * This is how an account is onboarded outside Stripe — an invoice, a pilot, a
 * partner deal. It writes the same fields the Stripe webhook writes, so every
 * limit and every page reads one set of values whatever put them there, and
 * records that a human did it so the two are never confused.
 *
 * Deliberately does not touch Stripe: if a tenant also has a Stripe
 * subscription, the next webhook will overwrite this. Mixing the two on one
 * tenant is a billing question, not something to paper over here.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  const tenantId = event.pathParameters?.tenantId;
  if (!tenantId) return json(400, { message: 'tenantId is required' });

  let body: { planId?: unknown; currentPeriodEnd?: unknown; status?: unknown; action?: unknown };
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

  const sets: string[] = ['subscriptionUpdatedAt = :now', 'subscriptionSource = :src', 'subscriptionSetBy = :by'];
  const values: Record<string, unknown> = {
    ':now': new Date().toISOString(),
    ':src': 'bms',
    ':by': caller.email,
  };

  if (body.planId !== undefined) {
    // null clears the plan — how you take an account back to no subscription.
    if (body.planId === null) {
      // The end date goes with it. Leaving the old one behind would show a
      // trial account carrying a subscription end it no longer has, and the
      // renewal sweep would have to work out which of the two applied.
      sets.push('planId = :plan', 'subscriptionStatus = :status', 'currentPeriodEnd = :cleared');
      values[':plan'] = null;
      values[':status'] = null;
      values[':cleared'] = null;
    } else {
      const plan = planById(typeof body.planId === 'string' ? body.planId : null);
      if (!plan) return json(400, { message: 'Unknown plan' });
      sets.push('planId = :plan');
      values[':plan'] = plan.id;
      // Setting a plan by hand implies granting access; an explicit status in
      // the same request still wins.
      if (body.status === undefined) {
        sets.push('subscriptionStatus = :status');
        values[':status'] = 'active';
      }
    }
  }

  if (body.status !== undefined && body.planId !== null) {
    if (typeof body.status !== 'string') return json(400, { message: 'status must be text' });
    sets.push('subscriptionStatus = :status');
    values[':status'] = body.status;
  }

  // The end date is derived, never supplied.
  //
  // Every subscription runs a month from when it starts, and extending one is
  // the `renew` action below. A free-text date let staff quietly grant a year,
  // or shorten a period a customer had already paid for, with no record of the
  // decision beyond the value itself — a renewal is a countable event, an
  // edited date is not. Rejecting the field rather than ignoring it so nobody
  // believes a date they sent was honoured.
  if (body.currentPeriodEnd !== undefined) {
    return json(400, {
      message: 'The end date is always one month from the start and cannot be set directly. '
        + 'Use Renew to extend the subscription by another month.',
    });
  }

  if (body.action === 'renew-trial') {
    if (tenant.planId) {
      return json(400, {
        message: 'This account is on a plan, not a trial. Use Renew to extend the subscription.',
      });
    }
    const { trialDays } = await getPricing();
    sets.push('trialEndsAt = :trialEnd', 'lastTrialExtendedAt = :now', 'lastTrialExtendedBy = :by');
    values[':trialEnd'] = extendTrialFrom(tenant.trialEndsAt as string | null, trialDays);
  } else if (body.action === 'renew') {
    if (!tenant.planId && body.planId === undefined) {
      return json(400, { message: 'There is no subscription to renew. Set a plan first.' });
    }
    sets.push('currentPeriodEnd = :end', 'lastRenewedAt = :now', 'lastRenewedBy = :by');
    values[':end'] = renewFrom(tenant.currentPeriodEnd as string | null);
  } else if (body.planId !== undefined && body.planId !== null) {
    // Starting or changing a plan starts a fresh month.
    sets.push('currentPeriodEnd = :end');
    values[':end'] = oneMonthOn();
  }

  // An account with no plan is on its trial, and that needs a date too — an
  // older account created before trials were dated has none stored. Skipped
  // when this request is itself setting one.
  if (body.action !== 'renew-trial' && !tenant.trialEndsAt && tenant.createdAt) {
    const trialEnd = trialEndFrom(tenant.createdAt as string);
    if (trialEnd) {
      sets.push('trialEndsAt = :trialEnd');
      values[':trialEnd'] = trialEnd;
    }
  }

  if (sets.length === 3) return json(400, { message: 'Nothing to update' });

  // `lastRenewedBy` reuses :by, already seeded above.

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
  }));

  console.log('BMS subscription change', {
    tenantId, by: caller.email, planId: body.planId, action: body.action, end: values[':end'],
  });

  const { Item: updated } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));

  return json(200, {
    tenantId,
    planId: updated?.planId ?? null,
    status: updated?.subscriptionStatus ?? null,
    currentPeriodEnd: updated?.currentPeriodEnd ?? null,
    trialEndsAt: updated?.trialEndsAt ?? null,
    lastRenewedAt: updated?.lastRenewedAt ?? null,
    source: updated?.subscriptionSource ?? null,
  });
};
