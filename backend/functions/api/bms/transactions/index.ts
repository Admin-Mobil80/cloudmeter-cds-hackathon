import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveBmsCaller, json } from '../../../shared/bms';
import { allTransactions } from '../../../shared/transactions';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';

/**
 * Every payment CloudMeter has taken, across tenants and gateways.
 *
 * Staff-only by virtue of the BMS authorizer — this is the revenue ledger, and
 * no customer token can reach any /bms route.
 *
 * Tenant names are joined on here rather than stored on each row: a business
 * that renames itself should not leave a ledger referring to a name nobody
 * recognises any more.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  const rows = await allTransactions();

  const names = new Map<string, string>();
  for (const tenantId of new Set(rows.map((r) => r.tenantId))) {
    names.set(tenantId, await tenantName(tenantId));
  }

  const transactions = rows.map((r) => ({
    ...r,
    tenantName: names.get(r.tenantId) ?? r.tenantId,
  }));

  // Totals per currency, never summed across them — adding rupees to dollars
  // to produce one headline number is the classic way a revenue figure becomes
  // fiction. Refunds and failures are excluded from the take.
  const totals: Record<string, { collected: number; refunded: number; failed: number; count: number }> = {};
  for (const t of transactions) {
    const cur = (t.currency || 'INR').toUpperCase();
    totals[cur] ??= { collected: 0, refunded: 0, failed: 0, count: 0 };
    totals[cur].count += 1;
    if (t.kind === 'payment') totals[cur].collected += t.amount;
    else if (t.kind === 'refund') totals[cur].refunded += t.amount;
    else if (t.kind === 'failed') totals[cur].failed += t.amount;
  }

  return json(200, { transactions, totals });
};

async function tenantName(tenantId: string): Promise<string> {
  try {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': `TENANT#${tenantId}` },
      ProjectionExpression: '#n',
      ExpressionAttributeNames: { '#n': 'name' },
    }));
    return ((Items ?? [])[0]?.name as string) ?? tenantId;
  } catch {
    return tenantId;
  }
}
