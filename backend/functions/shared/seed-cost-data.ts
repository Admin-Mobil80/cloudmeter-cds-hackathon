// Deterministic seed-data generator, ported from the frontend prototype's
// client-side mock logic (account-detail.js). Same hash+PRNG approach, but
// now runs once server-side at account-creation time and is persisted to
// DynamoDB, rather than recomputed client-side on every page load.

const SERVICE_CATALOG: Record<string, { name: string; weight: number }[]> = {
  aws: [
    { name: 'Amazon EC2', weight: 0.34 },
    { name: 'Amazon S3', weight: 0.22 },
    { name: 'Amazon RDS', weight: 0.16 },
    { name: 'AWS Lambda', weight: 0.08 },
    { name: 'Amazon CloudFront', weight: 0.08 },
    { name: 'Elastic Load Balancing', weight: 0.06 },
    { name: 'Data Transfer', weight: 0.06 },
  ],
  azure: [
    { name: 'Virtual Machines', weight: 0.36 },
    { name: 'Storage Accounts', weight: 0.20 },
    { name: 'Azure SQL Database', weight: 0.18 },
    { name: 'App Service', weight: 0.10 },
    { name: 'Load Balancer', weight: 0.08 },
    { name: 'Bandwidth', weight: 0.08 },
  ],
  gcp: [
    { name: 'Compute Engine', weight: 0.32 },
    { name: 'BigQuery', weight: 0.20 },
    { name: 'Cloud Storage', weight: 0.18 },
    { name: 'Google Kubernetes Engine', weight: 0.14 },
    { name: 'Cloud SQL', weight: 0.10 },
    { name: 'Networking', weight: 0.06 },
  ],
  alibaba: [
    { name: 'Elastic Compute Service', weight: 0.38 },
    { name: 'Object Storage Service', weight: 0.24 },
    { name: 'ApsaraDB RDS', weight: 0.16 },
    { name: 'Server Load Balancer', weight: 0.12 },
    { name: 'CDN', weight: 0.10 },
  ],
  huawei: [
    { name: 'Elastic Cloud Server', weight: 0.40 },
    { name: 'Object Storage Service', weight: 0.22 },
    { name: 'RDS for MySQL', weight: 0.16 },
    { name: 'Elastic Load Balance', weight: 0.12 },
    { name: 'CDN', weight: 0.10 },
  ],
  // Line items, not products: OpenAI bills per model and per side of the
  // exchange, which is what the real Costs API returns for group_by=line_item.
  openai: [
    { name: 'gpt-4o, input', weight: 0.34 },
    { name: 'gpt-4o, output', weight: 0.28 },
    { name: 'gpt-4o-mini, input', weight: 0.14 },
    { name: 'gpt-4o-mini, output', weight: 0.11 },
    { name: 'text-embedding-3-large', weight: 0.08 },
    { name: 'Batch API', weight: 0.05 },
  ],
  // Meta bills per delivered template message, by category.
  whatsapp: [
    { name: 'Marketing', weight: 0.58 },
    { name: 'Utility', weight: 0.24 },
    { name: 'Authentication', weight: 0.15 },
    { name: 'Service', weight: 0.03 },
  ],
};

export const TAG_DIMENSIONS: Record<string, string[]> = {
  environment: ['Production', 'Staging', 'Development'],
  team: ['Platform', 'Data', 'Growth', 'Payments'],
  'cost-center': ['ENG-1001', 'ENG-1002', 'DATA-2001'],
};

