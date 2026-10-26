/**
 * A cross-provider price comparison, normalised onto like-for-like workloads.
 *
 * The point of this catalogue is the *comparison*, and comparison is exactly
 * what raw pricing APIs don't give you: every provider names, packages and
 * meters things differently, so "which is cheaper" can only be answered once
 * somebody has decided what counts as equivalent. That decision lives here.
 *
 * Two kinds of number end up on the page, and they are never blurred together:
 *
 *   live    — fetched from the provider's own pricing API on refresh. Only AWS
 *             (Price List Query API, reachable with our own IAM) and Azure
 *             (Retail Prices, keyless) offer this without us holding customer
 *             credentials, so only those two are ever live.
 *   curated — a published list price recorded here by hand, with the date it
 *             was checked and a link to the provider's own pricing page.
 *             Google, Alibaba, Huawei and OpenAI all sit here: their pricing
 *             either needs an API key we'd have to hold, or isn't exposed as
 *             an API at all.
 *
 * Curated figures WILL drift. Every one carries `asOf` and `sourceUrl` so the
 * page can say how old it is and where to check it, rather than presenting a
 * remembered number as though it were authoritative.
 */

export type ProviderKey = 'aws' | 'azure' | 'gcp' | 'alibaba' | 'huawei' | 'openai';

export type Category = 'compute' | 'storage' | 'egress' | 'database' | 'serverless' | 'ai';

/**
 * Regions the comparison is offered in.
 *
 * A region is a property of the whole table, not of one row: comparing a US
 * price against an Indian one would make the cheaper region look like the
 * cheaper provider, which is the single easiest way to get this kind of table
 * wrong. So a region is chosen once and every price on screen belongs to it.
 */
export type RegionId = 'us-east-1' | 'ap-south-1';

export interface RegionDef {
  id: RegionId;
  label: string;
  /** The provider's own code for this place — what the live lookups key on. */
  codes: Partial<Record<ProviderKey, string>>;
}

export const REGIONS: RegionDef[] = [
  {
    id: 'us-east-1',
    label: 'N. Virginia (us-east-1 / eastus)',
    codes: { aws: 'us-east-1', azure: 'eastus' },
  },
  {
    id: 'ap-south-1',
    label: 'Mumbai (ap-south-1 / centralindia)',
    codes: { aws: 'ap-south-1', azure: 'centralindia' },
  },
];

/** Shown when none is asked for. Azure's eastus is the same locale as us-east-1. */
export const DEFAULT_REGION: RegionId = 'us-east-1';

export function regionById(id: string | undefined | null): RegionDef {
  return REGIONS.find((r) => r.id === id) ?? REGIONS.find((r) => r.id === DEFAULT_REGION)!;
}

/** How to fetch a live price, for the providers that allow it unauthenticated. */
export type LiveLookup = (
  | {
      kind: 'aws';
      serviceCode: string;
      filters: Record<string, string>;
      /**
       * Which volume tier to take, as the API's own `beginRange`.
       *
       * A tiered meter returns every band in one response and the walk order
       * is not guaranteed, so egress would otherwise quote whichever band AWS
       * happened to list first — including the 150 TB/month rate against a
       * basis that says "first 10 TB". '0' is the entry tier.
       */
      beginRange?: string;
    }
  /** OData $filter against the Azure Retail Prices API. */
  | { kind: 'azure'; filter: string }
) & {
  /**
   * Converts the provider's unit into the one this workload is compared in.
   *
   * The APIs answer in whatever unit the meter bills in — GiB/hour, per ten
   * executions, per vCore — while the table compares GB/month, per million and
   * per instance. Without this the numbers are right and the comparison is
   * nonsense.
   */
  multiplier?: number;
};

