import { createHash } from 'crypto';
import {
  ProviderAdapter,
  ProviderCredentials,
  ProviderAuthError,
  ProviderPermissionError,
  MonthlySnapshot,
  DailySnapshot,
  TagBreakdownItem,
  ProjectShareItem,
  buildSnapshots,
  buildDailySnapshots,
  monthKeyOf,
  monthStart,
  dayStart,
  dayKeyOf,
} from './types';

// OpenAI isn't a cloud in the IaaS sense, but the shape of the problem is
// identical: a metered account whose spend nobody notices until the invoice.
// Token spend is billed per model and per project, which maps cleanly onto the
// service and tag breakdowns every other provider here already produces.
//
// Everything comes from the Costs endpoint of the Admin API. That endpoint is
// the one OpenAI documents as reconciling to the invoice — the Usage endpoints
// report tokens, which would have us inventing prices.
const COSTS_URL = 'https://api.openai.com/v1/organization/costs';

// Names for the project ids the Costs endpoint returns. Read-only, and treated
// as strictly optional throughout — see fetchProjectNames.
const PROJECTS_URL = 'https://api.openai.com/v1/organization/projects';

// A hung socket must never hold a Lambda invocation open until its own timeout.
const REQUEST_TIMEOUT_MS = 15_000;

// Costs buckets are one day wide (the only width the endpoint supports), so a
// six-month pull is ~180 buckets. 180 is also the endpoint's own per-page
// ceiling, so this is one page per request at best and paginated beyond that.
const MAX_BUCKETS_PER_PAGE = 180;
// Six months of days, plus slack for pagination that returns short pages.
const MAX_PAGES = 20;

/** How many project dimensions to surface, most expensive first. */
const MAX_PROJECTS = 10;

// The Projects endpoint pages independently of costs. 100 is its ceiling; the
// page cap is a guard against a cursor that never terminates, matching the one
// on the costs pager.
const PROJECTS_PER_PAGE = 100;
const MAX_PROJECT_PAGES = 10;

interface CostAmount {
  value?: number | string;
  currency?: string;
}

interface CostResult {
  amount?: CostAmount;
  line_item?: string | null;
  project_id?: string | null;
}

interface CostBucket {
  start_time?: number;
  end_time?: number;
  results?: CostResult[];
}

interface ProjectSummary {
  id?: string | null;
  name?: string | null;
}

interface ProjectsPage {
  data?: ProjectSummary[];
  has_more?: boolean;
}

