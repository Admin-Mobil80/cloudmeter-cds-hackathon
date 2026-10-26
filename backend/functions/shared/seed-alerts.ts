import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import type { ServiceBreakdownItem } from './seed-cost-data';

interface AlertTemplate {
  sev: 'critical' | 'serious' | 'warning';
  titleFor: (service: string) => string;
  rootCauseFor: (service: string, account: string) => string;
  actionFor: (service: string) => string;
  baselineMultiplier: number;
  currentMultiplier: number;
  unit: string;
}

const TEMPLATES: AlertTemplate[] = [
  {
    sev: 'serious',
    titleFor: (s) => `Cost spike — ${s}`,
    rootCauseFor: (s, a) =>
      `${s} spend on ${a} has run well above its trailing 7-day baseline, consistent with an unreviewed scale-up or a mis-scoped job rather than organic growth.`,
    actionFor: (s) => `Review recent changes to ${s} resources and confirm the increase is expected.`,
    baselineMultiplier: 0.4,
    currentMultiplier: 1,
    unit: '/day',
  },
  {
    sev: 'warning',
    titleFor: (s) => `Untagged spend rising — ${s}`,
    rootCauseFor: (s, a) => `A growing share of ${s} spend on ${a} isn't attributed to any cost-center tag, making it hard to allocate.`,
    actionFor: () => 'Audit recently-created resources for missing cost-center tags and backfill your tagging policy.',
    baselineMultiplier: 0.7,
    currentMultiplier: 0.9,
    unit: '/day',
  },
];

function spark(seedRand: () => number, baseline: number, current: number): number[] {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const v = baseline + (current - baseline) * Math.min(1, t * 1.6) * (0.85 + seedRand() * 0.3);
    points.push(Math.round(v));
  }
  return points;
}

export async function seedAlertForAccount(
  tenantId: string,
  accountId: string,
  accountName: string,
  provider: string,
  serviceBreakdown: ServiceBreakdownItem[],
  rand: () => number,
): Promise<void> {
  const top = serviceBreakdown[0];
  if (!top) return;

  const template = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
  const dailySpend = top.spend / 30;
  const baseline = Math.round(dailySpend * template.baselineMultiplier);
  const current = Math.round(dailySpend * (1 + template.currentMultiplier * 0.6));
  const impact = Math.round((current - baseline) * 30);
  const now = new Date().toISOString();
  const alertId = randomUUID();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `ALERT#${now}#${alertId}`,
      id: alertId,
      severity: template.sev,
      provider,
      accountId,
      accountName,
      title: template.titleFor(top.name),
      meta: 'Started today',
      impact,
      baseline,
      current,
      unit: template.unit,
      rootCause: template.rootCauseFor(top.name, accountName),
      action: template.actionFor(top.name),
      channels: ['email'],
      recipients: 'Account owner',
      spark: spark(rand, baseline, current),
      acknowledged: false,
      // No `readBy` attribute — unread for everyone. See alert-store.ts.
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      createdAt: now,
    },
  }));
}