export interface PriceEntry {
  provider: ProviderKey;
  /** The provider's own name for the thing being priced, e.g. "m5.xlarge". */
  sku: string;
  /** Shape of the resource, where it clarifies the comparison. */
  detail?: string;
  /** USD. Overwritten at refresh time when `live` resolves. */
  price: number;
  source: 'live' | 'curated';
  /** ISO date the figure was last established. */
  asOf: string;
  /** Where a human can check a curated figure. */
  sourceUrl?: string;
  live?: LiveLookup;
  /**
   * The carried price belongs to another region and is a placeholder until the
   * live lookup replaces it. Dropped if it never does — a figure under the
   * wrong region's heading is worse than a shorter table.
   */
  pending?: boolean;
}

export interface Workload {
  id: string;
  category: Category;
  name: string;
  /** What makes these comparable — stated plainly, because it is a judgement. */
  basis: string;
  /** The unit every entry's price is expressed in. */
  unit: string;
  region?: string;
  /**
   * True where the price is the same everywhere. Tokens are billed per token,
   * not per datacentre, so an LLM row is identical in every region and must
   * not be dropped when a region has no infrastructure figures recorded.
   */
  regionIndependent?: boolean;
  entries: PriceEntry[];
}

export const CATEGORY_LABELS: Record<Category, string> = {
  compute: 'Compute',
  storage: 'Storage',
  egress: 'Data transfer out',
  database: 'Managed databases',
  serverless: 'Serverless',
  ai: 'AI / LLM tokens',
};

// Date the curated figures below were last checked against published pricing.
const CURATED_ON = '2026-08-25';

const c = (
  provider: ProviderKey,
  sku: string,
  price: number,
  sourceUrl: string,
  detail?: string,
): PriceEntry => ({ provider, sku, price, detail, source: 'curated', asOf: CURATED_ON, sourceUrl });

const PRICING_URLS: Record<ProviderKey, string> = {
  aws: 'https://aws.amazon.com/pricing/',
  azure: 'https://azure.microsoft.com/pricing/',
  gcp: 'https://cloud.google.com/pricing',
  alibaba: 'https://www.alibabacloud.com/pricing',
  huawei: 'https://www.huaweicloud.com/intl/en-us/pricing/',
  openai: 'https://openai.com/api/pricing/',
};

/**
 * Mumbai everywhere it applies. Comparing a US region against an Indian one
 * would make the cheaper region look like the cheaper provider, which is the
 * single easiest way to get this kind of table wrong.
 */
const REGION = 'Mumbai (ap-south-1 / centralindia / asia-south1)';

/**
 * Published list prices, per workload, per provider, per region.
 *
 * Read from each provider's own pricing API on 2026-09-07 and recorded here so
 * the table can switch regions without a lookup on every page load. Only AWS
 * and Azure are covered: they are the two whose pricing can be read
 * programmatically, so they are the two that can be kept honest per region.
 *
 * Every figure is already in the unit its workload compares in. The APIs
 * answer in whatever the meter bills — GiB/hour, per ten executions, per
 * vCore — and converting at the point of recording keeps that arithmetic in
 * one place instead of scattered through the render.
 */
export const REGIONAL_PRICES: Record<
  string,
  Partial<Record<ProviderKey, Partial<Record<RegionId, number>>>>
