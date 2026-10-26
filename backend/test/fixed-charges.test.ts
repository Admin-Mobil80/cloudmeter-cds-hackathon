import { FIXED_CHARGE_SERVICES, anomalyRootCause, anomalyTitle, type Anomaly } from '../functions/shared/anomaly';

/**
 * Fixed/periodic charges — Tax, domain registration — arrive on a billing
 * event, not through daily usage. The usage rules read that as a week of $0
 * followed by a jump; these tests pin the separate treatment.
 *
 * The detection loop is mirrored here rather than driving DynamoDB, in the same
 * style as digest-math: the point is to hold the *rules* steady.
 */

interface Svc { name: string; spend: number }
interface Day { dayKey: string; serviceBreakdown: Svc[] }

const BASELINE_DAYS = 7;
const MIN_DELTA_PER_DAY = 3;
const MIN_DELTA_PCT = 40;
const MIN_DELTA_FOR_PCT_PATH = 0.20;
const FIXED_MIN_HISTORY = 2;

/** Mirrors detectAnomalies: fixed charges branch, everything else unchanged. */
function detect(days: Day[]): Array<{ service: string; kind: 'fixed' | 'usage'; current: number; baseline: number }> {
  const [latest, ...fullHistory] = days;
  const history = fullHistory.slice(0, BASELINE_DAYS);
  const out: Array<{ service: string; kind: 'fixed' | 'usage'; current: number; baseline: number }> = [];

  for (const s of latest.serviceBreakdown) {
    if (FIXED_CHARGE_SERVICES.has(s.name)) {
      if (s.spend <= 0) continue;
      const prior = fullHistory
        .map((d) => d.serviceBreakdown.find((x) => x.name === s.name)?.spend ?? 0)
        .filter((v) => v > 0);
      if (prior.length < FIXED_MIN_HISTORY) continue;
      const baseline = prior.reduce((a, b) => a + b, 0) / prior.length;
      const delta = s.spend - baseline;
      if (delta <= 0) continue;
      const pct = (delta / baseline) * 100;
      if (pct < MIN_DELTA_PCT || delta < MIN_DELTA_FOR_PCT_PATH) continue;
      out.push({ service: s.name, kind: 'fixed', current: s.spend, baseline });
      continue;
    }

    const samples = history.map((d) => d.serviceBreakdown.find((x) => x.name === s.name)?.spend ?? 0);
    const baseline = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    const delta = s.spend - baseline;
    if (delta <= 0) continue;
    const pct = baseline > 0 ? (delta / baseline) * 100 : null;
    const material = delta >= MIN_DELTA_PER_DAY
      || (pct !== null && pct >= MIN_DELTA_PCT && delta >= MIN_DELTA_FOR_PCT_PATH);
    if (!material) continue;
    if (pct !== null && pct < MIN_DELTA_PCT && delta < 50) continue;
    out.push({ service: s.name, kind: 'usage', current: s.spend, baseline });
  }
  return out;
}

/** `n` days ending at `end`, each carrying the given services. */
function days(end: string, n: number, build: (i: number) => Svc[]): Day[] {
  const out: Day[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ dayKey: d.toISOString().slice(0, 10), serviceBreakdown: build(i) });
  }
  return out;                                   // newest first, as queried
}

const ec2 = (v: number): Svc => ({ name: 'Amazon Elastic Compute Cloud - Compute', spend: v });

describe('the fixed-charge list', () => {
  it('covers tax and domain registration', () => {
    expect(FIXED_CHARGE_SERVICES.has('Tax')).toBe(true);
    expect(FIXED_CHARGE_SERVICES.has('Amazon Registrar')).toBe(true);
  });

  it('excludes Route 53, which bills hosted zones daily', () => {
    // Listing it would suppress genuine hosted-zone spikes.
    expect(FIXED_CHARGE_SERVICES.has('Amazon Route 53')).toBe(false);
  });
});

describe('a fixed charge appearing after $0 days', () => {
  it('does not alert on appearance alone', () => {
    // Six $0 days then $12 — the false spike this feature exists to stop.
    const d = days('2026-08-20', 9, (i) => (i === 0 ? [{ name: 'Amazon Registrar', spend: 12 }, ec2(10)] : [ec2(10)]));
    expect(detect(d)).toEqual([]);
  });

  it('stays silent at its normal amount', () => {
    const d = days('2026-08-20', 40, (i) =>
      i === 0 ? [{ name: 'Amazon Registrar', spend: 12 }, ec2(10)]
      : (i === 15 || i === 30) ? [{ name: 'Amazon Registrar', spend: 12 }, ec2(10)]
      : [ec2(10)]);
    expect(detect(d).filter((a) => a.service === 'Amazon Registrar')).toEqual([]);
  });

  it('alerts when the amount is materially above its own history', () => {
    const d = days('2026-08-20', 40, (i) =>
      i === 0 ? [{ name: 'Amazon Registrar', spend: 30 }, ec2(10)]
      : (i === 15 || i === 30) ? [{ name: 'Amazon Registrar', spend: 12 }, ec2(10)]
      : [ec2(10)]);
    const hit = detect(d).find((a) => a.service === 'Amazon Registrar');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('fixed');
    expect(hit!.baseline).toBeCloseTo(12, 2);
  });
});