interface CostsPage {
  data?: CostBucket[];
  has_more?: boolean;
  next_page?: string | null;
  error?: { message?: string; code?: string; type?: string };
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Splits the failure modes the customer can actually act on, which for this
 * endpoint are two different permission problems that look alike:
 *
 *   401 — wrong *kind* of key. A project key ("sk-proj-...") authenticates
 *         fine elsewhere in OpenAI but cannot reach the Admin API at all.
 *   403 — right kind of key, wrong *scope*. Admin keys carry granular
 *         permissions, and reading costs needs usage/cost read on the key
 *         itself. Being an organization Owner does not confer it.
 *
 * The distinction matters because the fixes are in different places, and
 * conflating them sends an Owner hunting for a role they already have.
 */
function classifyFailure(status: number, message: string): Error {
  const detail = `HTTP ${status}${message ? `: ${message}` : ''}`;

  if (status === 403) {
    // Not an org-role problem, which is what this used to claim and what sent
    // an actual organization Owner looking in the wrong place. Admin keys
    // carry their own permission scopes, and reading costs needs usage/cost
    // read (api.usage.read) on the key itself — a key minted without it is
    // refused no matter who created it.
    return new ProviderPermissionError(
      `OpenAI authenticated the key but refused the billing query, which means the key `
        + `lacks the scope to read usage and costs — not that your account lacks permission. `
        + `In Settings > Organization > Admin keys, check this key's permissions and give it `
        + `read access to Usage/Costs (api.usage.read), or create a new admin key with it. `
        + `(${detail})`,
    );
  }
  if (status === 401) {
    return new ProviderAuthError(
      `OpenAI rejected the key. The Costs API needs an Admin key (it starts with "sk-admin-"), `
        + `created by an organization Owner under Settings > Organization > Admin keys — `
        + `an ordinary project API key won't work here. (${detail})`,
    );
  }
  if (status === 429) {
    return new Error(`OpenAI rate-limited the billing query — it will be retried on the next sync. (${detail})`);
  }
  return new Error(`OpenAI cost query failed (${detail})`);
}

/**
 * How long a 429 may hold a sync up, in total.
 *
 * Bounded because this runs on both sides of the product: the hourly sweep has
 * fifteen minutes and would not notice, but the Refresh button is an HTTP
 * request on a sixty-second lambda, and a wait longer than this would turn a
 * rate limit into a hang — a worse failure than the error it replaces.
 *
 * OpenAI's own Retry-After on this endpoint is normally a second or two, so
 * the cap is generous rather than tight. A limit that wants longer than this
 * is a sustained problem, and failing with the existing message is the honest
 * answer to that.
 */
const MAX_RETRY_WAIT_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/**
 * How long to wait after a 429, from OpenAI's own header.
 *
 * `Retry-After` is seconds here, and `x-ratelimit-reset-requests` is a
 * duration like "1.5s" or "60s". Read rather than guessed: backing off for an
 * invented interval is how a client turns one rate limit into a queue of them.
 *
 * Returns null when there is nothing to go on, or when the wait exceeds the
 * cap — "we do not know" and "too long to wait" both mean don't retry, and
 * inventing a delay for either is the thing this avoids.
 */
export function retryAfterMs(headers: {
  get(name: string): string | null;
}): number | null {
  const seconds = Number(headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) {
    const ms = seconds * 1000;
    return ms <= MAX_RETRY_WAIT_MS ? ms : null;
  }

  const reset = headers.get('x-ratelimit-reset-requests');
  const m = reset?.match(/^([\d.]+)(ms|s|m)$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
    if (Number.isFinite(ms) && ms > 0) return ms <= MAX_RETRY_WAIT_MS ? ms : null;
  }
  return null;
}

/** One page of daily cost buckets. `page` is the opaque cursor OpenAI returns. */
async function fetchCostsPage(
  creds: ProviderCredentials,
  params: { startTime: number; endTime: number; groupBy: string | string[]; page?: string },
): Promise<CostsPage> {
  const query = new URLSearchParams({
    start_time: String(params.startTime),
    end_time: String(params.endTime),
    bucket_width: '1d',
    limit: String(MAX_BUCKETS_PER_PAGE),
  });
  // Repeated rather than comma-joined: the endpoint takes group_by as an array.
  // Several at once gives one row per combination — line item × project —
  // which is how a day's spend on one model gets attributed to a project.
  for (const g of Array.isArray(params.groupBy) ? params.groupBy : [params.groupBy]) {
    query.append('group_by', g);
  }
  if (params.page) query.set('page', params.page);

  const call = async (): Promise<Response> => {
    try {
      return await fetch(`${COSTS_URL}?${query.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.admin_api_key}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Couldn't reach the OpenAI API (${(err as Error).name})`);
    }
  };

  let res = await call();

  /*
   * One retry on a rate limit, waiting exactly as long as OpenAI asks.
   *
   * A sync of this account makes several of these calls, and the organisation
   * allowance is thirty a minute across every client touching it — so a busy
   * account can exhaust it inside one sweep. Every 429 in the last three days
   * happened within a single sweep invocation, twelve of them in one.
   *
   * Until now a 429 failed the whole sync and waited an hour, leaving a red
   * banner on the account page for data that was usually fine. Waiting the
   * second or two the header names turns most of those into a success.
   *
   * Deliberately one attempt. A loop here would queue behind a limit that is
   * already saturated and spend the lambda's budget making it worse.
   */
  if (res.status === 429) {
    // `headers` is always present on a real Response; guarded because a proxy
    // shim or a polyfill that omits it must cost us the retry, not crash the
    // whole sync on the one path that exists to make rate limits survivable.
    const wait = res.headers ? retryAfterMs(res.headers) : null;
    if (wait !== null) {
      console.warn(`OpenAI rate-limited; retrying once in ${wait}ms`);
      await sleep(wait);
      res = await call();
    }
  }

  const text = await res.text();
  let body: CostsPage = {};
  try {
    body = text ? (JSON.parse(text) as CostsPage) : {};
  } catch {
    // Edge/proxy errors ahead of the API can come back as HTML; keep the status.
  }

  if (!res.ok) {
    // Fall back to the raw body when the error isn't in the shape we expect:
    // OpenAI's own wording is far more use than a bare status, and losing it
    // is how a 403 ends up explained by a guess. Truncated, and the key is
    // only ever in the request headers, never the response.
    const stated = body.error?.message
      ?? (text ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : '');
    console.error('OpenAI costs request failed', { status: res.status, body: stated });
    throw classifyFailure(res.status, stated);
  }
  return body;
}

/** Every daily bucket in the window, following pagination. */
async function fetchAllBuckets(
  creds: ProviderCredentials,
  startTime: number,
  endTime: number,
  groupBy: string | string[],
): Promise<CostBucket[]> {
  const buckets: CostBucket[] = [];
  let page: string | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await fetchCostsPage(creds, { startTime, endTime, groupBy, page });
    buckets.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return buckets;
}

/**
 * Project id -> display name, for labelling the project breakdown.
 *
 * The Costs endpoint only ever returns project_id, so a name has to come from
 * the Projects endpoint separately. That endpoint needs a different scope from
 * costs (api.management.read rather than api.usage.read), and a key can carry
 * one without the other — so this must never be allowed to fail a sync. Every
 * failure path returns an empty map and the caller falls back to the raw id,
 * which is exactly what the breakdown showed before this existed.
 *
 * Archived projects are included: a project can be archived and still hold
 * spend inside the six-month window, and dropping it would put the id back on
 * screen for no reason.
 */
/**
 * Names change almost never, and this call competes with the cost queries for
 * the same 30-per-minute allowance. Cached for the life of the execution
 * environment, re-read at most once a day.
 *
 * Keyed by credential, never global. One Lambda container serves every tenant
 * in turn, so a single shared map would hand one organization's project names
 * to another's sync. Ids are unique per organization so a collision would miss
 * rather than mislabel — but "probably harmless" is not a basis for sharing
 * one customer's data structure with another.
 */
const NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const nameCaches = new Map<string, { at: number; names: Map<string, string> }>();

/** Stable per-credential key. The key itself is never stored, only its digest. */
function cacheKeyFor(creds: ProviderCredentials): string {
  return createHash('sha256').update(String(creds.admin_api_key ?? '')).digest('hex').slice(0, 32);
}

/** Exposed for tests: container-level state must not leak between cases. */
export function __resetProjectNameCache(): void {
  nameCaches.clear();
}

async function fetchProjectNames(creds: ProviderCredentials): Promise<Map<string, string>> {
  const cacheKey = cacheKeyFor(creds);
  const cached = nameCaches.get(cacheKey);
  if (cached && Date.now() - cached.at < NAME_CACHE_TTL_MS && cached.names.size > 0) {
    return cached.names;
  }

  const names = new Map<string, string>();
  let after: string | undefined;

  try {
    for (let i = 0; i < MAX_PROJECT_PAGES; i++) {
      const query = new URLSearchParams({
        limit: String(PROJECTS_PER_PAGE),
        include_archived: 'true',
      });
      if (after) query.set('after', after);

      const res = await fetch(`${PROJECTS_URL}?${query.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.admin_api_key}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        // Most often 401/403: the key can read costs but not org management.
        // Not an error the customer needs to act on — the breakdown still
        // works, it just shows ids — so this is logged, never thrown.
        console.warn('OpenAI project names unavailable; falling back to ids', { status: res.status });
        return new Map();
      }

      const body = (await res.json()) as ProjectsPage;
      const page = body.data ?? [];
      for (const p of page) {
        const id = (p.id ?? '').trim();
        const name = (p.name ?? '').trim();
        if (id && name) names.set(id, name);
      }
      if (!body.has_more || page.length === 0) break;
      after = page[page.length - 1]?.id ?? undefined;
      if (!after) break;
    }
  } catch (err) {
    console.warn('OpenAI project names lookup failed; falling back to ids', {
      error: (err as Error).message,
    });
    return new Map();
  }

  // Only a populated result is worth caching — an empty one usually means the
  // lookup was refused, and caching that would keep ids on screen all day.
  if (names.size > 0) nameCaches.set(cacheKey, { at: Date.now(), names });
  return names;
}

/** Unix seconds — what the Costs endpoint takes for start_time/end_time. */
function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * The bucket's own day, in UTC. `start_time` is the authority rather than the
 * position in the array: pages can arrive short, and a missing day must leave
 * a gap rather than shift every later day by one.
 */
function bucketDate(bucket: CostBucket): Date | null {
  if (typeof bucket.start_time !== 'number') return null;
  const d = new Date(bucket.start_time * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Line items name the model and the side of the exchange — "gpt-4o-2024-08-06,
 * input" — which is exactly the granularity the service breakdown wants, and
 * is why costs are grouped by line_item rather than by model.
 */
function serviceNameOf(result: CostResult): string {
  const item = (result.line_item ?? '').trim();
  return item || 'OpenAI usage';
}

export const openaiAdapter: ProviderAdapter = {
  key: 'openai',
  displayName: 'OpenAI',
  // Run against a real organization's Admin key: a production account holds
  // months of daily usage rows, project breakdown included.
  verified: true,

  credentialFields: [
    {
      name: 'admin_api_key',
      label: 'Admin API Key',
      type: 'secret',
      required: true,
      placeholder: 'sk-admin-…',
      help: 'Settings > Organization > Admin keys, created by an organization Owner. '
        + 'A project API key cannot read cost data. Stored encrypted and never shown again.',
    },
    {
      name: 'organization_name',
      label: 'Organization Name',
      type: 'text',
      required: true,
      placeholder: 'Acme Inc.',
      help: 'How this OpenAI organization is labelled in CloudMeter.',
    },
  ],

  async verifyAccess(creds) {
    if (!(creds.admin_api_key ?? '').trim()) {
      throw new ProviderAuthError('Enter the OpenAI Admin API key.');
    }
    // Yesterday onward: one bucket, enough to prove the key authenticates and
    // is allowed to read costs, without pulling a history we throw away. A
    // brand-new organization with no spend yet returns an empty page, which
    // is a valid answer — not a failure.
    const now = new Date();
    await fetchCostsPage(creds, {
      startTime: unixSeconds(dayStart(now, -1)),
      endTime: unixSeconds(now),
      groupBy: 'line_item',
    });
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const now = new Date();
    const start = monthStart(now, -(months - 1));
    const end = monthStart(now, 1);

    /**
     * Sequential, not Promise.all.
     *
     * The Costs endpoint allows 30 requests per minute for the whole
     * organization. Firing three calls at once, on every sync, against an
     * account the hourly sweep and the account page both refresh, was enough
     * to trip it — and a 429 on the project call silently blanked the project
     * breakdown for all six months. Spacing them out costs a second or two per
     * sync and keeps the burst well inside the allowance.
     */
    const byLineItem = await fetchAllBuckets(creds, unixSeconds(start), unixSeconds(end), 'line_item');

    // Projects are OpenAI's own unit of attribution, so they fill the same role
    // tags do elsewhere: which part of the business the spend belongs to.
    // Optional — an organization using no projects still gets services.
    //
    // `projectsUnavailable` distinguishes "this organization has no projects"
    // from "we could not ask". They are not the same, and treating them alike
    // is what let a rate-limit erase six months of history.
    let byProject: CostBucket[] = [];
    let projectsUnavailable = false;
    try {
      byProject = await fetchAllBuckets(creds, unixSeconds(start), unixSeconds(end), 'project_id');
    } catch (err) {
      projectsUnavailable = true;
      // Logged, not swallowed. This failure used to be completely silent,
      // which made it undiagnosable from the outside: services kept updating
      // while the project breakdown quietly vanished.
      console.warn('OpenAI project breakdown unavailable; keeping previously stored projects', {
        error: (err as Error).message,
      });
    }

    const projectNames = byProject.length > 0 ? await fetchProjectNames(creds) : new Map<string, string>();

    // month -> line item -> spend
    const services = new Map<string, Map<string, number>>();
    for (const bucket of byLineItem) {
      const date = bucketDate(bucket);
      if (!date) continue;
      const key = monthKeyOf(date);
      const perMonth = services.get(key) ?? new Map<string, number>();
      for (const result of bucket.results ?? []) {
        const name = serviceNameOf(result);
        perMonth.set(name, (perMonth.get(name) ?? 0) + toNumber(result.amount?.value));
      }
      services.set(key, perMonth);
    }

    // month -> project -> spend
    const projects = new Map<string, Map<string, number>>();
    for (const bucket of byProject) {
      const date = bucketDate(bucket);
      if (!date) continue;
      const key = monthKeyOf(date);
      const perMonth = projects.get(key) ?? new Map<string, number>();
      for (const result of bucket.results ?? []) {
        // Keyed by id, not by the label shown later: two projects are allowed
        // to share a display name, and totalling them under one key would
        // silently merge two projects' spend into one row.
        //
        // An empty id is real spend that predates projects or was made outside
        // one — the same idea as untagged resources elsewhere. It cannot
        // collide with a real key, which is always "proj_…".
        const id = (result.project_id ?? '').trim();
        perMonth.set(id, (perMonth.get(id) ?? 0) + toNumber(result.amount?.value));
      }
      projects.set(key, perMonth);
    }

    const monthly: Array<{
      date: Date;
      services: Array<{ name: string; spend: number }>;
      tagBreakdown: Record<string, TagBreakdownItem[]>;
    }> = [];

    // Every month in the window, including ones with no spend, so the trend
    // line has no holes.
    for (let i = months - 1; i >= 0; i--) {
      const date = monthStart(now, -i);
      const key = monthKeyOf(date);

      const items = [...(projects.get(key) ?? new Map<string, number>())]
        .filter(([, spend]) => spend > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PROJECTS)
        // Name where one is known, id where it isn't — an unnamed id reads
        // exactly as this breakdown always has, so a key without the
        // management scope loses nothing it had before.
        .map(([id, spend]) => ({
          label: id ? (projectNames.get(id) ?? id) : 'No project',
          spend,
          untagged: id === '',
        }));

      monthly.push({
        date,
        services: [...(services.get(key) ?? new Map<string, number>())]
          .map(([name, spend]) => ({ name, spend })),
        tagBreakdown: items.length > 0 ? { Project: items } : {},
      });
    }

    // A failed project call must not overwrite good data with nothing — the
    // persistence layer reads this and keeps whatever projects are already
    // stored for the month.
    return buildSnapshots(monthly).map((s) => (projectsUnavailable ? { ...s, tagBreakdownUnavailable: true } : s));
  },

  // Costs are billed in daily buckets natively, so the daily view is the raw
  // data rather than anything derived — no reason to withhold it.
  async fetchDailySnapshots(creds, days): Promise<DailySnapshot[]> {
    const now = new Date();
    const start = dayStart(now, -(days - 1));
    const buckets = await fetchAllBuckets(
      creds,
      unixSeconds(start),
      unixSeconds(dayStart(now, 1)),
      'line_item',
    );

    const byDay = new Map<string, Map<string, number>>();
    for (const bucket of buckets) {
      const date = bucketDate(bucket);
      if (!date) continue;
      const key = dayKeyOf(date);
      const perDay = byDay.get(key) ?? new Map<string, number>();
      for (const result of bucket.results ?? []) {
        const name = serviceNameOf(result);
        perDay.set(name, (perDay.get(name) ?? 0) + toNumber(result.amount?.value));
      }
      byDay.set(key, perDay);
    }

    /*
     * The same days again, split by project as well as line item, so an
     * anomaly can say which project a spike came from.
     *
     * A separate call rather than folding project_id into the one above: the
     * service totals every chart and every baseline is built from are left
     * exactly as they were, and this can fail on its own. It does fail — a
     * rate limit, or a key without the management scope — and when it does
     * the day simply carries no project split. The alert then names no
     * project, which is what it did before this existed. It never takes the
     * daily fetch down with it; the numbers matter more than the attribution.
     */
    let byProject: Map<string, Map<string, Map<string, number>>> | null = null;
    try {
      const split = await fetchAllBuckets(
        creds,
        unixSeconds(start),
        unixSeconds(dayStart(now, 1)),
        ['line_item', 'project_id'],
      );
      const names = split.length > 0 ? await fetchProjectNames(creds) : new Map<string, string>();
      byProject = new Map();
      for (const bucket of split) {
        const date = bucketDate(bucket);
        if (!date) continue;
        const day = byProject.get(dayKeyOf(date)) ?? new Map<string, Map<string, number>>();
        for (const result of bucket.results ?? []) {
          const service = serviceNameOf(result);
          const id = (result.project_id ?? '').trim();
          // Same rule as the monthly breakdown: a name where one is known, the
          // id where it isn't, and spend outside any project labelled as such.
          const label = id ? (names.get(id) ?? id) : 'No project';
          const perService = day.get(service) ?? new Map<string, number>();
          perService.set(label, (perService.get(label) ?? 0) + toNumber(result.amount?.value));
          day.set(service, perService);
        }
        byProject.set(dayKeyOf(date), day);
      }
    } catch (err) {
      console.warn('OpenAI daily project split unavailable; days will carry no project attribution', {
        error: (err as Error).message,
      });
    }

    const daily: Array<{
      date: Date;
      services: Array<{ name: string; spend: number }>;
      projectBreakdown?: Record<string, ProjectShareItem[]>;
    }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayStart(now, -i);
      const key = dayKeyOf(date);
      const projects = byProject?.get(key);
      daily.push({
        date,
        services: [...(byDay.get(key) ?? new Map<string, number>())]
          .map(([name, spend]) => ({ name, spend })),
        ...(projects ? {
          projectBreakdown: Object.fromEntries(
            [...projects]
              .map(([service, perProject]) => [
                service,
                [...perProject]
                  .filter(([, spend]) => spend > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([label, spend]) => ({ label, spend })),
              ] as const)
              // OpenAI answers with every line item it has ever seen on the
              // account, not just the ones charged that day, so most come back
              // at $0. Once those are filtered above, a name with nothing under
              // it is left — and 30 of the 50 on one real day were exactly
              // that. Dropped, so the split lists the same services the spend
              // breakdown beside it does.
              .filter(([, rows]) => rows.length > 0),
          ),
        } : {}),
      });
    }

    return buildDailySnapshots(daily);
  },
};
