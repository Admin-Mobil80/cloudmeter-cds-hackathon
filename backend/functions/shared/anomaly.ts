import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import type { ServiceBreakdownItem } from './providers';

/** Complete days averaged to decide what "normal" looks like for a service. */
const BASELINE_DAYS = 7;

/**
 * A service must move at least this much per day to be worth anyone's
 * attention. Percentages alone are useless at the bottom of a bill: a service
 * going from 2 cents to 20 is up 900%, and nobody wants that message.
 */
const MIN_DELTA_PER_DAY = 3;

/** And it must move by at least this share of its own normal level. */
const MIN_DELTA_PCT = 40;

/**
 * ...unless the move is simply large, in which case the percentage stops
 * mattering. A $900/day service rising 15% is under the percentage floor but
 * is $4,000 a month — exactly the kind of drift a cost tool exists to catch,
 * and the kind a percentage-only rule sails straight past.
 */
const ALWAYS_ALERT_DELTA_PER_DAY = 50;

/**
 * How far above its baseline a service must already be, partway through
 * today, to be worth saying so before the day is out.
 *
 * Everything else waits for the day to close, and rightly: a partial day
 * understates every service on the account, so judging one would report a
 * collapse every morning. This path is safe for the opposite reason — a
 * partial figure can only be lower than the day's final total, so a service
 * that has *already* exceeded its normal daily spend by this much has
 * genuinely done so. Incompleteness cannot manufacture this signal, only
 * hide it.
 *
 * Deliberately the same number as ALWAYS_ALERT_DELTA_PER_DAY. That is the
 * figure the detector already treats as large enough to matter whatever the
 * percentage, and having two thresholds would mean explaining why a move is
 * urgent at one size and merely notable at another.
 *
 * The lag this closes was real: gpt-6-astra went from nothing to $355 in a
 * day on one account, and the alert arrived thirty-three hours later,
 * because nothing could be judged until that day was complete.
 */
const PARTIAL_DAY_MIN_DELTA = ALWAYS_ALERT_DELTA_PER_DAY;

/**
 * Providers whose part-day figures are worth judging before the day ends.
 *
 * OpenAI alone, and the restriction is about the data rather than the rule.
 * OpenAI reports usage within the hour, so a part-day figure there is a real
 * reading of a day in progress. Cost Explorer lags: on a sweep across every
 * live account, seventeen of eighteen AWS accounts had no row for today at
 * all, and Azure, GCP, WhatsApp and Huawei had none either. The rule would
 * simply find nothing to read for them.
 *
 * Named explicitly rather than left open, so a provider whose reporting
 * speeds up later starts alerting mid-day because somebody decided it should,
 * not because its data quietly began arriving sooner. The account owner asked
 * for exactly this on 2026-09-25.
 *
 * Nothing here affects the complete-day path above, which every provider
 * keeps: this decides *when* a spike is reported, never *whether*.
 */
const PARTIAL_DAY_PROVIDERS = new Set<string>(['openai']);

/**
 * Dollar floor on the percentage escape below, so it takes a real move — not
 * a fraction of a cent — to qualify on percentage alone. Without this, a
 * WhatsApp account going from $0.001 to $0.01/day would read as "up 900%",
 * which is exactly the noise MIN_DELTA_PER_DAY's own comment warns against —
 * the escape exists for accounts priced in cents, not fractions of one.
 */
const MIN_DELTA_FOR_PCT_PATH = 0.20;

/**
 * Charges that arrive on a billing event rather than through daily usage.
 *
 * Cost Explorer reports these under its SERVICE dimension like anything else,
 * so to the usage rules they look like a service that sat at $0 for a week and
 * then jumped: Amazon Registrar billed $46 on one day and nothing on the six
 * either side. That is the expected shape of an annual renewal, not a spike.
 *
 * Matched on the exact SERVICE value AWS emits. These are enumerated values
 * from the billing API, not free text, so exact matching is safe — and it is
 * the only identifier stored on a daily row; there is no usage type or service
 * code to key on without changing the Cost Explorer query and the stored
 * schema.
 *
 * Amazon Route 53 is deliberately absent. It bills hosted zones *daily* in
 * most accounts here (non-zero on 34 of 35 days), so treating it as fixed
 * would suppress genuine hosted-zone spikes. Domain registration lands under
 * Amazon Registrar, which is on the list.
 */
