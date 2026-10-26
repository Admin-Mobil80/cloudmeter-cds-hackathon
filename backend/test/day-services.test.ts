/**
 * What a single day was spent on.
 *
 * The daily rows have carried `serviceBreakdown` since daily ingestion was
 * written, and every reader collapsed it: the chart drew the day's total, the
 * service list summed the whole window. So "what caused the spike on the 5th?"
 * was answerable from the stored data and not from the product — on AL STARK
 * the answer was DynamoDB at $297.78 of a $317.19 day, sitting in the table
 * the whole time.
 *
 * Two things here are easy to get wrong. Folding the tail into "Other" must
 * not lose money, or a reader is quietly shown less than the day cost. And the
 * shares must be of the day, not of whatever total the provider reported, or
 * they stop adding up the moment anything is folded.
 */

import { dayServices, TOP_SERVICES_PER_DAY, OTHER_LABEL } from '../functions/shared/day-services';
import type { ServiceBreakdownItem } from '../functions/shared/providers';

const item = (name: string, spend: number, trend?: number): ServiceBreakdownItem =>
  ({ name, spend, pct: 0, ...(trend === undefined ? {} : { trend }) } as ServiceBreakdownItem);

/** AL STARK, 5 October 2026 — the day the DynamoDB spike happened. */
const OCT_5: ServiceBreakdownItem[] = [
  item('Amazon DynamoDB', 297.7782113544, 10704),
  item('Amazon Elastic Compute Cloud - Compute', 11.4738914019, -30),
  item('Amazon Simple Storage Service', 4.7979799891, 15),
  item('Amazon OpenSearch Service', 1.9550511806, 0),
  item('EC2 - Other', 0.5920497399, 0),
  item('Amazon Virtual Private Cloud', 0.48, 0),
  item('AWS Cost Explorer', 0.08, 0),
  item('Amazon API Gateway', 0.034209, 0),
  item('AWS Lambda', 0.0000018246, 0),
];
const OCT_5_TOTAL = 317.19;

describe('a real day', () => {
  it('names the service behind the spike, largest first', () => {
    const out = dayServices(OCT_5, OCT_5_TOTAL);
    expect(out[0].name).toBe('Amazon DynamoDB');
    expect(out[0].spend).toBeCloseTo(297.78, 2);
    expect(out[0].pct).toBeCloseTo(93.88, 1);
    expect(out[0].trend).toBe(10704);
  });

  it('sorts by spend, whatever order the provider stored them in', () => {
    /*
     * The point of the whole feature is that the thing which caused the day
     * is at the top. Providers do not promise an order, and a stored row
     * written in alphabetical or API order would otherwise bury a $297 spike
     * below a $0.48 line.
     */
    const shuffled = [item('tiny', 0.48), item('huge', 297.78), item('middling', 11.47)];
    const out = dayServices(shuffled, 309.73);
    expect(out.map((x) => x.name)).toEqual(['huge', 'middling', 'tiny']);
  });

  it('folds the smallest into Other, not the largest', () => {
    // A fold that kept the wrong end would hide the spike inside "Other".
    const shuffled = [item('a', 1), item('b', 100), item('c', 2), item('d', 3)];
    const out = dayServices(shuffled, 106, 2);
    expect(out.map((x) => x.name)).toEqual(['b', 'd', OTHER_LABEL]);
    expect(out[2].spend).toBeCloseTo(3, 6);
  });

  it('keeps the shares as a share of that day', () => {
    const out = dayServices(OCT_5, OCT_5_TOTAL);
    const summed = out.reduce((s, x) => s + x.pct, 0);
    expect(summed).toBeCloseTo(100, 1);
  });

  it('folds the tail once there are more services than fit', () => {
    // Nine services, eight shown: the ninth becomes Other rather than vanishing.
    const out = dayServices(OCT_5, OCT_5_TOTAL);
    expect(out).toHaveLength(TOP_SERVICES_PER_DAY + 1);
    expect(out[out.length - 1].name).toBe(OTHER_LABEL);
  });
});

describe('folding the tail', () => {
  const many = Array.from({ length: 20 }, (_, i) => item(`svc-${i}`, 20 - i));
  const total = many.reduce((s, x) => s + x.spend, 0);

  it('loses nothing — the parts still add to the day', () => {
    /*
     * The failure this guards against is silent: a breakdown that drops its
     * tail shows a reader less than the day cost, and nothing on screen says
     * so. Rounding aside, these must reconcile.
     */
    const out = dayServices(many, total);
    const summed = out.reduce((s, x) => s + x.spend, 0);
    expect(summed).toBeCloseTo(total, 6);
  });

  it('shows exactly the limit plus one Other line', () => {
    const out = dayServices(many, total);
    expect(out).toHaveLength(TOP_SERVICES_PER_DAY + 1);
    expect(out.filter((x) => x.name === OTHER_LABEL)).toHaveLength(1);
  });

  it('gives Other no trend, because an averaged one would be meaningless', () => {
    // A single percentage across a dozen unrelated services says nothing, and
    // a reader would take it for a fact about something.
    const out = dayServices(many, total);
    expect(out[out.length - 1].trend).toBeNull();
  });

  it('does not add an Other line when everything already fits', () => {
    const few = [item('a', 3), item('b', 1)];
    const out = dayServices(few, 4);
    expect(out.map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('does not add one when the count exactly equals the limit', () => {
    const exact = Array.from({ length: TOP_SERVICES_PER_DAY }, (_, i) => item(`s${i}`, 1));
    const out = dayServices(exact, TOP_SERVICES_PER_DAY);
    expect(out).toHaveLength(TOP_SERVICES_PER_DAY);
    expect(out.some((x) => x.name === OTHER_LABEL)).toBe(false);
  });
});

describe('days that are not ordinary', () => {
  it('returns nothing for a day with no breakdown stored', () => {
    // Accounts connected before daily ingestion, and providers that report a
    // total without services. The caller shows a total and no detail.
    expect(dayServices(undefined, 10)).toEqual([]);
    expect(dayServices([], 10)).toEqual([]);
  });

  it('survives a zero-spend day without dividing by it', () => {
    const out = dayServices([item('a', 0), item('b', 0)], 0);
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.pct === 0)).toBe(true);
  });

  it('ignores entries with no usable figure', () => {
    // A malformed row should cost its own line, not the whole breakdown.
    const out = dayServices(
      [item('good', 5), { name: 'bad' } as ServiceBreakdownItem, item('also good', 1)],
      6,
    );
    expect(out.map((x) => x.name)).toEqual(['good', 'also good']);
  });

  it('reports no trend where the provider supplied none', () => {
    // Azure and GCP breakdowns have no trend field; null says "not known"
    // rather than implying a flat zero.
    const out = dayServices([item('a', 5)], 5);
    expect(out[0].trend).toBeNull();
  });

  it('keeps a trend of zero as zero, not as unknown', () => {
    const out = dayServices([item('a', 5, 0)], 5);
    expect(out[0].trend).toBe(0);
  });
});
