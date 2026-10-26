import {
  dominantProject, projectClause, anomalyRootCause, PROJECT_ATTRIBUTION_MIN_SHARE, Anomaly,
} from '../functions/shared/anomaly';
import { whereOf } from '../functions/shared/alert-notify';

/**
 * Naming the wrong project sends someone to the wrong team, which is worse
 * than naming none. These pin where the line is.
 */

// The real day this was built for: gpt-image-1 on 21 Sep 2026, seven projects
// in the organisation, one of them responsible for 99.9% of the spike.
const SEP_21 = {
  'gpt-image-1 image, output': [
    { label: 'Rehearse RevenueCat', spend: 16.598 },
    { label: 'CallCentral RevenueCat', spend: 0.011 },
    { label: 'Twick RevenueCat', spend: 0.004 },
    { label: 'Speakworld RevenueCat', spend: 0.002 },
  ],
};

function anomaly(over: Partial<Anomaly> = {}): Anomaly {
  return {
    dedupeKey: 'a#s', accountId: 'a', accountName: 'Mobil80 OpenAI', provider: 'openai',
    service: 'gpt-image-1 image, output', severity: 'critical',
    current: 16.07, baseline: 0.02, deltaPerDay: 16.05, deltaPct: 89600,
    impact: 161, isNew: false, dayKey: '2026-09-21', spark: [],
    ...over,
  } as Anomaly;
}

describe('dominantProject', () => {
  it('names the project that carried the day', () => {
    const p = dominantProject(SEP_21, 'gpt-image-1 image, output');
    expect(p?.label).toBe('Rehearse RevenueCat');
    expect(p?.share).toBeGreaterThan(0.99);
  });

  it('names nothing when no project dominates', () => {
    // Three projects at a third each: the largest is not "the cause".
    const split = { svc: [{ label: 'A', spend: 34 }, { label: 'B', spend: 33 }, { label: 'C', spend: 33 }] };
    expect(dominantProject(split, 'svc')).toBeUndefined();
  });

  it('draws the line at half', () => {
    const half = { svc: [{ label: 'A', spend: 50 }, { label: 'B', spend: 50 }] };
    expect(dominantProject(half, 'svc')?.label).toBe('A');
    expect(PROJECT_ATTRIBUTION_MIN_SHARE).toBe(0.5);
    const under = { svc: [{ label: 'A', spend: 49 }, { label: 'B', spend: 51 }] };
    expect(dominantProject(under, 'svc')?.label).toBe('B');
  });

  it('names nothing for a service the split does not cover', () => {
    expect(dominantProject(SEP_21, 'gpt-4o text, input')).toBeUndefined();
  });

  it('names nothing when there is no split at all', () => {
    // A provider without projects, or a day whose project call failed.
    expect(dominantProject(undefined, 'svc')).toBeUndefined();
    expect(dominantProject({}, 'svc')).toBeUndefined();
    expect(dominantProject({ svc: [] }, 'svc')).toBeUndefined();
  });

  it('is not fooled by a zero-spend row', () => {
    expect(dominantProject({ svc: [{ label: 'A', spend: 0 }] }, 'svc')).toBeUndefined();
  });
});

describe('the wording', () => {
  it('says all of it when one project had practically everything', () => {
    const a = anomaly({ project: { label: 'Rehearse RevenueCat', share: 0.999 } });
    expect(projectClause(a)).toBe(' All of it was on the Rehearse RevenueCat project.');
    expect(anomalyRootCause(a)).toMatch(/89600% above normal\. All of it was on the Rehearse RevenueCat project\.$/);
  });

  it('gives the share when it was most but not all', () => {
    const a = anomaly({ project: { label: 'Luna', share: 0.72 } });
    expect(projectClause(a)).toBe(' Most of it — 72% — was on the Luna project.');
  });

  it('says nothing about projects when none was attributed', () => {
    // The sentence must read exactly as it did before projects existed —
    // no dangling "on the undefined project", no trailing clause.
    const a = anomaly();
    expect(projectClause(a)).toBe('');
    expect(anomalyRootCause(a)).toMatch(/above normal\.$/);
    expect(anomalyRootCause(a)).not.toMatch(/project/);
  });

  it('attributes a brand-new service too', () => {
    const a = anomaly({ isNew: true, baseline: 0, deltaPct: null, impact: null,
      project: { label: 'Expenze', share: 1 } });
    expect(anomalyRootCause(a)).toMatch(/All of it was on the Expenze project\.$/);
  });
});

describe('where the spike is named, across channels', () => {
  it('puts the project beside the account', () => {
    const a = anomaly({ project: { label: 'Rehearse RevenueCat', share: 0.999 } });
    expect(whereOf(a)).toBe('Mobil80 OpenAI · Rehearse RevenueCat');
  });

  it('is just the account when nothing was attributed', () => {
    expect(whereOf(anomaly())).toBe('Mobil80 OpenAI');
  });

  it('stays legal for a WhatsApp template parameter', () => {
    // Meta rejects a parameter containing a newline, a tab, or four or more
    // consecutive spaces. This string goes into a fixed template slot.
    const a = anomaly({ project: { label: 'Rehearse RevenueCat', share: 1 } });
    expect(whereOf(a)).not.toMatch(/[\n\t]/);
    expect(whereOf(a)).not.toMatch(/ {4,}/);
  });
});