// Per-provider location catalogue for sample accounts, so a demo workspace
// shows plausible geography instead of an empty region panel. Real accounts
// get their regions from the provider's billing API.
const REGION_CATALOG: Record<string, { name: string; displayName: string; weight: number }[]> = {
  // OpenAI bills no region dimension at all. An explicit single bucket keeps
  // sample data honest — the fallback below would otherwise label token spend
  // with AWS regions.
  openai: [
    { name: 'Global', displayName: 'Not region-specific', weight: 1 },
  ],
  // WhatsApp prices by recipient market, which is a country not a region.
  whatsapp: [
    { name: 'IN', displayName: 'India', weight: 0.52 },
    { name: 'BR', displayName: 'Brazil', weight: 0.21 },
    { name: 'ID', displayName: 'Indonesia', weight: 0.16 },
    { name: 'US', displayName: 'United States', weight: 0.11 },
  ],
  aws: [
    { name: 'us-east-1', displayName: 'N. Virginia (us-east-1)', weight: 0.38 },
    { name: 'eu-west-1', displayName: 'Ireland (eu-west-1)', weight: 0.24 },
    { name: 'ap-south-1', displayName: 'Mumbai (ap-south-1)', weight: 0.19 },
    { name: 'ap-southeast-1', displayName: 'Singapore (ap-southeast-1)', weight: 0.12 },
    { name: 'NoRegion', displayName: 'Not region-specific', weight: 0.07 },
  ],
  azure: [
    { name: 'eastus', displayName: 'East US (eastus)', weight: 0.36 },
    { name: 'westeurope', displayName: 'West Europe (westeurope)', weight: 0.27 },
    { name: 'centralindia', displayName: 'Central India (centralindia)', weight: 0.21 },
    { name: 'southeastasia', displayName: 'Southeast Asia (southeastasia)', weight: 0.16 },
  ],
  gcp: [
    { name: 'us-central1', displayName: 'Iowa (us-central1)', weight: 0.4 },
    { name: 'europe-west1', displayName: 'Belgium (europe-west1)', weight: 0.26 },
    { name: 'asia-south1', displayName: 'Mumbai (asia-south1)', weight: 0.2 },
    { name: 'asia-southeast1', displayName: 'Singapore (asia-southeast1)', weight: 0.14 },
  ],
  alibaba: [
    { name: 'cn-hangzhou', displayName: 'Hangzhou (cn-hangzhou)', weight: 0.44 },
    { name: 'ap-southeast-1', displayName: 'Singapore (ap-southeast-1)', weight: 0.31 },
    { name: 'eu-central-1', displayName: 'Frankfurt (eu-central-1)', weight: 0.25 },
  ],
  huawei: [
    { name: 'cn-north-4', displayName: 'Beijing (cn-north-4)', weight: 0.46 },
    { name: 'ap-southeast-3', displayName: 'Singapore (ap-southeast-3)', weight: 0.3 },
    { name: 'eu-west-101', displayName: 'Ireland (eu-west-101)', weight: 0.24 },
  ],
};

function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ServiceBreakdownItem {
  name: string;
  spend: number;
  pct: number;
  trend: number;
}

export interface TagBreakdownItem {
  label: string;
  spend: number;
  untagged: boolean;
}

export interface RegionBreakdownItem {
  name: string;
  displayName: string;
  spend: number;
  pct: number;
}

export interface MonthlySnapshot {
  monthKey: string; // yyyy-mm
  label: string;
  totalSpend: number;
  isCurrent: boolean;
  serviceBreakdown: ServiceBreakdownItem[];
  tagBreakdown: Record<string, TagBreakdownItem[]>;
  regionBreakdown: RegionBreakdownItem[];
}

function buildServiceBreakdown(provider: string, seedKey: string, totalSpend: number): ServiceBreakdownItem[] {
  const catalog = SERVICE_CATALOG[provider] || SERVICE_CATALOG.aws;
  const rand = mulberry32(hashStr(seedKey + 'svc'));
  const jittered = catalog.map((s) => ({ name: s.name, w: s.weight * (0.75 + rand() * 0.5) }));
  const totalW = jittered.reduce((s, x) => s + x.w, 0);
  return jittered
    .map((s) => ({
      name: s.name,
      spend: totalSpend * (s.w / totalW),
      pct: (s.w / totalW) * 100,
      trend: Math.round(rand() * 30 - 12),
    }))
    .sort((a, b) => b.spend - a.spend);
}

function buildRegionBreakdown(provider: string, seedKey: string, totalSpend: number): RegionBreakdownItem[] {
  const catalog = REGION_CATALOG[provider] || REGION_CATALOG.aws;
  const rand = mulberry32(hashStr(seedKey + 'region'));
  const jittered = catalog.map((r) => ({ ...r, w: r.weight * (0.8 + rand() * 0.4) }));
  const totalW = jittered.reduce((s, x) => s + x.w, 0);
  return jittered
    .map((r) => ({
      name: r.name,
      displayName: r.displayName,
      spend: totalSpend * (r.w / totalW),
      pct: (r.w / totalW) * 100,
    }))
    .sort((a, b) => b.spend - a.spend);
}

function buildTagBreakdown(seedKey: string, dimKey: string, totalSpend: number): TagBreakdownItem[] {
  const values = TAG_DIMENSIONS[dimKey];
  const rand = mulberry32(hashStr(seedKey + dimKey));
  const untaggedPct = 0.08 + rand() * 0.17;
  const remaining = 1 - untaggedPct;
  const weights = values.map(() => 0.4 + rand());
  const totalW = weights.reduce((a, b) => a + b, 0);
  const rows: TagBreakdownItem[] = values.map((v, i) => ({
    label: v,
    spend: totalSpend * remaining * (weights[i] / totalW),
    untagged: false,
  }));
  rows.push({ label: 'Untagged', spend: totalSpend * untaggedPct, untagged: true });
  return rows.sort((a, b) => b.spend - a.spend);
}

