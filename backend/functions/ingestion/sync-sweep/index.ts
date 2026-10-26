import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { normalizeFrequency, intervalMsFor } from '../../shared/monitoring-frequency';
import { isDigestDue } from '../../shared/schedule';
import { refreshAccount, RefreshableAccount } from '../../shared/refresh-account';
import { detectAnomalies } from '../../shared/anomaly';
import { upsertAnomalyAlert, recordAlertDelivery } from '../../shared/alert-store';
import { notifyAnomaly, newWhatsAppBudget, newSlackBudget } from '../../shared/alert-notify';
import { syncFrozen } from '../../shared/subscription-period';

const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const PORTAL_URL = process.env.PORTAL_URL!;

/**
 * How many accounts are refreshed at once.
 *
 * Each one is a handful of Cost Explorer calls, and CE throttles per account
 * rather than per caller. Four keeps a large tenant moving without tripping
 * rate limits that would then need retrying.
 */
const CONCURRENCY = 4;

/**
 * Stop starting new work with this much of the Lambda timeout left.
 *
 * Whatever is missed is picked up by the next hourly run — far better than
 * being killed mid-refresh, which would leave an account's sync timestamp
 * un-advanced and its data half-written.
 */
const TIME_BUDGET_MS = 60_000;

/**
 * How far ahead of this sweep the digest sweep runs.
 *
 * This rule fires on cron(minute: '5') and DigestSchedule on cron(minute: '30')
 * — twenty-five minutes later, in the same UTC hour.
 *
 * The pre-digest pull has to ask whether a tenant's digest is due *then*, not
 * now, and the difference is not cosmetic. `isDigestDue` compares the tenant's
 * local hour, and a half-hour offset puts these two UTC times in different
 * local hours: for IST, 13:05 UTC is 18:35 (hour 18) while 13:30 UTC is 19:00
 * (hour 19). Asking at :05 about :05 answered "no" for every Indian tenant, so
 * the pull never happened and the digest went back to reporting whatever the
 * throttle had left — three production tenants were a day behind on 6 Sep
 * because of it. Nepal's +5:45 fails the same way.
 */
const DIGEST_LEAD_MS = 25 * 60_000;

interface SweepResult {
  tenants: number;
  /** Tenants skipped entirely: subscription expired or payment failed. */
  frozen: number;
  /** Tenants refreshed ahead of their digest, ignoring the usual throttle. */
  preDigest: number;
  eligible: number;
  refreshed: number;
  /** Dimensions filled in for an account that was otherwise inside its interval. */
  backfilled: number;
  skipped: number;
  anomaliesFound: number;
  alertsRaised: number;
  notified: number;
  failed: Array<{ account: string; reason: string }>;
  ranOutOfTime: boolean;
}

/**
 * Runs hourly and refreshes every account that is due, according to its
 * tenant's monitoring frequency.
 *
 * Before this, a refresh only happened when someone opened an account's page,
 * so "twice a day" was a ceiling rather than a schedule — an account nobody
 * visited simply went stale, and the daily digest reported old numbers for it.
 */
