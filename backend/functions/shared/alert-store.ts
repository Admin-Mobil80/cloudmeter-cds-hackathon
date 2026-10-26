import { randomUUID } from 'crypto';
import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { Anomaly, anomalyTitle, anomalyRootCause, anomalyAction } from './anomaly';

export interface StoredAlert {
  id: string;
  dedupeKey: string;
  severity: string;
  accountName: string;
  service: string;
  impact: number | null;
  createdAt: string;
}

/**
 * Writes an anomaly to the alert list, or refreshes the one already open for
 * it.
 *
 * Dedupe is the whole point. A spike that lasts a week is one problem, not
 * seven — without this the list fills with copies of the same alert every day
 * and the real signal is buried. The same alert item just keeps getting
 * refreshed in place for as long as the same dedupeKey keeps recurring.
 *
 * Returns the alert when it is newly raised, and null when an existing one was
 * merely updated — so callers know whether anything is worth notifying about.
 */
/** Auto-deleted (via the table's TTL) this many days after last touched. */
const ALERT_TTL_DAYS = 7;

function alertExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ALERT_TTL_DAYS * 86400;
}

export async function upsertAnomalyAlert(
  tenantId: string,
  anomaly: Anomaly,
): Promise<StoredAlert | null> {
  const existing = await findOpenAlert(tenantId, anomaly.dedupeKey);
  const now = new Date().toISOString();

  if (existing) {
    // Same problem, newer numbers. The creation time stays put so the list
    // keeps showing when this started, not when we last looked at it. The TTL
    // pushes out another 7 days, so an alert stays alive as long as it keeps
    // recurring and only auto-deletes once it's actually gone quiet.
    //
    // Read state moves from `readBy` to `seenBefore` rather than being thrown
    // away. This used to be a flat `REMOVE readBy`, on the reasoning that new
    // numbers are new information — true, but it made the alert indistinguishable
    // from one nobody had ever opened. A recurring problem came back bold and
    // unread for all thirteen members every time the sweep saw it again, which
    // is how half of a tenant's unread count came to be alerts already dealt
    // with. Splitting the two lets the list say "updated since you read it"
    // without claiming "you have never seen this".
    const previouslyRead = existing.readBy;
    const carriesReaders = previouslyRead instanceof Set && previouslyRead.size > 0;

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: existing.PK as string, SK: existing.SK as string },
      UpdateExpression: 'SET #cur = :cur, baseline = :base, impact = :impact, '
        + 'severity = :sev, lastSeenAt = :now, spark = :spark, rootCause = :rc, #act = :act, '
        + 'dayKey = :day, expiresAt = :exp, numbersChangedAt = :now'
        // ADD unions into the existing set, so readers accumulate across
        // however many times this alert recurs. Only when there is something
        // to carry: DynamoDB rejects an empty set.
        + (carriesReaders ? ' ADD seenBefore :prev' : '')
        + ' REMOVE readBy',
      ExpressionAttributeNames: { '#cur': 'current', '#act': 'action' },
      ExpressionAttributeValues: {
        ':cur': anomaly.current,
        ':base': anomaly.baseline,
        ':impact': anomaly.impact,
        ':day': anomaly.dayKey,
        ':sev': anomaly.severity,
        ':now': now,
        ':spark': anomaly.spark,
        ':rc': anomalyRootCause(anomaly),
        ':act': anomalyAction(anomaly),
        ':exp': alertExpiresAt(),
        ...(carriesReaders ? { ':prev': previouslyRead } : {}),
      },
    }));
    return null;
  }

  const id = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}`,
      SK: `ALERT#${now}#${id}`,
      id,
      dedupeKey: anomaly.dedupeKey,
      severity: anomaly.severity,
      provider: anomaly.provider,
      accountId: anomaly.accountId,
      accountName: anomaly.accountName,
      service: anomaly.service,
      title: anomalyTitle(anomaly),
      meta: `Detected ${anomaly.dayKey}`,
      // The day the anomaly was measured on, stored as data rather than only
      // inside `meta`'s prose. Actuals are summed from this day forward, and
      // deriving it from createdAt is wrong by a day — an alert is raised the
      // morning after the day it describes.
      dayKey: anomaly.dayKey,
      impact: anomaly.impact,
      baseline: anomaly.baseline,
      current: anomaly.current,
      // Stored so the alerts page can name it too; absent when unattributable.
      ...(anomaly.project ? { project: anomaly.project } : {}),
      unit: '/day',
      rootCause: anomalyRootCause(anomaly),
      action: anomalyAction(anomaly),
      // Filled in by whatever actually delivers it, so the UI never claims a
      // channel that didn't carry the message.
      channels: [],
      recipients: [],
      spark: anomaly.spark,
      // Never set true by anything any more (acknowledge/snooze/escalate was
      // removed) — kept only so findOpenAlert's dedupe filter below still has
      // a field to match on.
      acknowledged: false,
      // Drives the inbox-style unread badge, per person: `readBy` is a set of
      // user IDs who've opened this alert's detail view. No `readBy`
      // attribute at all means nobody has — DynamoDB string sets can't be
      // empty, so "unread for everyone" is represented by the attribute's
      // absence rather than an empty set.
      expiresAt: alertExpiresAt(),
      source: 'detector',
      createdAt: now,
      lastSeenAt: now,
    },
  }));

  return {
    id,
    dedupeKey: anomaly.dedupeKey,
    severity: anomaly.severity,
    accountName: anomaly.accountName,
    service: anomaly.service,
    impact: anomaly.impact,
    createdAt: now,
  };
}

/** Records which channels actually delivered an alert. */
export async function recordAlertDelivery(
  tenantId: string,
  createdAt: string,
  alertId: string,
  channels: string[],
  recipients: string[],
): Promise<void> {
  if (channels.length === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `ALERT#${createdAt}#${alertId}` },
    UpdateExpression: 'SET channels = :c, recipients = :r',
    ExpressionAttributeValues: { ':c': channels, ':r': recipients },
  }));
}

async function findOpenAlert(
  tenantId: string,
  dedupeKey: string,
): Promise<Record<string, unknown> | null> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: 'dedupeKey = :key AND acknowledged = :no',
    ExpressionAttributeValues: {
      ':pk': `TENANT#${tenantId}`,
      ':sk': 'ALERT#',
      ':key': dedupeKey,
      ':no': false,
    },
    ScanIndexForward: false,
  }));
  return Items?.[0] ?? null;
}