/** Deterministic base monthly spend for a brand-new account, in the same
 * rough $5k-$70k/mo range the original mock seed accounts used. */
export function baseSpendFor(provider: string, name: string): number {
  const rand = mulberry32(hashStr(provider + name + 'base'));
  return Math.round(5000 + rand() * 65000);
}

/** Generates 6 months of snapshots (5 past + current), each with its own
 * service + tag breakdown proportioned from that month's total spend. */
export function generateMonthlySnapshots(provider: string, name: string, currentMonthSpend: number): MonthlySnapshot[] {
  const seedKey = `${provider}${name}`;
  const rand = mulberry32(hashStr(seedKey + 'monthly'));
  const bumpFactor = 1.06 + rand() * 0.14;
  const baseLevel = currentMonthSpend / bumpFactor;
  const now = new Date();

  const snapshots: MonthlySnapshot[] = [];

  for (let i = 5; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthsAgoFactor = 1 - i * (0.015 + rand() * 0.02);
    const noise = 0.9 + rand() * 0.2;
    const totalSpend = Math.max(baseLevel * monthsAgoFactor * noise, baseLevel * 0.55);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthSeedKey = `${seedKey}${monthKey}`;

    snapshots.push({
      monthKey,
      label: d.toLocaleDateString('en-US', { month: 'short' }),
      totalSpend,
      isCurrent: false,
      serviceBreakdown: buildServiceBreakdown(provider, monthSeedKey, totalSpend),
      tagBreakdown: Object.fromEntries(
        Object.keys(TAG_DIMENSIONS).map((dim) => [dim, buildTagBreakdown(monthSeedKey, dim, totalSpend)]),
      ),
      regionBreakdown: buildRegionBreakdown(provider, monthSeedKey, totalSpend),
    });
  }

  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentSeedKey = `${seedKey}${currentMonthKey}`;
  snapshots.push({
    monthKey: currentMonthKey,
    label: now.toLocaleDateString('en-US', { month: 'short' }),
    totalSpend: currentMonthSpend,
    isCurrent: true,
    serviceBreakdown: buildServiceBreakdown(provider, currentSeedKey, currentMonthSpend),
    tagBreakdown: Object.fromEntries(
      Object.keys(TAG_DIMENSIONS).map((dim) => [dim, buildTagBreakdown(currentSeedKey, dim, currentMonthSpend)]),
    ),
    regionBreakdown: buildRegionBreakdown(provider, currentSeedKey, currentMonthSpend),
  });

  return snapshots;
}

export interface DailySeedSnapshot {
  dayKey: string;
  label: string;
  totalSpend: number;
  serviceBreakdown: ServiceBreakdownItem[];
}

/**
 * Daily equivalent of generateMonthlySnapshots, for accounts using sample
 * data. Days carry a weekday/weekend rhythm so the series looks like real
 * infrastructure spend rather than noise around a flat line.
 */
export function generateDailySnapshots(
  provider: string,
  name: string,
  monthlySpend: number,
  days: number,
): DailySeedSnapshot[] {
  const seedKey = `${provider}${name}`;
  const rand = mulberry32(hashStr(seedKey + 'daily'));
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // `monthlySpend` is month-to-date, not a full month, so the daily rate is
  // what's been spent divided by the days elapsed. Dividing by a flat 30
  // produced a daily series that summed to roughly two-thirds of the monthly
  // figure — sample accounts then showed one number on the dashboard and a
  // visibly smaller one in every daily view built from these rows.
  const perDay = monthlySpend / Math.max(1, dayOfMonth);

  const raw: Array<{ dayKey: string; label: string; weight: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const dow = d.getUTCDay();
    const weekendDip = dow === 0 || dow === 6 ? 0.82 : 1;
    raw.push({
      dayKey: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      weight: weekendDip * (0.9 + rand() * 0.2),
    });
  }

  // Weekend dips and noise would still leave the month a few percent off, so
  // the current month's days are scaled to land exactly on the monthly figure.
  // Sample data that doesn't reconcile with itself is indistinguishable from a
  // bug in the real pipeline.
  const thisMonth = raw.filter((r) => r.dayKey.startsWith(currentMonth));
  const weightSum = thisMonth.reduce((sum, r) => sum + r.weight, 0);
  const scale = weightSum > 0 ? monthlySpend / (perDay * weightSum) : 1;

  return raw.map((r) => {
    const totalSpend = perDay * r.weight * (r.dayKey.startsWith(currentMonth) ? scale : 1);
    return {
      dayKey: r.dayKey,
      label: r.label,
      totalSpend,
      serviceBreakdown: buildServiceBreakdown(provider, `${seedKey}${r.dayKey}`, totalSpend),
    };
  });
}
