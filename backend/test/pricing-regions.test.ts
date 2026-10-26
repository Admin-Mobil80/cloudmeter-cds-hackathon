import {
  catalogForRegion, REGIONS, DEFAULT_REGION, REGIONAL_PRICES,
} from '../functions/shared/pricing-catalog';

/**
 * The table's whole value is that it compares like with like, so the region is
 * a property of the page rather than of a row. These pin the two ways that can
 * go wrong: a price shown under the wrong region's heading, and a provider
 * quietly compared on figures nobody recorded for that region.
 */
describe('regional pricing', () => {
  it('defaults to us-east-1, including for an unknown region', () => {
    expect(DEFAULT_REGION).toBe('us-east-1');
    expect(catalogForRegion(undefined).region.id).toBe('us-east-1');
    expect(catalogForRegion('mars-1').region.id).toBe('us-east-1');
  });

  it('offers both regions, pairing each provider with its own code for the place', () => {
    expect(REGIONS.map((r) => r.id)).toEqual(['us-east-1', 'ap-south-1']);
    const us = REGIONS[0];
    // Azure East US is in Northern Virginia, the same locale as us-east-1.
    expect(us.codes).toEqual({ aws: 'us-east-1', azure: 'eastus' });
  });

  it('prices every infrastructure workload in both regions', () => {
    for (const id of ['us-east-1', 'ap-south-1'] as const) {
      const infra = catalogForRegion(id).workloads.filter((w) => w.category !== 'ai');
      expect(infra).toHaveLength(7);
      for (const w of infra) for (const e of w.entries) expect(e.price).toBeGreaterThan(0);
    }
  });

  it('keeps every provider in the region the figures were recorded for', () => {
    // Google, Alibaba and Huawei have always been in this comparison. Their
    // figures were read for Mumbai, so in Mumbai they are exactly right and
    // must not be dropped just because there is no per-region table for them.
    const mum = catalogForRegion('ap-south-1');
    const infra = mum.workloads.filter((w) => w.category !== 'ai');
    for (const w of infra) {
      expect(w.entries.map((e) => e.provider).sort())
        .toEqual(['alibaba', 'aws', 'azure', 'gcp', 'huawei']);
    }
    expect(mum.omitted).toEqual([]);
    expect(mum.workloads.reduce((n, w) => n + w.entries.length, 0)).toBe(47);
  });

  it('shows only the providers it has region-specific figures for elsewhere', () => {
    const us = catalogForRegion('us-east-1');
    const infra = us.workloads.filter((w) => w.category !== 'ai');
    for (const w of infra) {
      expect(w.entries.map((e) => e.provider).sort()).toEqual(['aws', 'azure']);
    }
  });

  it('actually differs between regions where the providers differ', () => {
    const price = (r: string, id: string, p: string) => catalogForRegion(r)
      .workloads.find((w) => w.id === id)!.entries.find((e) => e.provider === p)!.price;
    // Mumbai is dearer than N. Virginia for compute, storage and egress.
    expect(price('ap-south-1', 'vm-general-4x16', 'aws')).toBeGreaterThan(price('us-east-1', 'vm-general-4x16', 'aws'));
    expect(price('ap-south-1', 'egress-internet', 'aws')).toBeGreaterThan(price('us-east-1', 'egress-internet', 'aws'));
    expect(price('ap-south-1', 'managed-postgres-2x8', 'azure')).toBeGreaterThan(price('us-east-1', 'managed-postgres-2x8', 'azure'));
  });

  it('carries LLM rows into every region with all their providers', () => {
    for (const id of ['us-east-1', 'ap-south-1'] as const) {
      const ai = catalogForRegion(id).workloads.filter((w) => w.category === 'ai');
      expect(ai).toHaveLength(3);
      // Tokens are billed per token, not per datacentre.
      for (const w of ai) expect(w.entries.length).toBeGreaterThan(2);
    }
  });

  it('names the providers it had no figures for, rather than guessing', () => {
    expect(catalogForRegion('us-east-1').omitted.sort()).toEqual(['alibaba', 'gcp', 'huawei']);
  });

  it('never leaves a live lookup that could overwrite a per-region figure', () => {
    for (const w of catalogForRegion('us-east-1').workloads.filter((x) => x.category !== 'ai')) {
      for (const e of w.entries) expect(e.live).toBeUndefined();
    }
  });

  it('labels every infrastructure group with the region shown', () => {
    const infra = catalogForRegion('ap-south-1').workloads.filter((w) => w.category !== 'ai');
    expect(infra.every((w) => w.region === 'Mumbai (ap-south-1 / centralindia)')).toBe(true);
  });

  it('records both regions for every priced workload', () => {
    for (const [id, byProvider] of Object.entries(REGIONAL_PRICES)) {
      for (const [provider, byRegion] of Object.entries(byProvider)) {
        expect(Object.keys(byRegion!).sort()).toEqual(['ap-south-1', 'us-east-1']);
      }
    }
  });
});
