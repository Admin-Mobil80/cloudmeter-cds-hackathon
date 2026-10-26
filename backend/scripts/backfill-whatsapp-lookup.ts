/**
 * Writes the WAPHONE# pointer for every user whose WhatsApp was verified
 * before the assistant existed.
 *
 * The verify endpoint writes this pointer from 2026-10-23 on; anyone verified
 * earlier would otherwise be a stranger to the WhatsApp assistant. Only the
 * pointer is written — the assistant still re-reads the live channel setting on
 * every message, so a stale or extra pointer grants nothing.
 *
 * Idempotent, and a dry run unless --write is given:
 *
 *   npx tsx scripts/backfill-whatsapp-lookup.ts prod            # counts only
 *   npx tsx scripts/backfill-whatsapp-lookup.ts prod --write
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ENV = (process.argv[2] ?? '').toLowerCase();
const WRITE = process.argv.includes('--write');
if (!['dev', 'uat', 'prod'].includes(ENV)) {
  console.error('usage: tsx scripts/backfill-whatsapp-lookup.ts <dev|uat|prod> [--write]');
  process.exit(1);
}
const TABLE = `cloudmeter_${ENV}`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

async function main() {
  let found = 0;
  let written = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :s AND channels.whatsapp.connected = :t',
      ExpressionAttributeValues: { ':s': 'NOTIFPREFS', ':t': true },
      ProjectionExpression: 'PK, channels.whatsapp',
      ExclusiveStartKey: start,
    }));
    for (const item of page.Items ?? []) {
      const wa = (item.channels as { whatsapp?: { phone?: string; verifiedAt?: string } }).whatsapp;
      const digits = (wa?.phone ?? '').replace(/\D/g, '');
      if (!digits) continue;
      found += 1;
      if (!WRITE) continue;
      const userId = String(item.PK).replace('USER#', '');
      try {
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: { PK: `WAPHONE#${digits}`, SK: `USER#${userId}`, verifiedAt: wa?.verifiedAt ?? null, backfilled: true },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        written += 1;
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    start = page.LastEvaluatedKey;
  } while (start);

  console.log(`${TABLE}: ${found} users with WhatsApp connected; ${WRITE ? `${written} pointers written (others already present)` : 'dry run, nothing written'}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
