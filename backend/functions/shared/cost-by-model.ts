/**
 * Which models each project spent on, over a month — and how that compares
 * to the same days last month.
 *
 * Built from the per-day project split the OpenAI adapter stores (see
 * `projectBreakdown` on DailySnapshot), summed across the month. The monthly
 * row cannot answer this: it holds spend per model and spend per project as
 * two separate lists that never meet. This is the join, done at read time
 * from the days that carry it.
 *
 * Honest about its gaps, and only its real ones. A day whose project call
 * failed carries no split and is absent from the sum, so the figures can run
 * short of the account's total. But a day with no spend has nothing to split
 * either, and the first version counted those as gaps too — it told a reader
 * "20 of 22 days" on a month where the two missing days had cost nothing.
 * Only a day that had spend and no split is a gap.
 */

import { ComparisonWindow, deltaPct } from './period';

export interface ModelSpend {
  name: string;
  spend: number;
  /**
   * Change against the same days last month, as a percentage. Null where
   * there is nothing to compare to: no comparison window (the 1st), or no
   * spend on this model in that window last month — a new model, not a
   * 100% rise.
   */
  trend: number | null;
}

export interface ProjectModels {
  label: string;
  spend: number;
  trend: number | null;
  models: ModelSpend[];
}

export interface CostByModel {
  /** yyyy-MM */
  month: string;
  /** Days of this month that had any spend. */
  daysWithSpend: number;
  /** Of those, days that carry no project split — the real gaps. */
  daysUnsplit: number;
  /** The like-for-like window the trends are measured over, or null on the 1st. */
  comparison: { days: number } | null;
  /** Most expensive project first; each project's models likewise. */
  projects: ProjectModels[];
}

interface DailyRowLike {
  dayKey?: unknown;
  totalSpend?: unknown;
  projectBreakdown?: unknown;
}

type Split = Record<string, Array<{ label: string; spend: number }>>;
/** project -> model -> spend */
type Totals = Map<string, Map<string, number>>;

function hasSplit(row: DailyRowLike): boolean {
  const s = row.projectBreakdown;
  return !!s && typeof s === 'object' && Object.keys(s as object).length > 0;
}

function accumulate(rows: DailyRowLike[], into: Totals): void {
  for (const row of rows) {
    if (!hasSplit(row)) continue;
    for (const [model, shares] of Object.entries(row.projectBreakdown as Split)) {
      for (const share of shares ?? []) {
        const spend = Number(share.spend) || 0;
        if (spend <= 0) continue;
        const models = into.get(share.label) ?? new Map<string, number>();
        models.set(model, (models.get(model) ?? 0) + spend);
        into.set(share.label, models);
      }
    }
  }
}

function inRange(rows: DailyRowLike[], from: string, to: string): DailyRowLike[] {
  return rows.filter((r) => typeof r.dayKey === 'string' && r.dayKey >= from && r.dayKey <= to);
}

export function costByModel(
  rows: DailyRowLike[],
  month: string,
  opts: { window?: ComparisonWindow | null; previousRows?: DailyRowLike[] } = {},
): CostByModel | null {
  const inMonth = rows.filter((r) => typeof r.dayKey === 'string' && r.dayKey.startsWith(month));
  if (inMonth.length === 0) return null;

  const spent = inMonth.filter((r) => (Number(r.totalSpend) || 0) > 0);
  const daysUnsplit = spent.filter((r) => !hasSplit(r)).length;

  const current: Totals = new Map();
  accumulate(inMonth, current);

  // No day carried a split: a provider without projects, or every call
  // failed. Null rather than an empty list, so the caller can leave the card
  // off entirely instead of drawing an empty one.
  if (!inMonth.some(hasSplit)) return null;

  // Same days last month, from the previous month's rows, so a model's trend
  // is "this month so far against the same stretch of last month" — the
  // comparison the rest of the account page already makes.
  const window = opts.window ?? null;
  const previous: Totals = new Map();
  if (window && opts.previousRows) {
    accumulate(inRange(opts.previousRows, window.previousFrom, window.previousTo), previous);
  }
  // The current side is windowed too, so both sides cover the same number of
  // days; summing the whole month against a windowed last month would inflate
  // every trend by however far past the window today is.
  const currentWindowed: Totals = new Map();
  if (window) accumulate(inRange(inMonth, window.currentFrom, window.currentTo), currentWindowed);

  const trendFor = (project: string, model?: string): number | null => {
    if (!window) return null;
    const now = currentWindowed.get(project);
    const then = previous.get(project);
    const sum = (m?: Map<string, number>) => (m ? [...m.values()].reduce((a, b) => a + b, 0) : 0);
    const cur = model ? (now?.get(model) ?? 0) : sum(now);
    const prev = model ? (then?.get(model) ?? 0) : sum(then);
    return deltaPct(cur, prev);
  };

  const projects: ProjectModels[] = [...current]
    .map(([label, models]) => {
      const list: ModelSpend[] = [...models]
        .map(([name, spend]) => ({ name, spend, trend: trendFor(label, name) }))
        .sort((a, b) => b.spend - a.spend);
      return {
        label,
        spend: list.reduce((s, m) => s + m.spend, 0),
        trend: trendFor(label),
        models: list,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  return {
    month,
    daysWithSpend: spent.length,
    daysUnsplit,
    comparison: window ? { days: window.days } : null,
    projects,
  };
}

/**
 * One project's spend on one model, per month, for the chart behind a row.
 *
 * Built from the daily splits bucketed by month. Months before the first
 * stored split have no data rather than zero spend, and say so: a bar at
 * zero would claim the project used nothing, when the truth is that nobody
 * was looking yet.
 */
export interface ProjectModelMonth {
  /** yyyy-MM */
  monthKey: string;
  spend: number;
  /** False where no day in that month carries a split at all. */
  hasData: boolean;
}

export function projectModelHistory(
  rows: DailyRowLike[],
  project: string,
  model: string,
  monthKeys: string[],
): ProjectModelMonth[] {
  return monthKeys.map((monthKey) => {
    const days = rows.filter((r) => typeof r.dayKey === 'string' && r.dayKey.startsWith(monthKey));
    const hasData = days.some(hasSplit);
    let spend = 0;
    for (const day of days) {
      if (!hasSplit(day)) continue;
      const shares = (day.projectBreakdown as Split)[model] ?? [];
      for (const s of shares) if (s.label === project) spend += Number(s.spend) || 0;
    }
    return { monthKey, spend, hasData };
  });
}