export const FIXED_CHARGE_SERVICES = new Set<string>([
  'Tax',
  'Amazon Registrar',
]);

/**
 * Occurrences of a fixed charge needed before its amount can be judged.
 *
 * One prior charge is an anecdote: a first renewal at a different price would
 * alert on nothing more than being the second one seen. Two gives a mean worth
 * comparing against.
 */
const FIXED_CHARGE_MIN_HISTORY = 2;

/**
 * How far above its own historical amount a fixed charge must be to alert.
 *
 * Reuses MIN_DELTA_PCT rather than introducing a second threshold system, so
 * "materially higher than normal" means the same thing everywhere.
 */
const FIXED_CHARGE_MIN_PCT = MIN_DELTA_PCT;

/**
 * Daily rows read when a fixed charge needs a baseline.
 *
 * A monthly charge appears roughly once in thirty days, so the nine rows the
 * usage rules need would almost never contain a prior occurrence and the
 * amount check could effectively never fire. The rows already exist — the sync
 * stores 90 days. Regular services keep reading exactly BASELINE_DAYS of
 * history regardless; see the slice below.
 */
const FIXED_CHARGE_LOOKBACK_DAYS = 95;

export type Severity = 'critical' | 'serious' | 'warning';

export interface Anomaly {
  /**
   * 'fixed' when this is a billing-event charge judged on its amount against
   * previous occurrences, rather than a usage rate judged against a daily
   * average. Only affects how the anomaly is worded and whether it may lead
   * the digest; the money is identical either way.
   */
  chargeKind?: 'fixed';
  /**
   * True when this was spotted partway through the day it names, rather than
   * after that day closed.
   *
   * Only the wording depends on it — "already today" rather than a figure for
   * a finished day — but that distinction matters to the reader: the number
   * they are being shown is still climbing.
   */
  partialDay?: true;
  dedupeKey: string;
  accountId: string;
  accountName: string;
  provider: string;
  service: string;
  severity: Severity;
  /** Yesterday's spend for this service. */
  current: number;
  /** Mean daily spend over the preceding complete days. */
  baseline: number;
  deltaPerDay: number;
  deltaPct: number | null;
  /**
   * Extra spend for the rest of this month if the excess continues — or null
   * when projecting would be a guess rather than a forecast.
   *
   * Null for a service that appeared out of nothing. One day of charges on a
   * service with no history is at least as likely to be a one-off as a new
   * daily rate: annual domain renewals, support fees, reserved-instance
   * purchases and tax all arrive exactly this way. Multiplying that single
   * charge by the days left in the month produced figures that were wrong by
   * an order of magnitude — Amazon Registrar billed $46 once and was reported
   * as $414 — so nothing is projected until there is a rate to project from.
   *
   * The charge itself is never in doubt; it is `current`, and that is what
   * gets shown.
   */
  impact: number | null;
  isNew: boolean;
  /**
   * The project this spike came from, where one clearly did.
   *
   * Only for providers with a project dimension (OpenAI), and only when one
   * project carried at least half the service's spend that day. Below that
   * there is no honest single answer, and naming the largest of several
   * would send someone to the wrong team. Absent means "not attributable",
   * never "no project".
   */
  project?: { label: string; share: number };
  dayKey: string;
  /** Recent daily values, oldest first, for the sparkline. */
  spark: number[];
}

/**
 * Finds services whose most recent complete day is materially above their own
 * recent normal.
 *
 * Deliberately simple and explainable: a mean of the preceding days, a
 * percentage, and two floors. Every alert it raises can be justified to a
 * customer in one sentence, which matters more at this stage than sensitivity —
 * an anomaly detector nobody trusts gets muted, and then it may as well not
 * exist.
 *
 * "Normal" is a mean of complete days only. Today is always partial, so
 * including it would drag every baseline down and manufacture spikes.
 */
/** A project must carry at least this share of a service's day to be named. */
export const PROJECT_ATTRIBUTION_MIN_SHARE = 0.5;

