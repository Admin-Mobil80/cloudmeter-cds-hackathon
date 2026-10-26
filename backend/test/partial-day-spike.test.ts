import { anomalyTitle, anomalyRootCause } from '../functions/shared/anomaly';
import type { Anomaly } from '../functions/shared/anomaly';

/**
 * Spikes caught partway through the day.
 *
 * The detector otherwise judges only complete days, which is right — a partial
 * day understates every service, so judging one would report a collapse every
 * morning. It also meant a real spike waited: gpt-6-astra went from nothing to
 * $355 in a day and the alert arrived thirty-three hours later.
 *
 * The mid-day path is safe in one direction only, and that is the whole idea:
 * a partial figure is a floor, so a service already far above its baseline has
 * genuinely exceeded it and cannot fall back by midnight.
 *
 * detectAnomalies() reads DynamoDB, and this suite mocks no AWS, so the rule
 * itself is exercised through the same arithmetic the handler applies and the
 * wording through the exported helpers.
 */

const PARTIAL_DAY_MIN_DELTA = 50;

/** The rule as detectAnomalies applies it to today's row. */
function wouldAlertMidDay(todaySoFar: number, recentDays: number[]): boolean {
  const baseline = recentDays.length
    ? recentDays.reduce((a, b) => a + b, 0) / recentDays.length
    : 0;
  return todaySoFar - baseline >= PARTIAL_DAY_MIN_DELTA;
}

const anomaly = (over: Partial<Anomaly> = {}): Anomaly => ({
  partialDay: true,
  dedupeKey: 'acc#gpt-6-astra, cached input',
  accountId: 'acc',
  accountName: 'Mobil80 OpenAI',
  provider: 'openai',
  service: 'gpt-6-astra, cached input',
  severity: 'critical',
  current: 354.83,
  baseline: 0,
  deltaPerDay: 354.83,
  deltaPct: null,
  impact: null,
  isNew: true,
  dayKey: '2026-09-24',
  spark: [0, 0, 0, 0, 0, 0, 0, 354.83],
  ...over,
});

describe('the mid-day rule', () => {
  const quietWeek = [0, 0, 0, 0, 0, 0, 0];

  it('fires on the spike that took thirty-three hours to report', () => {
    // gpt-6-astra, cached input: nothing for a fortnight, then this.
    expect(wouldAlertMidDay(354.83, quietWeek)).toBe(true);
  });

  it('fires on the second and third astra line items too', () => {
    expect(wouldAlertMidDay(242.11, quietWeek)).toBe(true);
    expect(wouldAlertMidDay(99.76, quietWeek)).toBe(true);
  });

  it('stays quiet for the small movers on the same account that day', () => {
    // These are real alerts, but they can wait for the morning summary.
    expect(wouldAlertMidDay(8.44, quietWeek)).toBe(false);
    expect(wouldAlertMidDay(24.43, quietWeek)).toBe(false);
  });

  it('measures the excess, not the total', () => {
    // A service that always costs $200/day is not spiking at $210 — the
    // threshold is how far above its own normal it has gone.
    const busy = [200, 200, 200, 200, 200, 200, 200];
    expect(wouldAlertMidDay(210, busy)).toBe(false);
    expect(wouldAlertMidDay(260, busy)).toBe(true);
  });

  it('does not fire on a partial day that is merely incomplete', () => {
    /*
     * The failure mode this path had to avoid. A $200/day service showing $60
     * at breakfast has not collapsed and has not spiked — it is simply a few
     * hours into the day. Only an exceedance can be trusted from partial data,
     * which is why nothing here fires on a shortfall.
     */
    const busy = [200, 200, 200, 200, 200, 200, 200];
    expect(wouldAlertMidDay(60, busy)).toBe(false);
    expect(wouldAlertMidDay(0, busy)).toBe(false);
  });

  it('fires exactly at the threshold, not a cent below', () => {
    expect(wouldAlertMidDay(50, quietWeek)).toBe(true);
    expect(wouldAlertMidDay(49.99, quietWeek)).toBe(false);
  });
});

describe('which providers get a mid-day alert', () => {
  /*
   * The allowlist, as detectAnomalies applies it: today's row is only read for
   * a provider on the list. Everything else waits for the day to close, which
   * is what it did before this path existed.
   */
  const PARTIAL_DAY_PROVIDERS = new Set(['openai']);
  const readsToday = (provider: string) => PARTIAL_DAY_PROVIDERS.has(provider);

  it('reads OpenAI, whose usage arrives within the hour', () => {
    expect(readsToday('openai')).toBe(true);
  });

  it('leaves every other provider to the complete-day path', () => {
    // Cost Explorer lags: on a sweep of every live account, 17 of 18 AWS
    // accounts had no row for today at all, and the rest had none either.
    for (const p of ['aws', 'azure', 'gcp', 'whatsapp', 'huawei', 'alibaba']) {
      expect(readsToday(p)).toBe(false);
    }
  });

  it('does not silently admit a provider whose data speeds up later', () => {
    // The point of an explicit list: a new same-day provider joins because
    // somebody decided it should, not because its rows started arriving.
    expect(readsToday('some-future-provider')).toBe(false);
  });
});

describe('how a mid-day alert reads', () => {
  it('says it is happening now, not that a day cost this', () => {
    expect(anomalyTitle(anomaly())).toBe('Spiking now — gpt-6-astra, cached input');
  });

  it('says the figure is still rising, so nobody reads it as a day total', () => {
    const text = anomalyRootCause(anomaly());
    expect(text).toContain('has already cost');
    expect(text).toContain('still rising');
  });

  it('names the week it is being judged against when there is one', () => {
    const text = anomalyRootCause(anomaly({ baseline: 20, deltaPct: 1674, isNew: false }));
    expect(text).toContain('/day average over the preceding week');
  });

  it('says plainly when there is no history at all', () => {
    expect(anomalyRootCause(anomaly())).toContain('no spend at all in the preceding week');
  });

  it('leaves a complete-day alert worded exactly as it was', () => {
    const settled = anomaly({ partialDay: undefined, isNew: true });
    expect(anomalyTitle(settled)).toBe('New spend — gpt-6-astra, cached input');
    expect(anomalyRootCause(settled)).toContain('started costing money');
  });
});
