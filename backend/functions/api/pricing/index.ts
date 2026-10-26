import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json } from '../../shared/authz';
import {
  CATEGORY_LABELS, RECORDED_REGION, catalogForRegion,
  type Workload, type PriceEntry,
} from '../../shared/pricing-catalog';

// The Price List Query API is only served from a couple of regions, and
// us-east-1 is the one that carries every service's catalogue.
const pricing = new PricingClient({ region: 'us-east-1' });

const AZURE_RETAIL_URL = 'https://prices.azure.com/api/retail/prices';

// Published list prices move rarely — daily is far more often than they change,
// and it keeps a page that everyone can open from calling six pricing APIs on
// every load.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = { PK: 'PRICING#v1', SK: 'CATALOG' };

// A pricing lookup must never hold the request open; a slow provider just
// leaves its curated figure in place.
const LOOKUP_TIMEOUT_MS = 6_000;

interface CachedCatalog {
  workloads: Workload[];
  refreshedAt: string;
}

/** One AWS price, via the Query API. Returns null rather than throwing. */
async function awsPrice(
  serviceCode: string,
  filters: Record<string, string>,
  beginRange?: string,
): Promise<number | null> {
  try {
    const res = await pricing.send(new GetProductsCommand({
      ServiceCode: serviceCode,
      MaxResults: 1,
      Filters: Object.entries(filters).map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })),
    }));

    const raw = res.PriceList?.[0];
    if (!raw) return null;
    const doc = JSON.parse(typeof raw === 'string' ? raw : String(raw));

    // terms.OnDemand.<offer>.priceDimensions.<dim>.pricePerUnit.USD — the
    // offer and dimension keys are opaque, so both levels are walked rather
    // than indexed.
    for (const term of Object.values(doc?.terms?.OnDemand ?? {}) as Array<Record<string, unknown>>) {
      for (const dim of Object.values((term.priceDimensions ?? {}) as Record<string, unknown>)) {
        const d = dim as { pricePerUnit?: { USD?: string }; beginRange?: string };
        // A tiered meter returns every tier in one response, in no guaranteed
        // order, so taking the first priced dimension picks an arbitrary
        // volume band. Where a tier is named, only that tier counts.
        if (beginRange !== undefined && d.beginRange !== beginRange) continue;
        const usd = Number(d.pricePerUnit?.USD);
        // A 0.00 dimension is real in AWS's catalogue (free tiers, placeholder
        // SKUs) and is not the price anyone means.
        if (Number.isFinite(usd) && usd > 0) return usd;
      }
    }
    return null;
  } catch (err) {
    console.error('AWS price lookup failed', serviceCode, (err as Error).message);
    return null;
  }
}

/** One Azure retail price. Keyless, so this is a plain fetch. */
async function azurePrice(filter: string): Promise<number | null> {
  try {
    const url = `${AZURE_RETAIL_URL}?$filter=${encodeURIComponent(filter)}&$top=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return null;

    const body = await res.json() as { Items?: Array<{ retailPrice?: number; meterName?: string }> };
    // Spot and low-priority SKUs share the armSkuName and would undercut the
    // on-demand figure this table is comparing.
    const candidates = (body.Items ?? [])
      .filter((i) => typeof i.retailPrice === 'number' && i.retailPrice > 0)
      .filter((i) => !/spot|low priority/i.test(i.meterName ?? ''));

    return candidates.length ? Math.min(...candidates.map((i) => i.retailPrice as number)) : null;
  } catch (err) {
    console.error('Azure price lookup failed', (err as Error).message);
    return null;
  }
}

/**
 * Replaces curated figures with live ones wherever a provider lets us look
 * them up. A failed lookup is not an error: the curated figure stays, still
 * labelled `curated`, so the table is never blank and never silently wrong
 * about how fresh it is.
 */
async function withLivePrices(workloads: Workload[]): Promise<Workload[]> {
  const today = new Date().toISOString().slice(0, 10);

  const priced = await Promise.all(workloads.map(async (workload) => ({
    ...workload,
    entries: await Promise.all(workload.entries.map(async (entry): Promise<PriceEntry> => {
      if (!entry.live) return entry;

      const raw = entry.live.kind === 'aws'
        ? await awsPrice(entry.live.serviceCode, entry.live.filters, entry.live.beginRange)
        : await azurePrice(entry.live.filter);

      if (raw === null) return entry;
      // Into the unit this workload is compared in — see LiveLookup.multiplier.
      const price = raw * (entry.live.multiplier ?? 1);
      return { ...entry, price, source: 'live', asOf: today, pending: undefined };
    })),
  })));

  // Anything still pending was carried from another region and the lookup did
  // not replace it. Dropped rather than shown: a figure under the wrong
  // region's heading is worse than a shorter table.
  return priced
    .map((w) => ({ ...w, entries: w.entries.filter((e) => !e.pending) }))
    .filter((w) => w.entries.length > 0);
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  // Deliberately no role check beyond membership. Choosing a provider is a
  // developer's question, and a Member who cannot see the billing page still
  // needs to know what an instance costs before they launch one.
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const fresh = event.queryStringParameters?.refresh === 'true';
  /**
   * One comparison, at the region every figure in the catalogue was recorded
   * for. The page briefly offered a region picker; it was withdrawn because it
   * only ever worked for AWS and Azure — Google, Alibaba and Huawei publish no
   * pricing without credentials, so choosing any other region silently turned
   * a five-provider comparison into a two-provider one.
   *
   * Pinned here rather than left to default, so a stray `?region=` cannot
   * shrink the table.
   */
  const regional = catalogForRegion(RECORDED_REGION);

  if (!fresh) {
    try {
      const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: CACHE_KEY }));
      const cached = Item?.catalog as CachedCatalog | undefined;
      if (cached && Date.now() - new Date(cached.refreshedAt).getTime() < CACHE_TTL_MS) {
        return json(200, { ...cached, categories: CATEGORY_LABELS, cached: true });
      }
    } catch (err) {
      // A cache miss is not worth failing the page over.
      console.error('Pricing cache read failed', (err as Error).message);
    }
  }

  const workloads = await withLivePrices(regional.workloads);
  const catalog: CachedCatalog = { workloads, refreshedAt: new Date().toISOString() };

  try {
    // Shared across every tenant: these are public list prices, nothing here
    // is derived from any customer's account.
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...CACHE_KEY, catalog } }));
  } catch (err) {
    console.error('Pricing cache write failed', (err as Error).message);
  }

  return json(200, { ...catalog, categories: CATEGORY_LABELS, cached: false });
};
