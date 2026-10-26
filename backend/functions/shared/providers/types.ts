// The contract every cloud provider integration implements. Each adapter's
// only job is to turn provider-specific credentials + billing APIs into the
// same normalized monthly snapshot shape, so every read handler, the UI, and
// the anomaly rules stay provider-agnostic.

export interface ServiceBreakdownItem {
  name: string;
  spend: number;
  pct: number;
  /** % change vs the previous month; 0 when there's no prior month. */
  trend: number;
}

export interface RegionBreakdownItem {
  /** Provider's own identifier, e.g. "ap-south-1". */
  name: string;
  /** Human-readable location, e.g. "Mumbai (ap-south-1)". */
  displayName: string;
  spend: number;
  pct: number;
}

export interface TagBreakdownItem {
  label: string;
  spend: number;
  untagged: boolean;
}

/**
 * One service inside the untagged remainder.
 *
 * Deliberately not a ServiceBreakdownItem: `pct` and `trend` there are shares
 * of the whole month's bill, and reusing the type would invite a reader to
 * compare a figure measured against one denominator with one measured against
 * another. These are shares of the untagged total, computed where they are
 * shown.
 */
export interface UntaggedServiceItem {
  name: string;
  spend: number;
}

export interface MonthlySnapshot {
  /** yyyy-MM */
  monthKey: string;
  /** Short month label, e.g. "Aug" */
  label: string;
  totalSpend: number;
  isCurrent: boolean;
  serviceBreakdown: ServiceBreakdownItem[];
  /** Keyed by tag/label dimension; empty when the provider has none. */
  tagBreakdown: Record<string, TagBreakdownItem[]>;
  /**
   * What the untagged remainder was spent on, largest first.
   *
   * Empty for a provider with no tags at all, and for an account whose tag
   * keys are not activated — in both cases the remainder is the whole bill and
   * the service card already answers the question.
   */
  untaggedServices?: UntaggedServiceItem[];
  /**
   * Set when the provider could not be asked for the tag breakdown at all —
   * a rate limit, a timeout, a refused scope.
   *
   * This is not the same as "there are no tags", and persistence must not treat
   * it that way: an empty breakdown overwrites, an unavailable one is skipped
   * so whatever is already stored survives. OpenAI's project call being
   * rate-limited once blanked six months of project history because the two
   * cases were indistinguishable.
   */
  tagBreakdownUnavailable?: boolean;
  /**
   * Spend per data-centre location, highest first. Empty for providers whose
   * billing API doesn't expose a location dimension — callers show that as
   * "not available for this provider" rather than inventing a region.
   */
  regionBreakdown: RegionBreakdownItem[];
}

/**
 * A single day's spend. Deliberately lighter than the monthly snapshot: no tag
 * breakdown, since a per-day-per-tag pull multiplies metered API calls for
 * little benefit at this granularity.
 */
/** One project's share of a service's spend on one day. */
export interface ProjectShareItem {
  label: string;
  spend: number;
}

export interface DailySnapshot {
  /** yyyy-MM-dd */
  dayKey: string;
  /** Short label, e.g. "Aug 18" */
  label: string;
  totalSpend: number;
  serviceBreakdown: ServiceBreakdownItem[];
  /**
   * Which projects a service's spend came from that day, keyed by service
   * name and sorted most expensive first.
   *
   * Only providers with a project dimension supply it (OpenAI today). It
   * exists so an anomaly can say *where* a spike happened, which is the first
   * thing anyone asks and the one thing the service breakdown cannot answer:
   * a $16 gpt-image-1 day on an organisation with seven projects could be any
   * of them, and the monthly project totals look identical either way.
   *
   * Best-effort. Absent when the provider could not be asked — a rate limit,
   * a key without the management scope — and the anomaly then simply names
   * no project rather than the whole fetch failing.
   */
  projectBreakdown?: Record<string, ProjectShareItem[]>;
}

export interface CredentialField {
  /** Matches the field names in the onboarding requirements doc. */
  name: string;
  label: string;
  /** `secret` fields go to Secrets Manager and are never returned to a client. */
  type: 'text' | 'secret' | 'textarea';
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export type ProviderCredentials = Record<string, string>;

/*
 * Both set `name` explicitly rather than inheriting "Error".
 *
 * A bare `extends Error {}` leaves name as "Error", so a log recording
 * err.name could not tell the two apart — and the distinction is the
 * diagnosis: ProviderAuthError means we never got into the account, which is
 * the customer's trust policy, while ProviderPermissionError means we did get
 * in and the role lacks a required action, which is their permission policy.
 * Two different fixes to send them to.
 *
 * Assigned literally rather than read from constructor.name, which the
 * minified bundles these ship as would mangle.
 */
export class ProviderAuthError extends Error {
  override name = 'ProviderAuthError';
}
export class ProviderPermissionError extends Error {
  override name = 'ProviderPermissionError';
}

export interface ProviderAdapter {
  key: string;
  /** Human-readable provider name, for error messages. */
  displayName: string;
  /**
   * True once this adapter has been exercised against a real account of this
   * provider. Unverified adapters are still deployed but surfaced as such,
   * so nobody mistakes "structurally complete" for "known to work".
   */
  verified: boolean;
  /** Fields the UI collects to connect an account of this provider. */
  credentialFields: CredentialField[];
  /**
   * Confirms the credentials authenticate AND carry the billing-read
   * permission. Throw ProviderAuthError when the credentials themselves are
   * bad and ProviderPermissionError when they authenticate but can't read
   * billing — the two need different fixes from the customer.
   */
  verifyAccess(creds: ProviderCredentials): Promise<void>;
  /** Pulls the last `months` months of cost, most recent last. */
  fetchMonthlySnapshots(creds: ProviderCredentials, months: number): Promise<MonthlySnapshot[]>;
  /**
   * Pulls the last `days` days of cost, oldest first. Optional: a provider
   * whose billing API has no daily resolution simply omits it, and callers
   * treat daily views as unavailable for that provider rather than faking it.
   */
  fetchDailySnapshots?(creds: ProviderCredentials, days: number): Promise<DailySnapshot[]>;
}

// ---- helpers shared by adapters ----

export function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabelOf(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the month, `offset` months from `from`, in UTC. */
export function monthStart(from: Date, offset = 0): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));
}

