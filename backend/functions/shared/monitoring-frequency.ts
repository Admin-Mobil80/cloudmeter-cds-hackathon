// Tenant-wide monitoring frequency. Provider cost APIs are metered (AWS Cost
// Explorer bills per request, and other providers have their own limits), so
// this caps how often CloudMeter will actually call out to them.

export const ALLOWED_FREQUENCIES = [1, 2, 3, 4, 6] as const;
export type MonitoringFrequency = (typeof ALLOWED_FREQUENCIES)[number];

export const DEFAULT_FREQUENCY: MonitoringFrequency = 2;

export function isValidFrequency(v: unknown): v is MonitoringFrequency {
  return typeof v === 'number' && (ALLOWED_FREQUENCIES as readonly number[]).includes(v);
}

export function normalizeFrequency(v: unknown): MonitoringFrequency {
  return isValidFrequency(v) ? v : DEFAULT_FREQUENCY;
}

/** Minimum gap between real provider API pulls for a given daily frequency. */
export function intervalMsFor(frequency: MonitoringFrequency): number {
  return Math.floor(86_400_000 / frequency);
}