describe('AWS Tax', () => {
  const withTax = (latest: number) => days('2026-08-20', 40, (i) =>
    i === 0 ? [{ name: 'Tax', spend: latest }, ec2(10)]
    : (i === 15 || i === 30) ? [{ name: 'Tax', spend: 10 }, ec2(10)]
    : [ec2(10)]);

  it('is quiet inside its normal range', () => {
    expect(detect(withTax(10)).filter((a) => a.service === 'Tax')).toEqual([]);
  });

  it('alerts when abnormally high', () => {
    const hit = detect(withTax(35)).find((a) => a.service === 'Tax');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('fixed');
  });
});

describe('insufficient history', () => {
  it('does not alert on a first-ever occurrence, however large', () => {
    const d = days('2026-08-20', 40, (i) =>
      i === 0 ? [{ name: 'Amazon Registrar', spend: 460 }, ec2(10)] : [ec2(10)]);
    expect(detect(d).filter((a) => a.service === 'Amazon Registrar')).toEqual([]);
  });

  it('still says nothing with only one prior occurrence', () => {
    const d = days('2026-08-20', 40, (i) =>
      i === 0 ? [{ name: 'Amazon Registrar', spend: 30 }, ec2(10)]
      : i === 20 ? [{ name: 'Amazon Registrar', spend: 12 }, ec2(10)]
      : [ec2(10)]);
    expect(detect(d).filter((a) => a.service === 'Amazon Registrar')).toEqual([]);
  });
});

describe('usage-based services are untouched', () => {
  it('still alerts on an EC2 spike', () => {
    const d = days('2026-08-20', 9, (i) => [ec2(i === 0 ? 60 : 10)]);
    const hit = detect(d).find((a) => a.service.startsWith('Amazon Elastic'));
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('usage');
  });

  it('still alerts on a brand-new Bedrock service', () => {
    const d = days('2026-08-20', 9, (i) =>
      i === 0 ? [{ name: 'Amazon Bedrock', spend: 25 }, ec2(10)] : [ec2(10)]);
    const hit = detect(d).find((a) => a.service === 'Amazon Bedrock');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('usage');
    expect(hit!.baseline).toBe(0);        // unchanged "new service" behaviour
  });

  it('stays quiet on flat usage', () => {
    expect(detect(days('2026-08-20', 9, () => [ec2(10)]))).toEqual([]);
  });
});

describe('fixed charges remain in the money', () => {
  // The feature changes interpretation only; totals must be untouched.
  const day = { dayKey: '2026-08-20', serviceBreakdown: [{ name: 'Tax', spend: 12 }, ec2(10)] };

  it('counts toward the daily total', () => {
    expect(day.serviceBreakdown.reduce((t, s) => t + s.spend, 0)).toBe(22);
  });

  it('counts toward month-to-date', () => {
    const month = [day, { dayKey: '2026-08-19', serviceBreakdown: [ec2(10)] }];
    const mtd = month.flatMap((d) => d.serviceBreakdown).reduce((t, s) => t + s.spend, 0);
    expect(mtd).toBe(32);
  });
});

describe('alert wording', () => {
  const fixed = {
    chargeKind: 'fixed', service: 'Amazon Registrar', accountName: 'Partner',
    current: 30, baseline: 12, dayKey: '2026-08-20', deltaPct: 150, isNew: false,
  } as unknown as Anomaly;

  it('describes a periodic charge, not a usage increase', () => {
    const text = anomalyRootCause(fixed);
    expect(text).toContain('periodic charge');
    expect(text).not.toMatch(/150%/);       // "up 150%" would be misleading
    expect(anomalyTitle(fixed)).toContain('higher than usual');
  });

  it('leaves usage wording alone', () => {
    const usage = {
      service: 'Amazon Bedrock', accountName: 'Mobil80', current: 25, baseline: 0,
      dayKey: '2026-08-20', deltaPct: null, isNew: true,
    } as unknown as Anomaly;
    expect(anomalyTitle(usage)).toBe('New spend — Amazon Bedrock');
  });
});
