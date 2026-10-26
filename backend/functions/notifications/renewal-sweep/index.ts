import { ScanCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { currentPeriod, Period } from '../../shared/subscription-period';
import { sendRenewalNotice, NoticeStage } from '../../shared/renewal-email';
import { displayName } from '../../shared/email-layout';

const PORTAL_URL = process.env.PORTAL_URL!;
const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;

/**
 * How many days before the end a heads-up goes out.
 *
 * Two, not five. A reminder a week out is filed and forgotten; one the day
 * before is a scramble. Three days is enough to raise a PO or update a card,
 * and the day-before nudge catches whoever ignored the first.
 */
const WARN_DAYS = [3, 1];

interface SweepResult {
  tenantsChecked: number;
  sent: number;
  skipped: Array<{ tenant: string; reason: string }>;
}

/**
 * Daily. Emails Owners whose access is about to lapse, or just has.
 *
 * **The auto-charge case needs no special handling.** When a gateway renews a
 * subscription its webhook moves `currentPeriodEnd` forward, so by the time
 * this runs the account is no longer inside any notice window and simply does
 * not match. A tenant only reaches the 'ended' branch if the charge genuinely
 * did not happen — which is exactly when someone should hear about it.
 *
 * Idempotent through `lastRenewalNotice`, which stores the end date and stage
 * a notice was last sent for. Re-running the sweep, or running it twice in a
 * day, cannot send the same reminder again; but a *new* period end — after a
 * renewal — is a different value and so notifies afresh.
 */
export const handler = async (): Promise<SweepResult> => {
  const now = new Date();
  const result: SweepResult = { tenantsChecked: 0, sent: 0, skipped: [] };

  for (const tenant of await allTenants()) {
    result.tenantsChecked += 1;
    const tenantId = tenant.tenantId as string;
    const name = (tenant.name as string) ?? 'your CloudMeter account';

    const period = currentPeriod({
      planId: tenant.planId as string | null,
      currentPeriodEnd: tenant.currentPeriodEnd as string | null,
      trialEndsAt: tenant.trialEndsAt as string | null,
      createdAt: tenant.createdAt as string | null,
    }, now);

    if (!period) {
      // Either a plan with no end date, or no dates at all. Reported rather
      // than guessed at — inventing a renewal deadline for a paying customer
      // is not this job's call to make.
      result.skipped.push({
        tenant: name,
        reason: tenant.planId ? 'plan set but no end date' : 'no end date and no createdAt',
      });
      continue;
    }

    const stage = stageFor(period);
    if (!stage) continue;

    // One notice per (end date, stage). Renewal moves the end date, so the
    // next cycle's reminders are a different key and go out normally.
    const marker = `${period.endsAt}:${stage}`;
    if (tenant.lastRenewalNotice === marker) continue;

    const owner = await ownerOf(tenantId);
    if (!owner?.email) {
      result.skipped.push({ tenant: name, reason: 'no owner email' });
      continue;
    }

    try {
      await sendRenewalNotice({
        toEmail: owner.email,
        toName: displayName(owner.name, owner.email),
        tenantName: name,
        kind: period.kind,
        stage,
        endsAt: period.endsAt,
        daysLeft: Math.max(0, period.daysLeft),
        // A subscription created through a gateway is set to auto-renew; one
        // set by hand in BMS is not, and saying "renews automatically" about a
        // manual pilot would be a promise nobody has made.
        autoRenews: period.kind === 'subscription'
          && (tenant.subscriptionSource as string) !== 'bms'
          && !!tenant.gatewaySubscriptionId,
        portalUrl: PORTAL_URL,
        fromEmailAddress: FROM_EMAIL,
      });
      await stamp(tenantId, marker);
      result.sent += 1;
    } catch (err) {
      // One tenant's bad address must not stop everyone else's reminders.
      console.error(`Renewal notice for ${name} failed`, (err as Error).message);
      result.skipped.push({ tenant: name, reason: (err as Error).message });
    }
  }

  console.log('Renewal sweep', result);
  return result;
};

/**
 * Which notice, if any, is due today.
 *
 * The expired branch is deliberately not bounded to "ended today": a sweep
 * that failed to run, or an account whose owner was added late, should still
 * get told rather than having missed its one chance. The idempotency marker
 * stops it repeating.
 */
function stageFor(period: Period): NoticeStage | null {
  if (period.expired) return 'ended';
  if (WARN_DAYS.includes(period.daysLeft)) return 'ending-soon';
  return null;
}

async function ownerOf(tenantId: string): Promise<{ email?: string; name?: string } | null> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: '#r = :owner AND #s = :active',
    // #n — "name" is a DynamoDB reserved word, and it is used in the
    // projection, so it needs an alias here as much as #r and #s do.
    ExpressionAttributeNames: { '#r': 'role', '#s': 'status', '#n': 'name' },
    ExpressionAttributeValues: {
      ':pk': `TENANT#${tenantId}`, ':sk': 'MEMBER#', ':owner': 'owner', ':active': 'active',
    },
    ProjectionExpression: 'email, #n',
  }));
  const item = (Items ?? [])[0];
  return item ? { email: item.email as string, name: item.name as string } : null;
}

async function stamp(tenantId: string, marker: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    UpdateExpression: 'SET lastRenewalNotice = :m, lastRenewalNoticeAt = :now',
    ExpressionAttributeValues: { ':m': marker, ':now': new Date().toISOString() },
  }));
}

async function allTenants(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :t) AND attribute_exists(tenantId)',
      ExpressionAttributeValues: { ':t': 'TENANT#' },
      ProjectionExpression: 'tenantId, #n, planId, currentPeriodEnd, trialEndsAt, createdAt, '
        + 'subscriptionSource, gatewaySubscriptionId, lastRenewalNotice',
      ExpressionAttributeNames: { '#n': 'name' },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return out;
}