> = {
  'vm-general-4x16': {
    aws:   { 'us-east-1': 0.192,  'ap-south-1': 0.202 },
    azure: { 'us-east-1': 0.192,  'ap-south-1': 0.202 },
  },
  'object-storage-standard': {
    aws:   { 'us-east-1': 0.023,  'ap-south-1': 0.025 },
    azure: { 'us-east-1': 0.0208, 'ap-south-1': 0.02 },
  },
  'block-storage-ssd': {
    aws:   { 'us-east-1': 0.08,   'ap-south-1': 0.0912 },
    // Azure bills Premium SSD v2 per GiB/hour: 0.00011 and 0.000125 x 730.
    azure: { 'us-east-1': 0.0803, 'ap-south-1': 0.09125 },
  },
  'egress-internet': {
    aws:   { 'us-east-1': 0.09,   'ap-south-1': 0.1093 },
    azure: { 'us-east-1': 0.08,   'ap-south-1': 0.11 },
  },
  'managed-postgres-2x8': {
    aws:   { 'us-east-1': 0.178,  'ap-south-1': 0.253 },
    // Azure prices Flexible Server per vCore: 0.112 and 0.1573 x 2.
    azure: { 'us-east-1': 0.224,  'ap-south-1': 0.3146 },
  },
  'serverless-invocations': {
    // Both bill per request; quoted per million, as the workload compares.
    aws:   { 'us-east-1': 0.2,    'ap-south-1': 0.2 },
    azure: { 'us-east-1': 0.2,    'ap-south-1': 0.2 },
  },
  'serverless-gb-second': {
    aws:   { 'us-east-1': 0.0000166667, 'ap-south-1': 0.0000166667 },
    azure: { 'us-east-1': 0.000016,     'ap-south-1': 0.000016 },
  },
};

/**
 * Google, Alibaba and Huawei belong in the table above and cannot be added the
 * same way.
 *
 * Their pricing is not reachable without holding a credential — checked, not
 * assumed: the Cloud Billing Catalog API answers 403 "use an API Key",
 * Alibaba's requires AccessKey-signed requests, and Huawei's BSS API requires
 * an auth token. Unlike AWS and Azure there is nothing to read on a refresh,
 * so every figure has to be recorded from a published pricing page by hand.
 *
 * Until then they are dropped from the infrastructure rows rather than shown
 * at another region's price, and catalogForRegion reports them in `omitted` so
 * the page names who is missing instead of presenting a two-provider table as
 * though it were complete.
 *
 * Adding one is only a matter of filling in prices here; nothing else changes:
 *
 *   'vm-general-4x16': {
 *     ...
 *     gcp: { 'us-east-1': 0.00, 'ap-south-1': 0.00 },   // us-east1 / asia-south1
 *   },
 *
 * Seven workloads x two regions x three providers is 42 figures. Each must be
 * in the unit its workload compares in — see `unit` — and `basis` states what
 * counts as equivalent, which is the part that makes the comparison fair.
 */

/** When the figures above were read from the providers' pricing APIs. */
export const REGIONAL_PRICES_AS_OF = '2026-09-07';

