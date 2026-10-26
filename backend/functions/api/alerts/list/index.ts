import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, canViewAccount, json } from '../../../shared/authz';
import { dailyRowsSince, actualsFor } from '../../../shared/alert-actuals';
import { localDateIn, normalizeTimezone } from '../../../shared/schedule';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Membership test for the two user sets an alert carries.
 *
 * Both come back as a JS Set (DynamoDB string set) when present, and are
 * absent when empty — string sets cannot be empty, so absence is how "nobody"
 * is stored.
 *
 *   readBy      — has read the numbers currently on the alert
 *   seenBefore  — read an earlier version, before the sweep refreshed it
 */
function containsUser(set: unknown, userId: string): boolean {
  if (set instanceof Set) return set.has(userId);
  if (Array.isArray(set)) return set.includes(userId);
  return false;
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ALERT#' },
    ScanIndexForward: false,
  }));

  // An alert carries its account's name and spend, so it is only visible to
  // someone who may see that account. A tenant-wide alert with no account
  // attached stays org-level, and so is hidden from a scoped Member.
  const visible = (Items ?? [])
    .filter((a) => canViewAccount(caller, (a.accountId as string) ?? ''));

  // Today in the tenant's own timezone, so a day still in progress is never
  // counted as evidence that spend has stopped.
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: `TENANT#${caller.membership.tenantId}`,
      SK: `TENANT#${caller.membership.tenantId}`,
    },
  }));
  const todayKey = localDateIn(normalizeTimezone(tenant?.timezone));

  // One read per account, not per alert: several alerts commonly share an
  // account, and the earliest of their days covers all of them.
  const earliestByAccount = new Map<string, string>();
  for (const a of visible) {
    const id = (a.accountId as string) ?? '';
    const day = alertDayKey(a);
    if (!id || !day) continue;
    const seen = earliestByAccount.get(id);
    if (!seen || day < seen) earliestByAccount.set(id, day);
  }
  const rowsByAccount = new Map<string, Awaited<ReturnType<typeof dailyRowsSince>>>();
  await Promise.all([...earliestByAccount].map(async ([id, day]) => {
    try {
      rowsByAccount.set(id, await dailyRowsSince(id, day));
    } catch (err) {
      // Actuals are an enrichment; an alert must still render without them.
      console.error(`Daily rows for ${id} failed`, (err as Error).message);
    }
  }));

  const alerts = visible
    .map((a) => ({
    id: a.id,
    severity: a.severity,
    provider: a.provider,
    accountId: a.accountId,
    accountName: a.accountName,
    // Which project the spike came from, where one clearly did. Absent on
    // providers without projects and on alerts raised before this existed.
    project: a.project ?? null,
    title: a.title,
    meta: a.meta,
    impact: a.impact ?? null,
    // What it has actually cost since, and the forecast re-derived from that
    // rather than from the single day it was detected on.
    actuals: actualsFor(
      {
        service: a.service as string,
        baseline: a.baseline as number,
        dayKey: alertDayKey(a),
        impact: (a.impact as number | null) ?? null,
      },
      rowsByAccount.get((a.accountId as string) ?? '') ?? [],
      todayKey,
    ),
    baseline: a.baseline,
    current: a.current,
    unit: a.unit,
    rootCause: a.rootCause,
    action: a.action,
    channels: a.channels,
    recipients: a.recipients,
    spark: a.spark,
    read: containsUser(a.readBy, caller.userId),
    // Three states, not two: never opened, opened and unchanged, or opened
    // and since revised. Only the first is genuinely unread, and conflating
    // the third with it is what made a recurring alert demand attention over
    // and over from someone who had already dealt with it.
    updated: !containsUser(a.readBy, caller.userId)
      && containsUser(a.seenBefore, caller.userId),
    numbersChangedAt: a.numbersChangedAt ?? null,
    /*
     * The last day the detector still saw this.
     *
     * Stored since alerts were built, never sent. Without it an alert that
     * stopped recurring three days ago is indistinguishable from one burning
     * money right now — thirteen criticals worth $6,843 sat on a production
     * dashboard reading as live, when the spend behind them had ended and
     * they were four days from expiring on their own.
     *
     * Falls back to createdAt for alerts written before lastSeenAt existed,
     * so an old row reports the one day it is known to have been seen rather
     * than claiming it was never seen at all.
     */
    lastSeenAt: a.lastSeenAt ?? a.createdAt ?? null,
    createdAt: a.createdAt,
  }));

  return json(200, { alerts });
};

/**
 * The day an alert describes.
 *
 * Alerts predating the stored `dayKey` still carry it inside `meta`
 * ("Detected 2026-08-23"). Falling back to `createdAt` alone would be a day
 * late — an alert is raised the morning after the day it reports on — and
 * that day is precisely the one holding the spend being summed.
 */
function alertDayKey(a: Record<string, unknown>): string {
  const stored = a.dayKey as string | undefined;
  if (stored) return stored;
  const fromMeta = /(\d{4}-\d{2}-\d{2})/.exec(String(a.meta ?? ''))?.[1];
  if (fromMeta) return fromMeta;
  return String(a.createdAt ?? '').slice(0, 10);
}
