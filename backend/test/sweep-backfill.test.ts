/**
 * Which accounts the hourly sweep hands to refreshAccount.
 *
 * The sweep used to apply the sync-age check itself, before calling the shared
 * function that applies the very same check. The duplicate looked harmless and
 * was not: refreshAccount treats a dimension we have *never* fetched as
 * not-routine and backfills it whatever the throttle says, and an account
 * filtered out upstream never reaches that branch.
 *
 * The cost was invisible until it mattered. Adding daily cost to the Azure
 * adapter changed nothing for either live subscription, because both sat
 * inside their 12-hour window every hour of every day and so were dropped
 * before refreshAccount could notice the gap.
 *
 * So these pin the contract between the two: the sweep decides *live or not*,
 * refreshAccount decides *due or not*.
 */

process.env.OTP_FROM_EMAIL = 'test@example.com';
process.env.PORTAL_URL = 'https://example.com';

jest.mock('../functions/shared/ddb', () => ({
  TABLE_NAME: 'test-table',
  ddb: { send: jest.fn() },
}));

jest.mock('../functions/shared/refresh-account', () => ({
  refreshAccount: jest.fn(async () => ({ refreshed: true })),
}));

// Detection is a separate concern and runs after the refresh; stubbed so these
// tests say nothing about it either way.
jest.mock('../functions/shared/anomaly', () => ({ detectAnomalies: jest.fn(async () => []) }));
jest.mock('../functions/shared/alert-store', () => ({
  upsertAnomalyAlert: jest.fn(), recordAlertDelivery: jest.fn(),
}));
jest.mock('../functions/shared/alert-notify', () => ({
  notifyAnomaly: jest.fn(), newWhatsAppBudget: jest.fn(() => ({})), newSlackBudget: jest.fn(() => ({})),
}));

import { handler } from '../functions/ingestion/sync-sweep';
import { ddb } from '../functions/shared/ddb';
import { refreshAccount } from '../functions/shared/refresh-account';

const send = ddb.send as unknown as jest.Mock;
const refresh = refreshAccount as unknown as jest.Mock;

const TENANT = 'tenant-1';
const HOURS = 3600_000;

/** A tenant with no monitoringFrequency, so the default of 2/day applies. */
const tenantRow = {
  PK: `TENANT#${TENANT}`, SK: `TENANT#${TENANT}`, tenantId: TENANT,
  name: 'Test Tenant', timezone: 'Asia/Calcutta',
  // Marked sent today so the pre-digest pull does not fire and set the
  // interval to zero — that path has its own guarantee and would mask this one.
  lastDigestDate: new Date().toISOString().slice(0, 10), digestHour: 9,
  planId: 'growth', subscriptionStatus: 'active',
  currentPeriodEnd: new Date(Date.now() + 30 * 24 * HOURS).toISOString(),
};

const account = (name: string, syncedHoursAgo: number, dataSource = 'live') => ({
  PK: `TENANT#${TENANT}`, SK: `ACCOUNT#${name}`, accountId: name, name,
  provider: 'azure', dataSource,
  sync: new Date(Date.now() - syncedHoursAgo * HOURS).toISOString(),
});

/** Answers the sweep's two queries: every tenant, then one tenant's accounts. */
function tableHolds(accounts: unknown[]) {
  send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'ScanCommand') return { Items: [tenantRow] };
    return { Items: accounts };
  });
}

const namesRefreshed = () => refresh.mock.calls.map((c) => (c[1] as { name: string }).name);

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
  refresh.mockImplementation(async () => ({ refreshed: true }));
});

describe('which accounts reach refreshAccount', () => {
  it('passes an account that is still inside its interval', async () => {
    /*
     * The regression. One hour old against a twelve-hour interval: nothing is
     * due, and before this the sweep returned without calling refreshAccount
     * at all, so a missing dimension could never be noticed.
     */
    tableHolds([account('fresh-azure', 1)]);

    await handler();

    expect(namesRefreshed()).toEqual(['fresh-azure']);
  });

  it('still passes an account that is genuinely due', async () => {
    tableHolds([account('stale-azure', 13)]);
    await handler();
    expect(namesRefreshed()).toEqual(['stale-azure']);
  });

  it('leaves the throttle decision to refreshAccount, with the interval', async () => {
    // The sweep must hand over the interval rather than acting on it, or the
    // two drift apart again — 2 pulls a day is 12 hours.
    tableHolds([account('fresh-azure', 1)]);

    await handler();

    expect(refresh.mock.calls[0][2]).toBe(12 * HOURS);
  });

  it('still refuses a seeded account outright', async () => {
    // The one filter that remains the sweep's own: seeded data has no provider
    // to call, and refreshAccount would only reject it a step later.
    tableHolds([account('seeded', 99, 'seed')]);

    await handler();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('orders the stalest account first', async () => {
    // Matters when the run is cut short: whatever is dropped should be the
    // data that was freshest to begin with.
    tableHolds([account('recent', 1), account('ancient', 40), account('middle', 13)]);

    await handler();

    expect(namesRefreshed()).toEqual(['ancient', 'middle', 'recent']);
  });
});

describe('what the run reports', () => {
  it('counts only the schedule-due accounts as eligible', async () => {
    // `eligible` has always meant "due by the schedule" and is read that way in
    // the logs; passing everything through must not quietly inflate it.
    tableHolds([account('fresh', 1), account('due', 13)]);

    const out = await handler();

    expect(out.eligible).toBe(1);
  });

  it('counts a backfill rather than burying it in skipped', async () => {
    /*
     * The outcome this whole change exists to produce. "Nothing to do" and
     * "filled in 90 days of daily cost" are both `refreshed: false`, and a log
     * that cannot tell them apart is how this went unnoticed in the first
     * place.
     */
    refresh.mockImplementation(async () => ({ refreshed: false, backfilled: ['daily'] }));
    tableHolds([account('fresh-azure', 1)]);

    const out = await handler();

    expect(out.backfilled).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.failed).toEqual([]);
  });

  it('does not report a quiet skip as a failure', async () => {
    refresh.mockImplementation(async () => ({ refreshed: false, reason: 'Synced recently' }));
    tableHolds([account('fresh-azure', 1)]);

    const out = await handler();

    expect(out.skipped).toBe(1);
    expect(out.backfilled).toBe(0);
    expect(out.failed).toEqual([]);
  });

  it('keeps going when one account throws', async () => {
    refresh
      .mockImplementationOnce(async () => { throw new Error('provider down'); })
      .mockImplementation(async () => ({ refreshed: true }));
    tableHolds([account('broken', 40), account('fine', 1)]);

    const out = await handler();

    expect(out.refreshed).toBe(1);
    expect(out.failed).toEqual([{ account: 'broken', reason: 'provider down' }]);
  });
});