export const handler = async (context?: { getRemainingTimeInMillis?: () => number }): Promise<SweepResult> => {
  const started = Date.now();
  const remaining = () => (context?.getRemainingTimeInMillis?.() ?? (15 * 60_000 - (Date.now() - started)));

  const result: SweepResult = {
    tenants: 0, frozen: 0, preDigest: 0, eligible: 0, refreshed: 0, backfilled: 0, skipped: 0,
    anomaliesFound: 0, alertsRaised: 0, notified: 0,
    failed: [], ranOutOfTime: false,
  };

  for (const tenant of await allTenants()) {
    result.tenants += 1;
    const tenantId = tenant.tenantId as string;

    // Placed above the account query on purpose, so one check covers the whole
    // tenant: refreshes, anomaly detection and the alerts detection would
    // otherwise fire. Skipping only the refresh would leave detectForTenant
    // running daily over data that is deliberately no longer moving.
    //
    // Nothing is lost by pausing. A refresh re-fetches 90 days and overwrites
    // by key, and stored days live for 400, so a tenant that resumes backfills
    // the entire gap on its next sweep.
    const freeze = syncFrozen(tenant);
    if (freeze) {
      result.frozen += 1;
      console.log(`Tenant ${tenantId} frozen (${freeze}); skipping refresh and detection`);
      continue;
    }

    /**
     * The digest hour gets a guaranteed pull, whatever the throttle says.
     *
     * Asked about the moment the digest will run, not this one — see
     * DIGEST_LEAD_MS. Refreshing these tenants first is what makes the digest
     * report the same figures the portal does.
     *
     * The portal has always had this and the digest never did: opening the
     * dashboard refreshes every live account before rendering, so a number on
     * screen was just fetched, while the digest only ever read whatever the
     * last sweep happened to leave behind. When the throttle put that sweep in
     * the middle of the day being reported, the digest quoted a part-day as a
     * finished total — a real tenant was mailed "₹0, down 100%" for a day the
     * portal showed as $2.49.
     *
     * Ignoring the interval here costs one extra Cost Explorer pull per
     * account per day, which is the cheapest part of getting the number right.
     */
    const preDigest = isDigestDue(
      {
        timezone: tenant.timezone as string | undefined,
        digestHour: tenant.digestHour as number | undefined,
        lastDigestDate: tenant.lastDigestDate as string | undefined,
      },
      new Date(Date.now() + DIGEST_LEAD_MS),
    ).due;

    const minIntervalMs = preDigest
      ? 0
      : intervalMsFor(normalizeFrequency(tenant.monitoringFrequency));
    if (preDigest) result.preDigest += 1;

    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
    }));

    /*
     * Every live account, not only the ones past their interval.
     *
     * The age check used to live here as well as inside refreshAccount, and
     * the duplicate quietly disabled a branch the shared function is built
     * around: it treats a dimension we have *never* fetched as not-routine and
     * backfills it whatever the throttle says. Filtering first meant an
     * account on a normal cadence never reached that code, so adding daily
     * cost to the Azure adapter changed nothing for either live subscription —
     * both were inside their 12-hour window every single hour, and would have
     * been until someone happened to open the page.
     *
     * refreshAccount already takes minIntervalMs precisely so it can make this
     * decision, and an account that is genuinely just synced returns from it
     * after two key reads without touching the provider. Deciding it in one
     * place is the point: the module's own note says a second implementation
     * would drift, and this is what that drift looked like.
     *
     * Oldest first, so if the run is cut short the most stale accounts have
     * already been dealt with.
     */
    const live = ((Items ?? []) as unknown as RefreshableAccount[])
      .filter((a) => a.dataSource === 'live')
      .sort((a, b) => new Date(a.sync).getTime() - new Date(b.sync).getTime());

    // Still counts accounts due by the schedule, so the figure in the log means
    // what it has always meant; a backfill of a throttled account shows up as
    // `backfilled` instead.
    result.eligible += live
      .filter((a) => Date.now() - new Date(a.sync).getTime() >= minIntervalMs).length;

    for (let i = 0; i < live.length; i += CONCURRENCY) {
      if (remaining() < TIME_BUDGET_MS) {
        result.ranOutOfTime = true;
        console.warn('Sweep stopping early; remaining accounts roll over to the next run');
        break;
      }

      await Promise.all(live.slice(i, i + CONCURRENCY).map(async (account) => {
        try {
          const outcome = await refreshAccount(tenantId, account, minIntervalMs);
          if (outcome.refreshed) result.refreshed += 1;
          else {
            result.skipped += 1;
            // A dimension filled in behind the throttle. Counted rather than
            // folded into `skipped`, because "nothing to do" and "backfilled 90
            // days of daily cost" are not the same outcome to read in a log.
            if (outcome.backfilled?.length) {
              result.backfilled += outcome.backfilled.length;
              console.log(`Backfilled ${outcome.backfilled.join(', ')} for ${account.name ?? account.accountId}`);
            }
            if (outcome.reason && outcome.reason !== 'Synced recently') {
              result.failed.push({ account: account.name ?? account.accountId, reason: outcome.reason });
            }
          }
        } catch (err) {
          // One account's provider outage must not stop every later account.
          result.failed.push({ account: account.name ?? account.accountId, reason: (err as Error).message });
        }
      }));
    }

    // Detection runs after the refresh, on the data it just wrote — so an
    // alert always reflects the newest complete day rather than yesterday's
    // view of it.
    try {
      await detectForTenant(tenantId, tenant.name as string | undefined, Items ?? [], result);
    } catch (err) {
      console.error(`Anomaly detection failed for tenant ${tenantId}`, (err as Error).message);
    }

    if (result.ranOutOfTime) break;
  }

  console.log('Sync sweep', JSON.stringify(result));
  return result;
};

/**
 * Detects anomalies across one tenant's accounts, records them, and notifies.
 *
 * Only newly raised alerts notify. An ongoing spike updates the existing alert
 * silently — the problem hasn't changed, and re-sending every hour is how an
 * alerting channel gets muted.
 */
async function detectForTenant(
  tenantId: string,
  tenantName: string | undefined,
  accounts: Array<Record<string, unknown>>,
  result: SweepResult,
): Promise<void> {
  const budget = newWhatsAppBudget();
  // Its own allowance, shared across every anomaly in this run.
  const slackBudget = newSlackBudget();
  const name = tenantName ?? 'your CloudMeter account';

  for (const raw of accounts) {
    const account = raw as unknown as RefreshableAccount;
    if (account.dataSource !== 'live') continue;

    const anomalies = await detectAnomalies({
      accountId: account.accountId,
      name: account.name ?? account.accountId,
      provider: account.provider,
    });
    result.anomaliesFound += anomalies.length;

    for (const anomaly of anomalies) {
      const raised = await upsertAnomalyAlert(tenantId, anomaly);
      if (!raised) continue;
      result.alertsRaised += 1;

      const notify = await notifyAnomaly(tenantId, name, anomaly, PORTAL_URL, FROM_EMAIL, budget, slackBudget);
      result.notified += notify.emailed + notify.whatsapped;
      await recordAlertDelivery(tenantId, raised.createdAt, raised.id, notify.channels, notify.recipients);
    }
  }
}

/**
 * Every tenant, with the frequency that governs its accounts.
 *
 * A Scan, because tenant items are identified by PK === SK and have no index.
 * Fine hourly at this size; past a few thousand tenants this wants its own
 * sparse GSI, same as the digest sweep.
 */
async function allTenants(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :t) AND attribute_exists(tenantId)',
      ExpressionAttributeValues: { ':t': 'TENANT#' },
      // The subscription fields feed syncFrozen. Only `name` needs aliasing:
      // it is a DynamoDB reserved word, and the rest are not.
      // The subscription fields feed syncFrozen; the schedule fields feed
      // isDigestDue. `name` and `timezone` are reserved words; the rest are not.
      ProjectionExpression: 'tenantId, #n, monitoringFrequency, planId, '
        + 'currentPeriodEnd, trialEndsAt, createdAt, subscriptionStatus, '
        + '#tz, digestHour, lastDigestDate',
      ExpressionAttributeNames: { '#n': 'name', '#tz': 'timezone' },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return out;
}
