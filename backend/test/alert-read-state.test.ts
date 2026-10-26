import { ddb } from '../functions/shared/ddb';
import { upsertAnomalyAlert } from '../functions/shared/alert-store';
import type { Anomaly } from '../functions/shared/anomaly';

/**
 * When a recurring anomaly is re-detected, the people who already read the
 * alert must not be told they have never seen it.
 *
 * The old behaviour was a flat `REMOVE readBy`, which returned the alert to
 * fully unread for every member of the tenant every time the sweep saw the
 * same problem again. In one real tenant that put four alerts — half its
 * unread count — back in the badge overnight with no new alert raised, one of
 * them a warning that had been recurring for thirteen days.
 *
 * Read state now moves to `seenBefore`, which the list turns into "updated"
 * rather than "unread".
 */

const ANOMALY: Anomaly = {
  dedupeKey: 'acct-1#AWS Lambda',
  severity: 'serious',
  provider: 'aws',
  accountId: 'acct-1',
  accountName: 'Contoso',
  service: 'AWS Lambda',
  dayKey: '2026-09-08',
  impact: 355,
  baseline: 0.45,
  current: 1.37,
  spark: [0.4, 0.5, 1.37],
} as Anomaly;

/** Captures what upsert sends, with `findOpenAlert` answering with `existing`. */
function captureUpdate(existing: Record<string, unknown> | null) {
  const sent: Array<Record<string, unknown>> = [];
  jest.spyOn(ddb, 'send').mockImplementation(((cmd: { input: Record<string, unknown> }) => {
    // The first call is findOpenAlert's Query; answer it, record the rest.
    if ('KeyConditionExpression' in cmd.input) {
      return Promise.resolve({ Items: existing ? [existing] : [] });
    }
    sent.push(cmd.input);
    return Promise.resolve({});
  }) as never);
  return sent;
}

afterEach(() => jest.restoreAllMocks());

describe('read state across a refresh', () => {
  it('carries existing readers into seenBefore', async () => {
    const sent = captureUpdate({
      PK: 'TENANT#t1',
      SK: 'ALERT#2026-09-01T00:00:00Z#a1',
      readBy: new Set(['user-a', 'user-b']),
    });

    await upsertAnomalyAlert('t1', ANOMALY);

    expect(sent).toHaveLength(1);
    const expr = sent[0].UpdateExpression as string;
    expect(expr).toContain('ADD seenBefore :prev');
    // Still cleared, so `read` means "has seen the numbers now on the alert".
    expect(expr).toContain('REMOVE readBy');
    expect((sent[0].ExpressionAttributeValues as Record<string, unknown>)[':prev'])
      .toEqual(new Set(['user-a', 'user-b']));
  });

  it('records when the figures last changed', async () => {
    const sent = captureUpdate({ PK: 'TENANT#t1', SK: 'ALERT#x#a1', readBy: new Set(['user-a']) });
    await upsertAnomalyAlert('t1', ANOMALY);
    expect(sent[0].UpdateExpression as string).toContain('numbersChangedAt = :now');
  });

  it('omits the ADD when nobody had read it', async () => {
    // DynamoDB rejects an empty string set, so the clause has to disappear
    // rather than be sent with nothing in it.
    const sent = captureUpdate({ PK: 'TENANT#t1', SK: 'ALERT#x#a1' });

    await upsertAnomalyAlert('t1', ANOMALY);

    const expr = sent[0].UpdateExpression as string;
    expect(expr).not.toContain('ADD seenBefore');
    expect(expr).toContain('REMOVE readBy');
    expect(sent[0].ExpressionAttributeValues as Record<string, string>).not.toHaveProperty(':prev');
  });

  it('treats an empty reader set the same as none', async () => {
    const sent = captureUpdate({ PK: 'TENANT#t1', SK: 'ALERT#x#a1', readBy: new Set([]) });
    expect(sent).toBeDefined();
    await upsertAnomalyAlert('t1', ANOMALY);
    expect(sent[0].UpdateExpression as string).not.toContain('ADD seenBefore');
  });

  it('a newly raised alert is unread for everyone, with no seenBefore', async () => {
    const sent = captureUpdate(null);

    const raised = await upsertAnomalyAlert('t1', ANOMALY);

    // New alert -> Put, and it must carry neither set: absence is how
    // "nobody has read this" is stored.
    expect(raised).not.toBeNull();
    const item = sent[0].Item as Record<string, unknown>;
    expect(item).not.toHaveProperty('readBy');
    expect(item).not.toHaveProperty('seenBefore');
  });
});