export function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayLabelOf(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Midnight UTC, `offset` days from `from`. */
export function dayStart(from: Date, offset = 0): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset));
}

/**
 * Same role as buildSnapshots, for daily data: adapters supply raw per-day
 * service totals and this derives percentages and day-over-day trend, so that
 * arithmetic stays identical across providers.
 */
export function buildDailySnapshots(
  daily: Array<{
    date: Date;
    services: Array<{ name: string; spend: number }>;
    projectBreakdown?: Record<string, ProjectShareItem[]>;
  }>,
): DailySnapshot[] {
  const snapshots: DailySnapshot[] = daily.map(({ date, services, projectBreakdown }) => {
    const kept = services.filter((s) => s.spend > 0);
    const totalSpend = kept.reduce((sum, s) => sum + s.spend, 0);

    return {
      dayKey: dayKeyOf(date),
      label: dayLabelOf(date),
      totalSpend,
      serviceBreakdown: kept
        .map((s) => ({
          name: s.name,
          spend: s.spend,
          pct: totalSpend > 0 ? (s.spend / totalSpend) * 100 : 0,
          trend: 0,
        }))
        .sort((a, b) => b.spend - a.spend),
      // Left off entirely rather than set to an empty object, so a stored row
      // reads the same whether the provider has no project dimension or the
      // call for it failed — and a DynamoDB item never carries a key for
      // something it does not have.
      ...(projectBreakdown && Object.keys(projectBreakdown).length > 0 ? { projectBreakdown } : {}),
    };
  });

  for (let i = 1; i < snapshots.length; i++) {
    const prev = new Map(snapshots[i - 1].serviceBreakdown.map((s) => [s.name, s.spend]));
    for (const svc of snapshots[i].serviceBreakdown) {
      const before = prev.get(svc.name);
      svc.trend = before && before > 0 ? Math.round(((svc.spend - before) / before) * 100) : 0;
    }
  }

  return snapshots;
}

/**
 * Turns per-month {service -> spend} totals into full snapshots, filling in
 * percentages and real month-over-month trend. Adapters just supply the raw
 * numbers; this keeps that derivation identical across providers.
 */
export function buildSnapshots(
  monthly: Array<{
    date: Date;
    services: Array<{ name: string; spend: number }>;
    tagBreakdown?: Record<string, TagBreakdownItem[]>;
    untaggedServices?: UntaggedServiceItem[];
    regions?: Array<{ name: string; displayName: string; spend: number }>;
  }>,
): MonthlySnapshot[] {
  const currentKey = monthKeyOf(new Date());

  const snapshots: MonthlySnapshot[] = monthly.map((
    { date, services, tagBreakdown, untaggedServices, regions },
  ) => {
    const kept = services.filter((s) => s.spend > 0);
    const totalSpend = kept.reduce((sum, s) => sum + s.spend, 0);
    const key = monthKeyOf(date);

    return {
      monthKey: key,
      label: monthLabelOf(date),
      totalSpend,
      isCurrent: key === currentKey,
      serviceBreakdown: kept
        .map((s) => ({
          name: s.name,
          spend: s.spend,
          pct: totalSpend > 0 ? (s.spend / totalSpend) * 100 : 0,
          trend: 0,
        }))
        .sort((a, b) => b.spend - a.spend),
      tagBreakdown: tagBreakdown ?? {},
      // Only when the adapter supplied it. Defaulting to [] would stamp an
      // empty list onto every provider's rows, including those with no tag
      // dimension at all — and the reader downstream treats absent as "not
      // known yet" and empty as "asked, and there is nothing", which are
      // different answers that should not be collapsed here.
      ...(untaggedServices
        ? { untaggedServices: untaggedServices.filter((u) => u.spend > 0) }
        : {}),
      // Percentages are of the month's service total, so region and service
      // shares are expressed against the same denominator.
      regionBreakdown: (regions ?? [])
        .filter((r) => r.spend > 0)
        .map((r) => ({
          name: r.name,
          displayName: r.displayName,
          spend: r.spend,
          pct: totalSpend > 0 ? (r.spend / totalSpend) * 100 : 0,
        }))
        .sort((a, b) => b.spend - a.spend),
    };
  });

  for (let i = 1; i < snapshots.length; i++) {
    const prev = new Map(snapshots[i - 1].serviceBreakdown.map((s) => [s.name, s.spend]));
    for (const svc of snapshots[i].serviceBreakdown) {
      const before = prev.get(svc.name);
      svc.trend = before && before > 0 ? Math.round(((svc.spend - before) / before) * 100) : 0;
    }
  }

  return snapshots;
}