export const WORKLOADS: Workload[] = [
  // ---- Compute ---------------------------------------------------------
  {
    id: 'vm-general-4x16',
    category: 'compute',
    name: 'General-purpose VM — 4 vCPU / 16 GB',
    basis: 'On-demand Linux, shared tenancy, no committed-use discount.',
    unit: 'per hour',
    region: REGION,
    entries: [
      {
        provider: 'aws', sku: 'm5.xlarge', detail: '4 vCPU · 16 GiB',
        price: 0.202, source: 'curated', asOf: CURATED_ON, sourceUrl: PRICING_URLS.aws,
        live: {
          kind: 'aws',
          serviceCode: 'AmazonEC2',
          filters: {
            instanceType: 'm5.xlarge', regionCode: 'ap-south-1', tenancy: 'Shared',
            operatingSystem: 'Linux', preInstalledSw: 'NA', capacitystatus: 'Used',
          },
        },
      },
      {
        provider: 'azure', sku: 'Standard_D4s_v5', detail: '4 vCPU · 16 GiB',
        price: 0.212, source: 'curated', asOf: CURATED_ON, sourceUrl: PRICING_URLS.azure,
        live: {
          kind: 'azure',
          filter: "serviceName eq 'Virtual Machines' and armRegionName eq 'centralindia' "
            + "and armSkuName eq 'Standard_D4s_v5' and priceType eq 'Consumption' "
            + "and contains(meterName, 'D4s v5')",
        },
      },
      c('gcp', 'e2-standard-4', 0.1928, PRICING_URLS.gcp, '4 vCPU · 16 GiB'),
      c('alibaba', 'ecs.g6.xlarge', 0.207, PRICING_URLS.alibaba, '4 vCPU · 16 GiB'),
      c('huawei', 's6.xlarge.4', 0.198, PRICING_URLS.huawei, '4 vCPU · 16 GiB'),
    ],
  },

  // ---- Storage ---------------------------------------------------------
  {
    id: 'object-storage-standard',
    category: 'storage',
    name: 'Object storage — standard tier',
    basis: 'First TB per month, standard/hot tier, single region. Request and '
      + 'retrieval charges are extra and not compared here.',
    unit: 'per GB-month',
    region: REGION,
    entries: [
      {
        provider: 'aws', sku: 'S3 Standard',
        price: 0.025, source: 'curated', asOf: CURATED_ON, sourceUrl: PRICING_URLS.aws,
        live: {
          kind: 'aws',
          serviceCode: 'AmazonS3',
          filters: { regionCode: 'ap-south-1', volumeType: 'Standard', storageClass: 'General Purpose' },
        },
      },
      c('azure', 'Blob Storage — Hot LRS', 0.021, PRICING_URLS.azure),
      c('gcp', 'Cloud Storage Standard', 0.023, PRICING_URLS.gcp),
      c('alibaba', 'OSS Standard — LRS', 0.0185, PRICING_URLS.alibaba),
      c('huawei', 'OBS Standard', 0.0198, PRICING_URLS.huawei),
    ],
  },
  {
    id: 'block-storage-ssd',
    category: 'storage',
    name: 'Block storage — general-purpose SSD',
    basis: 'Provisioned capacity only. Baseline IOPS included; provisioned IOPS extra.',
    unit: 'per GB-month',
    region: REGION,
    entries: [
      {
        provider: 'aws', sku: 'EBS gp3',
        price: 0.0912, source: 'curated', asOf: CURATED_ON, sourceUrl: PRICING_URLS.aws,
        live: {
          kind: 'aws',
          serviceCode: 'AmazonEC2',
          filters: { regionCode: 'ap-south-1', volumeApiName: 'gp3', productFamily: 'Storage' },
        },
      },
      c('azure', 'Premium SSD v2', 0.095, PRICING_URLS.azure),
      c('gcp', 'Balanced persistent disk', 0.1, PRICING_URLS.gcp),
      c('alibaba', 'ESSD PL0', 0.09, PRICING_URLS.alibaba),
      c('huawei', 'EVS General Purpose SSD', 0.089, PRICING_URLS.huawei),
    ],
  },

  // ---- Egress ----------------------------------------------------------
  {
    id: 'egress-internet',
    category: 'egress',
    name: 'Data transfer out to internet',
    basis: 'First 10 TB/month tier, after any always-free allowance. This is the '
      + 'line item that most often decides the bill, and the one that varies most.',
    unit: 'per GB',
    region: REGION,
    entries: [
      c('aws', 'EC2 / S3 data transfer out', 0.1093, PRICING_URLS.aws, 'first 10 TB, 100 GB/mo free'),
      c('azure', 'Bandwidth — internet egress', 0.1105, PRICING_URLS.azure, 'first 10 TB, 100 GB/mo free'),
      c('gcp', 'Standard tier egress', 0.12, PRICING_URLS.gcp, 'first 10 TB'),
      c('alibaba', 'Internet outbound', 0.117, PRICING_URLS.alibaba, 'pay-by-traffic'),
      c('huawei', 'Internet outbound', 0.114, PRICING_URLS.huawei, 'pay-by-traffic'),
    ],
  },

  // ---- Managed databases ----------------------------------------------
  {
    id: 'managed-postgres-2x8',
    category: 'database',
    name: 'Managed PostgreSQL — 2 vCPU / 8 GB',
    basis: 'Single instance, on-demand, no high-availability replica. Storage and '
      + 'backup charged separately.',
    unit: 'per hour',
    region: REGION,
    entries: [
      {
        provider: 'aws', sku: 'RDS PostgreSQL db.m5.large', detail: '2 vCPU · 8 GiB',
        price: 0.178, source: 'curated', asOf: CURATED_ON, sourceUrl: PRICING_URLS.aws,
        live: {
          kind: 'aws',
          serviceCode: 'AmazonRDS',
          filters: {
            instanceType: 'db.m5.large', regionCode: 'ap-south-1',
            databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ',
          },
        },
      },
      c('azure', 'Flexible Server D2ds_v4', 0.172, PRICING_URLS.azure, '2 vCPU · 8 GiB'),
      c('gcp', 'Cloud SQL db-custom-2-8192', 0.169, PRICING_URLS.gcp, '2 vCPU · 8 GiB'),
      c('alibaba', 'RDS PostgreSQL pg.n2.medium', 0.16, PRICING_URLS.alibaba, '2 vCPU · 8 GiB'),
      c('huawei', 'RDS for PostgreSQL general 2C8G', 0.158, PRICING_URLS.huawei, '2 vCPU · 8 GiB'),
    ],
  },

  // ---- Serverless ------------------------------------------------------
  {
    id: 'serverless-invocations',
    category: 'serverless',
    name: 'Function invocations',
    basis: 'Request charge only, past each provider\'s free tier. Compute time is '
      + 'billed separately (see below).',
    unit: 'per 1M requests',
    region: REGION,
    entries: [
      c('aws', 'Lambda', 0.2, PRICING_URLS.aws, '1M/mo always free'),
      c('azure', 'Functions — Consumption', 0.2, PRICING_URLS.azure, '1M/mo free'),
      c('gcp', 'Cloud Run functions', 0.4, PRICING_URLS.gcp, '2M/mo free'),
      c('alibaba', 'Function Compute', 0.2, PRICING_URLS.alibaba),
      c('huawei', 'FunctionGraph', 0.2, PRICING_URLS.huawei, '1M/mo free'),
    ],
  },
  {
    id: 'serverless-gb-second',
    category: 'serverless',
    name: 'Function compute time',
    basis: 'Memory-weighted duration, past the free tier. The dominant cost for '
      + 'anything doing real work per request.',
    unit: 'per GB-second',
    region: REGION,
    entries: [
      c('aws', 'Lambda', 0.0000166667, PRICING_URLS.aws, 'x86'),
      c('azure', 'Functions — Consumption', 0.000016, PRICING_URLS.azure),
      c('gcp', 'Cloud Run functions', 0.0000025, PRICING_URLS.gcp, 'CPU billed separately'),
      c('alibaba', 'Function Compute', 0.000016, PRICING_URLS.alibaba),
      c('huawei', 'FunctionGraph', 0.0000167, PRICING_URLS.huawei),
    ],
  },

  // ---- AI / LLM tokens -------------------------------------------------
  {
    id: 'llm-frontier-input',
    category: 'ai',
    regionIndependent: true,
    name: 'Frontier model — input tokens',
    basis: 'Each vendor\'s flagship general-purpose model. These are different '
      + 'models, not the same model resold — compare cost alongside capability, '
      + 'not on price alone.',
    unit: 'per 1M input tokens',
    entries: [
      c('openai', 'gpt-4o', 2.5, PRICING_URLS.openai),
      c('aws', 'Bedrock — Claude Sonnet', 3.0, 'https://aws.amazon.com/bedrock/pricing/'),
      c('azure', 'Azure OpenAI — gpt-4o', 2.5, 'https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/'),
      c('gcp', 'Vertex AI — Gemini 1.5 Pro', 1.25, 'https://cloud.google.com/vertex-ai/generative-ai/pricing'),
    ],
  },
  {
    id: 'llm-frontier-output',
    category: 'ai',
    regionIndependent: true,
    name: 'Frontier model — output tokens',
    basis: 'Same models as above. Output is several times the price of input on '
      + 'every vendor, so output volume drives the bill.',
    unit: 'per 1M output tokens',
    entries: [
      c('openai', 'gpt-4o', 10.0, PRICING_URLS.openai),
      c('aws', 'Bedrock — Claude Sonnet', 15.0, 'https://aws.amazon.com/bedrock/pricing/'),
      c('azure', 'Azure OpenAI — gpt-4o', 10.0, 'https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/'),
      c('gcp', 'Vertex AI — Gemini 1.5 Pro', 5.0, 'https://cloud.google.com/vertex-ai/generative-ai/pricing'),
    ],
  },
  {
    id: 'llm-small-input',
    category: 'ai',
    regionIndependent: true,
    name: 'Small / fast model — input tokens',
    basis: 'The cheap tier each vendor points you at for high-volume work.',
    unit: 'per 1M input tokens',
    entries: [
      c('openai', 'gpt-4o-mini', 0.15, PRICING_URLS.openai),
      c('aws', 'Bedrock — Claude Haiku', 0.25, 'https://aws.amazon.com/bedrock/pricing/'),
      c('azure', 'Azure OpenAI — gpt-4o-mini', 0.15, 'https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/'),
      c('gcp', 'Vertex AI — Gemini 1.5 Flash', 0.075, 'https://cloud.google.com/vertex-ai/generative-ai/pricing'),
    ],
  },
];

