import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, canRefreshAccount, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import { normalizeFrequency, intervalMsFor } from '../../../shared/monitoring-frequency';
import { refreshAccount, RefreshableAccount } from '../../../shared/refresh-account';
import { syncFrozen } from '../../../shared/subscription-period';

/**
 * A person explicitly asking for fresh data still gets a floor, because every
 * pull is a metered Cost Explorer call (~$0.01) and the provider republishes
 * its own figures only a few times a day. Below this, a forced pull would
 * spend money to return the numbers already on screen. The account page
 * mirrors this value to disable the button rather than let someone click into
 * a refusal — keep the two in step.
 */
const FORCE_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Refreshes one account on demand.
 *
 * Two callers: opening the account page (passive, throttled to the tenant's
 * monitoring frequency) and the Refresh button (force, throttled only by the
 * floor above). The scheduled sweep does the same work on a cadence; all of
 * them call the same function so they can't drift apart on throttling,
 * backfill or error handling.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const tenantId = caller.membership.tenantId;
  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  let force = false;
  try {
    force = JSON.parse(event.body ?? '{}').force === true;
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  // Owners and Admins anywhere, plus whoever the account is assigned to.
  // Passive page-view refreshes stay open to anyone who can see the account —
  // they're capped by the monitoring frequency either way.
  if (force && !canRefreshAccount(caller, account)) {
    return json(403, {
      message: `${account.name} is managed by ${account.createdByEmail ?? 'someone else'}. `
        + 'Only they, an Admin, or the account owner can force a refresh.',
    });
  }

  // The tenant's monitoring frequency caps how often we actually call the
  // provider's metered cost API, no matter how often pages are loaded.
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));
  // The hourly sweep already skips these tenants; without the same rule here
  // the Refresh button would be a way around it, spending the metered Cost
  // Explorer calls the freeze exists to stop.
  //
  // Reported as a normal un-refreshed result rather than an error: it is an
  // expected state, not a failure, and `refreshed: false` with a `reason` is
  // the shape the account page already renders as a neutral note. No
  // `nextEligibleAt` — waiting does not help, so quoting a time would be a
  // lie. The tenant row above is fetched whole, so this costs no extra read.
  const freeze = syncFrozen(tenant ?? {});
  if (freeze) {
    return json(200, {
      refreshed: false,
      forced: force,
      sync: account.sync ?? null,
      syncFrozen: freeze,
      reason: freeze === 'payment_failed'
        ? 'Data refreshes are paused because the last payment failed. '
          + 'Update your payment method to resume; your history is kept.'
        : 'Data refreshes are paused because the subscription has expired. '
          + 'Renew to resume; your history is kept.',
    });
  }

  const minIntervalMs = force
    ? FORCE_MIN_INTERVAL_MS
    : intervalMsFor(normalizeFrequency(tenant?.monitoringFrequency));

  const result = await refreshAccount(
    tenantId,
    account as unknown as RefreshableAccount,
    minIntervalMs,
  );

  return json(200, {
    ...result,
    forced: force,
    ...(result.refreshed ? {} : {
      nextEligibleAt: new Date(new Date(account.sync).getTime() + minIntervalMs).toISOString(),
    }),
  });
};