/**
 * Which project, if any, a service's spend on one day belongs to.
 *
 * Reads the day's stored project split rather than asking the provider
 * again: detection runs against what the sweep already wrote, and an extra
 * live call per anomaly would be a second way for the provider to be
 * unreachable at the moment it matters.
 *
 * Returns nothing rather than a guess when no project dominates. The
 * threshold is what stops "the biggest of five roughly equal projects"
 * being reported as though it were the cause.
 */
export function dominantProject(
  breakdown: Record<string, Array<{ label: string; spend: number }>> | undefined,
  service: string,
): { label: string; share: number } | undefined {
  const rows = breakdown?.[service];
  if (!rows || rows.length === 0) return undefined;
  const total = rows.reduce((s, r) => s + (r.spend || 0), 0);
  if (total <= 0) return undefined;
  const top = rows.reduce((a, b) => ((b.spend || 0) > (a.spend || 0) ? b : a));
  const share = (top.spend || 0) / total;
  return share >= PROJECT_ATTRIBUTION_MIN_SHARE ? { label: top.label, share } : undefined;
}

export async function detectAnomalies(account: {
  accountId: string;
  name: string;
  provider: string;
}): Promise<Anomaly[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${account.accountId}`, ':sk': 'DAILY#' },
    ScanIndexForward: false,
    // Widened for fixed charges only. `history` below is still sliced to
    // BASELINE_DAYS, so every usage-based service is judged against exactly
    // the window it was before.
    Limit: FIXED_CHARGE_LOOKBACK_DAYS,
  }));

  const todayKey = new Date().toISOString().slice(0, 10);
  // Newest first from the query; drop today, then the first entry is the most
  // recent complete day and the rest are its history.
  const complete = (Items ?? []).filter((d) => (d.dayKey as string) < todayKey);
  if (complete.length < 3) return [];

  const [latest, ...fullHistory] = complete;
  const dayKey = latest.dayKey as string;
  if (fullHistory.length === 0) return [];

  // Unchanged window for usage-based services: the wider query above must not
  // alter a single existing baseline.
  const history = fullHistory.slice(0, BASELINE_DAYS);

  const baselineTotals = new Map<string, number[]>();
  history.forEach((d) => {
    (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      const arr = baselineTotals.get(s.name) ?? [];
      arr.push(s.spend);
      baselineTotals.set(s.name, arr);
    });
  });

  const daysLeftInMonth = daysRemainingInMonth(dayKey);
  const out: Anomaly[] = [];

  (latest.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
    const samples = baselineTotals.get(s.name) ?? [];
    // A service present on every historical day but absent from one is a
    // genuine zero, not missing data, so pad rather than skewing the mean.
    while (samples.length < history.length) samples.push(0);

    const baseline = samples.length
      ? samples.reduce((a, b) => a + b, 0) / samples.length
      : 0;
    // Fixed charges take their own path: judged on amount against previous
    // occurrences, never on "yesterday was $0 and today is not". Everything
    // below this block is the untouched usage-based logic.
    if (FIXED_CHARGE_SERVICES.has(s.name)) {
      const occurrence = fixedChargeAnomaly(s, fullHistory, account, dayKey, complete);
      if (occurrence) out.push(occurrence);
      return;
    }

    const deltaPerDay = s.spend - baseline;
    if (deltaPerDay <= 0) return;

    const deltaPct = baseline > 0 ? (deltaPerDay / baseline) * 100 : null;

    // MIN_DELTA_PER_DAY alone decided whether an account could EVER alert,
    // which structurally shut out anything priced in cents-per-day: a
    // WhatsApp or GCP account could 100x overnight and still never clear a
    // floor sized for AWS-scale spend — in practice, only one account (an
    // AWS one) had ever alerted across a tenant with a dozen connected
    // accounts. An account with a real baseline now also qualifies on the
    // size of its OWN move — its own percentage — gated by
    // MIN_DELTA_FOR_PCT_PATH so a fractional-cent wobble can't pass just
    // because it's a big percentage of almost nothing. A brand-new service
    // (baseline 0) has no percentage to compute, so it is still judged on
    // the dollar floor alone, exactly as before.
    const materialEnough = deltaPerDay >= MIN_DELTA_PER_DAY
      || (deltaPct !== null && deltaPct >= MIN_DELTA_PCT && deltaPerDay >= MIN_DELTA_FOR_PCT_PATH);
    if (!materialEnough) return;

    // Past that floor, a low-percentage move on a big account is still
    // routine growth unless the dollar amount is large enough to matter.
    if (deltaPct !== null
      && deltaPct < MIN_DELTA_PCT
      && deltaPerDay < ALWAYS_ALERT_DELTA_PER_DAY) return;

    out.push({
      dedupeKey: `${account.accountId}#${s.name}`,
      accountId: account.accountId,
      accountName: account.name,
      provider: account.provider,
      service: s.name,
      severity: severityFor(deltaPerDay, deltaPct),
      current: s.spend,
      baseline,
      deltaPerDay,
      deltaPct,
      impact: baseline === 0 ? null : deltaPerDay * daysLeftInMonth,
      isNew: baseline === 0,
      dayKey,
      // Spread rather than assigned, so an anomaly with nothing to attribute
      // carries no `project` key at all — the same absence downstream readers
      // already handle for providers that have no projects.
      ...(() => {
        const project = dominantProject(
          latest.projectBreakdown as Record<string, Array<{ label: string; spend: number }>> | undefined,
          s.name,
        );
        return project ? { project } : {};
      })(),
      spark: complete
        .slice(0, BASELINE_DAYS)
        .reverse()
        .map((d) => (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
          ?.find((x) => x.name === s.name)?.spend ?? 0),
    });
  });

  /*
   * Today, so far — for large moves only.
   *
   * Everything above judges the most recent *complete* day, which is why a
   * spike can sit unreported for the better part of two days: the day it
   * happens is not eligible until it ends.
   *
   * A partial day is only safe to judge in one direction. Its figures are
   * floors — the day is still running, so every service is understated — and
   * that makes a shortfall meaningless but an exceedance certain. A service
   * already $50 above its normal daily spend at noon will not drop below it
   * by midnight.
   *
   * Services already reported above are skipped. The dedupe key is the same
   * either way, so tomorrow's complete-day pass will find this service again
   * and update the alert in place rather than notifying anyone twice.
   */
  const todayRow = PARTIAL_DAY_PROVIDERS.has(account.provider)
    ? (Items ?? []).find((d) => (d.dayKey as string) === todayKey)
    : undefined;
  if (todayRow) {
    // The baseline here includes `latest`, which is a complete day and the
    // best evidence of what normal looks like going into today.
    const recent = complete.slice(0, BASELINE_DAYS);
    const alreadyReported = new Set(out.map((a) => a.service));

    (todayRow.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.forEach((s) => {
      if (alreadyReported.has(s.name)) return;
      // Fixed charges are judged on the amount of the charge itself, against
      // previous occurrences — a path that needs the day's final figure.
      if (FIXED_CHARGE_SERVICES.has(s.name)) return;

      const samples = recent.map((d) => (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
        ?.find((x) => x.name === s.name)?.spend ?? 0);
      const baseline = samples.length
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : 0;

      const deltaPerDay = s.spend - baseline;
      if (deltaPerDay < PARTIAL_DAY_MIN_DELTA) return;

      const deltaPct = baseline > 0 ? (deltaPerDay / baseline) * 100 : null;
      out.push({
        partialDay: true,
        dedupeKey: `${account.accountId}#${s.name}`,
        accountId: account.accountId,
        accountName: account.name,
        provider: account.provider,
        service: s.name,
        severity: severityFor(deltaPerDay, deltaPct),
        current: s.spend,
        baseline,
        deltaPerDay,
        deltaPct,
        // Projected from a part-day excess, so this understates rather than
        // invents — the same direction the rest of this path errs in. Null
        // for a service with no history, exactly as above: one day of charges
        // on something new is as likely to be a one-off as a new daily rate.
        impact: baseline === 0 ? null : deltaPerDay * daysRemainingInMonth(todayKey),
        isNew: baseline === 0,
        dayKey: todayKey,
        ...(() => {
          const project = dominantProject(
            todayRow.projectBreakdown as Record<string, Array<{ label: string; spend: number }>> | undefined,
            s.name,
          );
          return project ? { project } : {};
        })(),
        spark: [...recent].reverse()
          .map((d) => (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
            ?.find((x) => x.name === s.name)?.spend ?? 0)
          .concat(s.spend),
      });
    });
  }

  // Biggest money first: when several services move at once, the one that
  // costs most is the one to look at.
  return out.sort((a, b) => b.deltaPerDay - a.deltaPerDay);
}

/**
 * Severity blends both axes on purpose. A 500% jump on a $4/day service is not
 * critical, and a 60% jump on a $900/day service certainly is — grading on
 * either measure alone gets one of those wrong.
 */
/**
 * A fixed charge is anomalous only when the amount itself is out of character.
 *
 * The baseline is the mean of previous *non-zero* occurrences: the $0 days
 * between billing events are the normal state of a periodic charge, and
 * averaging them in would drag the expected amount toward zero and make every
 * renewal look like a spike — the exact false alarm this exists to stop.
 */
function fixedChargeAnomaly(
  s: ServiceBreakdownItem,
  fullHistory: Array<Record<string, unknown>>,
  account: { accountId: string; name: string; provider: string },
  dayKey: string,
  complete: Array<Record<string, unknown>>,
): Anomaly | null {
  if (s.spend <= 0) return null;

  const priorAmounts: number[] = [];
  fullHistory.forEach((d) => {
    const hit = (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
      ?.find((x) => x.name === s.name);
    if (hit && hit.spend > 0) priorAmounts.push(hit.spend);
  });

  // Not enough history to say what normal costs. The charge still counts in
  // every total; it simply isn't judged yet, and builds history for next time.
  if (priorAmounts.length < FIXED_CHARGE_MIN_HISTORY) return null;

  const baseline = priorAmounts.reduce((a, b) => a + b, 0) / priorAmounts.length;
  const deltaPerDay = s.spend - baseline;
  if (deltaPerDay <= 0) return null;

  const deltaPct = baseline > 0 ? (deltaPerDay / baseline) * 100 : null;
  if (deltaPct === null || deltaPct < FIXED_CHARGE_MIN_PCT) return null;
  // Same dollar floor the percentage path uses elsewhere, so a trivial move on
  // a tiny charge can't qualify on percentage alone.
  if (deltaPerDay < MIN_DELTA_FOR_PCT_PATH) return null;

  return {
    chargeKind: 'fixed',
    dedupeKey: `${account.accountId}#${s.name}`,
    accountId: account.accountId,
    accountName: account.name,
    provider: account.provider,
    service: s.name,
    severity: severityFor(deltaPerDay, deltaPct),
    current: s.spend,
    baseline,
    deltaPerDay,
    deltaPct,
    // Never projected. A periodic charge does not recur daily, so multiplying
    // it by the days left in the month is the $46 -> $414 mistake the usage
    // path already learned to avoid.
    impact: null,
    isNew: false,
    dayKey,
    spark: complete
      .slice(0, BASELINE_DAYS)
      .reverse()
      .map((d) => (d.serviceBreakdown as ServiceBreakdownItem[] | undefined)
        ?.find((x) => x.name === s.name)?.spend ?? 0),
  };
}

function severityFor(deltaPerDay: number, deltaPct: number | null): Severity {
  if (deltaPerDay >= 100 || (deltaPct !== null && deltaPct >= 200 && deltaPerDay >= 20)) {
    return 'critical';
  }
  // The >=100% clause needs its own small dollar floor now that percentage
  // alone can qualify an anomaly at all — otherwise a cents-per-day account
  // that just cleared MIN_DELTA_FOR_PCT_PATH would be labelled "serious"
  // from the percentage alone, out of proportion to the money involved.
  if (deltaPerDay >= 25 || (deltaPct !== null && deltaPct >= 100 && deltaPerDay >= MIN_DELTA_FOR_PCT_PATH)) {
    return 'serious';
  }
  return 'warning';
}

/** Days left in the month containing `dayKey`, counting that day itself. */
function daysRemainingInMonth(dayKey: string): number {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.max(1, lastDay - d.getUTCDate() + 1);
}

export function anomalyTitle(a: Anomaly): string {
  if (a.chargeKind === 'fixed') return `Charge higher than usual — ${a.service}`;
  // Said in the title because it changes what the reader should do: this one
  // is still running, so the figure below it is a floor, not a total.
  if (a.partialDay) return `Spiking now — ${a.service}`;
  return a.isNew ? `New spend — ${a.service}` : `Cost spike — ${a.service}`;
}

/**
 * "…on the Rehearse RevenueCat project, which carried 99% of it." — or
 * nothing, when no project dominated. Appended to the root cause because
 * that is the sentence someone reads to decide who to ask.
 */
export function projectClause(a: Anomaly): string {
  if (!a.project) return '';
  const pct = Math.round(a.project.share * 100);
  return pct >= 99
    ? ` All of it was on the ${a.project.label} project.`
    : ` Most of it — ${pct}% — was on the ${a.project.label} project.`;
}

export function anomalyRootCause(a: Anomaly): string {
  // Deliberately not phrased as a usage increase: this charge is not expected
  // daily, so "up 150%" would imply a rate change that did not happen.
  if (a.chargeKind === 'fixed') {
    return `${a.service} on ${a.accountName} is a periodic charge, billed on an event rather than `
      + `daily usage. It came to ${fmt(a.current)} on ${a.dayKey}, against ${fmt(a.baseline)} for its `
      + `previous occurrences — the timing is normal, the amount is not.`;
  }
  // Partway through the day it names, so every figure here is still climbing.
  // Worded as "already" rather than a finished total, because quoting a
  // part-day figure as the day's cost would understate it by however many
  // hours are left.
  if (a.partialDay) {
    const against = a.baseline > 0
      ? `against a ${fmt(a.baseline)}/day average over the preceding week`
      : 'and it had no spend at all in the preceding week';
    return `${a.service} on ${a.accountName} has already cost ${fmt(a.current)} today, ${against}. `
      + `The day is not over, so this figure is still rising.`
      + projectClause(a);
  }
  if (a.isNew) {
    return `${a.service} started costing money on ${a.accountName} — it had no spend in the preceding week. `
      + `Something was switched on, or usage moved into a service that wasn't being used before.`
      + projectClause(a);
  }
  return `${a.service} on ${a.accountName} cost ${fmt(a.current)} on ${a.dayKey}, against a `
    + `${fmt(a.baseline)}/day average over the preceding week — ${Math.round(a.deltaPct ?? 0)}% above normal.`
    + projectClause(a);
}

export function anomalyAction(a: Anomaly): string {
  if (a.chargeKind === 'fixed') {
    return `Check the ${a.service} line on ${a.accountName}'s bill for ${a.dayKey} — a renewal at a new `
      + `rate, extra domains, or a tax-rate change would each explain it.`;
  }
  if (a.isNew) {
    return `Confirm the new ${a.service} usage on ${a.accountName} is intended, and tag it so it lands in the right cost centre.`;
  }
  return `Check what changed on ${a.accountName} around ${a.dayKey} — a deployment, a traffic increase, `
    + `or a resource left running. Left alone this adds about ${fmt(a.impact ?? 0)} to this month's bill.`;
}

/**
 * How to describe the money, in one sentence, whichever kind of anomaly it is.
 *
 * A projected anomaly has a rate and can be extrapolated. A brand-new service
 * has a charge and nothing to extrapolate from, so it is reported as what it
 * is — a charge — rather than dressed up as a forecast.
 */
export function impactPhrase(a: Anomaly): string {
  if (a.chargeKind === 'fixed') {
    return `${fmt(a.current)} charged on ${a.dayKey}, against ${fmt(a.baseline)} normally. `
      + `No monthly projection — this charge is periodic, not daily.`;
  }
  if (a.impact === null) {
    return `${fmt(a.current)} charged on ${a.dayKey}. No monthly projection — `
      + `this service has no prior spend to project a rate from.`;
  }
  return `Estimated impact if it continues: ${fmt(a.impact)} this month.`;
}

/** The single figure worth leading with: the projection when there is one. */
export function headlineAmount(a: Anomaly): number {
  return a.impact === null ? a.current : a.impact;
}

function fmt(n: number): string {
  return `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
}
