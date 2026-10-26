/**
 * Azure's daily fetch, against a fake Cost Management.
 *
 * Until now the adapter had no `fetchDailySnapshots` at all, so `refreshAccount`
 * skipped daily entirely and both live production subscriptions held months of
 * MONTHLY# rows and not one DAILY# row. Everything that works per-day — the
 * daily chart, anomaly detection, the digest's "spend yesterday" line — had
 * nothing to read for Azure.
 *
 * Two behaviours carry most of the risk and neither is visible from a single
 * happy-path call: the 1,000-row page cap, which a 90-day query goes straight
 * past, and the temptation to fill a day Azure omitted with a zero.
 */

jest.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  },
}));

// State lives inside the factory: jest.mock is hoisted above any const here.
jest.mock('@azure/arm-costmanagement', () => {
  const state: { answers: unknown[]; calls: unknown[] } = { answers: [], calls: [] };
  return {
    __state: state,
    isRestError: (e: unknown) => !!e && (e as Error).name === 'RestError',
    CostManagementClient: class {
      query = {
        usage: async (_scope: string, def: unknown) => {
          state.calls.push(def);
          const answer = state.answers.shift();
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
    },
  };
});

import { azureAdapter } from '../functions/shared/providers/azure';

const { __state } = jest.requireMock('@azure/arm-costmanagement') as {
  __state: { answers: unknown[]; calls: Array<Record<string, never>> };
};

const CREDS = {
  tenant_id: 't', client_id: 'c', client_secret: 's', subscription_id: 'sub-1',
};

/** One page as the SDK hands it back: columns, positional rows, maybe a link. */
function page(rows: unknown[][], nextLink?: string) {
  return {
    columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }, { name: 'ServiceName' }],
    rows,
    ...(nextLink ? { nextLink } : {}),
  };
}

/** A row in that column order. `date` is the yyyymmdd integer Azure sends. */
const row = (cost: number, date: number, service: string) => [cost, date, service];

const daily = (days = 7) => azureAdapter.fetchDailySnapshots!(CREDS, days);

beforeEach(() => {
  __state.answers.length = 0;
  __state.calls.length = 0;
  (global as { fetch?: unknown }).fetch = jest.fn(async () => {
    throw new Error('no page fetch expected in this test');
  });
});

describe('what the daily query asks for', () => {
  it('asks for Daily granularity, not Monthly', async () => {
    __state.answers.push(page([row(1, 20261001, 'Storage')]));
    await daily();

    const def = __state.calls[0] as unknown as { dataset: { granularity: string } };
    expect(def.dataset.granularity).toBe('Daily');
  });

  it('still groups by service, so a day can be broken down', async () => {
    __state.answers.push(page([row(1, 20261001, 'Storage')]));
    await daily();

    const def = __state.calls[0] as unknown as {
      dataset: { grouping: Array<{ type: string; name: string }> };
    };
    expect(def.dataset.grouping).toEqual([{ type: 'Dimension', name: 'ServiceName' }]);
  });
});