/**
 * The region the hand-recorded figures in this file were read for.
 *
 * Only AWS and Azure can be looked up live. Every other figure was read off a
 * vendor pricing page for one region, so outside that region it is dropped
 * rather than reused — a Mumbai number under a US heading would make a
 * provider look cheaper or dearer than it is, which is precisely the mistake
 * this catalogue exists to avoid.
 */
export const RECORDED_REGION: RegionId = 'ap-south-1';

export interface RegionalCatalog {
  region: RegionDef;
  workloads: Workload[];
  /** Providers dropped for want of a recorded price in this region. */
  omitted: ProviderKey[];
}

function retargetLive(live: LiveLookup, region: RegionDef): LiveLookup | undefined {
  if (live.kind === 'aws') {
    const code = region.codes.aws;
    if (!code) return undefined;
    const filters = { ...live.filters };
    for (const key of ['regionCode', 'fromRegionCode'] as const) {
      if (key in filters) filters[key] = code;
    }
    return { ...live, filters };
  }
  const code = region.codes.azure;
  if (!code) return undefined;
  return {
    ...live,
    filter: live.filter.replace(/armRegionName eq '[^']+'/, `armRegionName eq '${code}'`),
  };
}

export function catalogForRegion(regionId: string | undefined | null): RegionalCatalog {
  const region = regionById(regionId);
  const omitted = new Set<ProviderKey>();

  const workloads = WORKLOADS.map((w) => {
    // Tokens are billed per token, not per datacentre, so an LLM row is the
    // same everywhere and keeps all of its providers.
    if (w.regionIndependent) return { ...w, region: undefined };

    const forGroup = REGIONAL_PRICES[w.id] ?? {};

    const entries = w.entries.flatMap((e) => {
      const price = forGroup[e.provider]?.[region.id];
      if (price === undefined) {
        // Nothing recorded per region for this provider. The figures already
        // in this file were read for RECORDED_REGION, so in that region they
        // are exactly right and the provider stays — dropping it there would
        // have lost Google, Alibaba and Huawei from a comparison that has
        // always included them. Anywhere else there is no figure to show, and
        // quoting this one would put a Mumbai price under another region's
        // heading.
        if (region.id === RECORDED_REGION) return [e];
        omitted.add(e.provider);
        return [];
      }
      return [{
        ...e,
        price,
        source: 'curated' as const,
        asOf: REGIONAL_PRICES_AS_OF,
        // The lookup that produced this figure was region-specific, so a live
        // refresh must not overwrite it with a differently-targeted one.
        live: undefined,
      }];
    });

    return { ...w, region: region.label, entries };
  }).filter((w) => w.entries.length > 0);

  return { region, workloads, omitted: [...omitted] };
}
