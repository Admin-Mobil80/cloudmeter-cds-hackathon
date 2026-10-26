import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { loadCredentials } from './secrets';
import { persistMonthlySnapshots, persistDailySnapshots } from './persist-cost';
import { getAdapter, ProviderCredentials } from './providers';

export const MONTHS = 6;
export const DAYS = 90;

export interface RefreshableAccount {
  accountId: string;
  name?: string;
  provider: string;
  dataSource?: string;
  sync: string;
  credentialsSecretArn?: string;
  roleArn?: string;
  assumeRoleExternalId?: string;
  costScope?: 'self' | 'organization';
}

export interface RefreshOutcome {
  refreshed: boolean;
  reason?: string;
  spend?: number;
  sync?: string;
  backfilled?: string[];
}

/**
 * Pulls fresh cost data for one account and stores it.
 *
 * Shared by the API route (a person opened the page) and the hourly sweep
 * (the schedule came round). Both need identical throttling, backfill and
 * error handling — a second implementation would drift, and the two would
 * disagree about when an account was last synced.
 */
export async function refreshAccount(
  tenantId: string,
  account: RefreshableAccount,
  minIntervalMs: number,
): Promise<RefreshOutcome> {
  if (account.dataSource !== 'live') {
    return { refreshed: false, reason: 'This account uses seeded data' };
  }

  const adapter = getAdapter(account.provider);
  if (!adapter) {
    return { refreshed: false, reason: `No integration for provider ${account.provider}` };
  }

  const age = Date.now() - new Date(account.sync).getTime();
  const throttled = age < minIntervalMs;

  // Data we have simply never fetched isn't routine re-polling, so the
  // metered-API throttle shouldn't delay it.
  const needsDailyBackfill = !!adapter.fetchDailySnapshots && !(await hasDailyData(account.accountId));
  const needsRegionBackfill = !(await hasRegionData(account.accountId));

  if (throttled && !needsDailyBackfill && !needsRegionBackfill) {
    return {
      refreshed: false,
      reason: 'Synced recently',
      sync: account.sync,
    };
  }

  let creds: ProviderCredentials;
  try {
    creds = await resolveStoredCredentials(account);
  } catch (err) {
    return { refreshed: false, reason: `Stored credentials unavailable: ${(err as Error).message}` };
  }

  // Inside the throttle window but missing a dimension: fetch only what's
  // absent and leave the sync timestamp alone, so the normal cadence is
  // unaffected either way.
  if (throttled) {
    const filled: string[] = [];
    if (needsDailyBackfill) {
      try {
        await persistDailySnapshots(account.accountId, await adapter.fetchDailySnapshots!(creds, DAYS));
        filled.push('daily');
      } catch (err) {
        console.error('Daily backfill failed', (err as Error).message);
      }
    }
    if (needsRegionBackfill) {
      try {
        await persistMonthlySnapshots(account.accountId, await adapter.fetchMonthlySnapshots(creds, MONTHS));
        filled.push('regions');
      } catch (err) {
        console.error('Region backfill failed', (err as Error).message);
      }
    }
    return { refreshed: false, reason: filled.length ? undefined : 'Synced recently', backfilled: filled, sync: account.sync };
  }

  const now = new Date().toISOString();
  const accountKey = { PK: `TENANT#${tenantId}`, SK: `ACCOUNT#${account.accountId}` };

  try {
    const snapshots = await adapter.fetchMonthlySnapshots(creds, MONTHS);
    const currentMonthSpend = snapshots.find((s) => s.isCurrent)?.totalSpend ?? 0;

    await persistMonthlySnapshots(account.accountId, snapshots);

    // A daily failure is logged but doesn't fail the refresh: the monthly data
    // is already stored and the account genuinely is up to date.
    if (adapter.fetchDailySnapshots) {
      try {
        await persistDailySnapshots(account.accountId, await adapter.fetchDailySnapshots(creds, DAYS));
      } catch (err) {
        console.error('Daily cost refresh failed', (err as Error).message);
      }
    }

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: accountKey,
      UpdateExpression: 'SET #spend = :spend, #sync = :sync, #status = :status REMOVE lastSyncError',
      ExpressionAttributeNames: { '#spend': 'spend', '#sync': 'sync', '#status': 'status' },
      ExpressionAttributeValues: { ':spend': currentMonthSpend, ':sync': now, ':status': 'connected' },
    }));

    return { refreshed: true, spend: currentMonthSpend, sync: now };
  } catch (err) {
    // A revoked credential or changed policy shouldn't wipe the last-known-good
    // data — flag the account instead so the UI can surface it.
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: accountKey,
      UpdateExpression: 'SET #status = :status, #err = :err',
      ExpressionAttributeNames: { '#status': 'status', '#err': 'lastSyncError' },
      ExpressionAttributeValues: { ':status': 'error', ':err': (err as Error).message },
    }));
    return { refreshed: false, reason: (err as Error).message };
  }
}

async function resolveStoredCredentials(account: RefreshableAccount): Promise<ProviderCredentials> {
  // Scope is account configuration rather than a secret, so it's carried
  // alongside the credentials rather than stored with them.
  const scope = { costScope: account.costScope ?? 'self' };

  if (account.credentialsSecretArn) {
    return { ...(await loadCredentials(account.credentialsSecretArn)), ...scope };
  }
  // AWS accounts connected before credentials moved to Secrets Manager still
  // carry these two fields inline.
  if (account.roleArn && account.assumeRoleExternalId) {
    return { roleArn: account.roleArn, externalId: account.assumeRoleExternalId, ...scope };
  }
  throw new Error('no stored credentials for this account');
}

/** Cheapest possible existence check: one key-only read. */
async function hasDailyData(accountId: string): Promise<boolean> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'DAILY#' },
    ProjectionExpression: 'SK',
    Limit: 1,
  }));
  return (Items?.length ?? 0) > 0;
}

/**
 * Present-but-empty counts as answered: that's a provider with no location
 * dimension, not a gap we should keep re-fetching.
 */
async function hasRegionData(accountId: string): Promise<boolean> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'MONTHLY#' },
    ProjectionExpression: 'regionBreakdown',
    ScanIndexForward: false,
    Limit: 1,
  }));
  const current = Items?.[0];
  if (!current) return true;
  return current.regionBreakdown !== undefined;
}