describe('decoding a day', () => {
  it('reads the yyyymmdd integer Azure sends for UsageDate', async () => {
    __state.answers.push(page([row(4.5, 20261001, 'Storage')]));
    const out = await daily();

    expect(out).toHaveLength(1);
    expect(out[0].dayKey).toBe('2026-10-01');
    expect(out[0].totalSpend).toBeCloseTo(4.5);
  });

  it('sums the services on one day and ranks them', async () => {
    __state.answers.push(page([
      row(1, 20261001, 'Storage'),
      row(9, 20261001, 'Virtual Machines'),
      row(2, 20261001, 'Storage'),
    ]));
    const [day] = await daily();

    expect(day.totalSpend).toBeCloseTo(12);
    expect(day.serviceBreakdown.map((s) => s.name)).toEqual(['Virtual Machines', 'Storage']);
    expect(day.serviceBreakdown[1].spend).toBeCloseTo(3);
  });

  it('orders days oldest first however Azure returned them', async () => {
    /*
     * Not cosmetic: buildDailySnapshots derives each service's trend by reading
     * an entry against the one before it, so a shuffled list produces trends
     * computed backwards. Azure does not promise row order, and across pages
     * there is no order to lean on at all.
     */
    __state.answers.push(page([
      row(3, 20261003, 'Storage'),
      row(1, 20261001, 'Storage'),
      row(2, 20261002, 'Storage'),
    ]));
    const out = await daily();

    expect(out.map((d) => d.dayKey)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });
});

describe('a day Azure did not answer for', () => {
  it('is left out rather than written as zero', async () => {
    /*
     * The whole reason this adapter does not seed its window the way the
     * monthly path does. Azure omits a day it has no rows for, and that
     * omission covers both "nothing ran" and "not computed yet" — a zero
     * invented for the second case is the placeholder that once told a
     * customer they had spent nothing on their most expensive day.
     */
    __state.answers.push(page([
      row(1, 20261001, 'Storage'),
      row(3, 20261003, 'Storage'),
    ]));
    const out = await daily();

    expect(out.map((d) => d.dayKey)).toEqual(['2026-10-01', '2026-10-03']);
    expect(out.some((d) => d.totalSpend === 0)).toBe(false);
  });

  it('returns nothing at all for a window Azure had no rows for', async () => {
    __state.answers.push(page([]));
    expect(await daily()).toEqual([]);
  });
});

describe('paging past the 1,000-row cap', () => {
  it('follows nextLink and keeps the rows from every page', async () => {
    /*
     * 90 days of a subscription with a dozen services is over 1,000 (day,
     * service) rows. Without this the oldest days simply never arrive, and
     * nothing anywhere says so.
     */
    __state.answers.push(page([row(1, 20261001, 'Storage')], 'https://next/page2'));
    (global as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ properties: page([row(2, 20261002, 'Storage')]) }),
    }));

    const out = await daily();

    expect(out.map((d) => d.dayKey)).toEqual(['2026-10-01', '2026-10-02']);
    expect(global.fetch as unknown as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('re-sends the same query body to the next page', async () => {
    __state.answers.push(page([row(1, 20261001, 'Storage')], 'https://next/page2'));
    const fetchMock = jest.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ properties: page([]) }),
    }));
    (global as { fetch: unknown }).fetch = fetchMock;

    await daily();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).dataset.granularity).toBe('Daily');
  });

  it('throws rather than handing back a partial window', async () => {
    /*
     * A lost page does not mean fewer days, it means some day's total is
     * quietly too low — and that understated figure would be stored as fact.
     * No daily data is visible and recovers on the next sweep; wrong daily
     * data does not.
     */
    __state.answers.push(page([row(1, 20261001, 'Storage')], 'https://next/page2'));
    (global as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false, status: 500, headers: { get: () => null }, json: async () => ({}),
    }));

    await expect(daily()).rejects.toThrow();
  });

  it('waits the time Azure asks for when a page is throttled, then succeeds', async () => {
    __state.answers.push(page([row(1, 20261001, 'Storage')], 'https://next/page2'));
    let call = 0;
    (global as { fetch: unknown }).fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: false, status: 429,
          headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '0.01' : null) },
          json: async () => ({}),
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ properties: page([row(2, 20261002, 'Storage')]) }),
      };
    });

    const out = await daily();

    expect(out.map((d) => d.dayKey)).toEqual(['2026-10-01', '2026-10-02']);
    expect(call).toBe(2);
  });

  it('gives up on a nextLink that never ends', async () => {
    // A link pointing at itself would otherwise spin until the Lambda died.
    __state.answers.push(page([row(1, 20261001, 'Storage')], 'https://next/loop'));
    (global as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ properties: page([row(1, 20261001, 'Storage')], 'https://next/loop') }),
    }));

    await expect(daily()).rejects.toThrow(/extra pages/);
  });
});

describe('the metric fallback still applies to daily', () => {
  it('retries with the alternate metric and reads that column', async () => {
    // An MCA subscription rejects PreTaxCost and answers on Cost. The decoder
    // has to look up whichever metric actually worked.
    const restError = Object.assign(new Error('bad metric'), {
      name: 'RestError', statusCode: 400,
    });
    __state.answers.push(restError);
    __state.answers.push({
      columns: [{ name: 'Cost' }, { name: 'UsageDate' }, { name: 'ServiceName' }],
      rows: [[7, 20261001, 'Storage']],
    });

    const out = await daily();

    expect(out).toHaveLength(1);
    expect(out[0].totalSpend).toBeCloseTo(7);
  });
});
