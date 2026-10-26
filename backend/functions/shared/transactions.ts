import { PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * A record of money moving, kept on CloudMeter's side of the gateway.
 *
 * The gateway is the authority on whether a payment succeeded, but its
 * dashboard knows nothing about tenants, plans or GST — and reconciling a
 * month's revenue by exporting CSVs from two or three gateways and joining
 * them by hand is the problem this exists to avoid. Every event that moves
 * money is written here with the CloudMeter context attached.
 *
 * Append-only. A refund is its own row rather than an edit to the charge, so
 * the history reads as what happened rather than as a current balance.
 */

export type TransactionKind = 'payment' | 'refund' | 'failed';

export interface TransactionInput {
  tenantId: string;
  tenantName?: string | null;
  gateway: string;
  /** The gateway's own id — Razorpay's `pay_…`. Used for idempotency. */
  gatewayPaymentId: string;
  gatewaySubscriptionId?: string | null;
  kind: TransactionKind;
  /** Major units, in `currency`. */
  amount: number;
  currency: string;
  /** The split as it was charged, when known. */
  subtotal?: number | null;
  tax?: number | null;
  taxPercent?: number | null;
  planId?: string | null;
  status: string;
  method?: string | null;
  /** ISO. The gateway's timestamp, not ours, so the row dates the real event. */
  occurredAt: string;
}

export interface TransactionRow extends TransactionInput {
  id: string;
  recordedAt: string;
}

/**
 * Stored under the tenant so one account's history is a query, not a scan,
 * and keyed by timestamp so it comes back newest-last without sorting.
 *
 * The gateway's payment id is in the sort key, which makes the write naturally
 * idempotent: gateways retry webhooks, and a retry rewrites the same row
 * instead of double-counting revenue.
 */
export async function recordTransaction(input: TransactionInput): Promise<TransactionRow> {
  const recordedAt = new Date().toISOString();
  const id = `${input.occurredAt}#${input.gatewayPaymentId}`;

  const row: TransactionRow = { ...input, id, recordedAt };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${input.tenantId}`,
      SK: `TXN#${id}`,
      ...row,
    },
  }));

  console.log('Transaction recorded', {
    tenantId: input.tenantId, gateway: input.gateway, kind: input.kind,
    amount: input.amount, currency: input.currency, id,
  });
  return row;
}

/** One tenant's history, newest first. */
export async function transactionsForTenant(tenantId: string, limit = 100): Promise<TransactionRow[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'TXN#' },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (Items ?? []) as TransactionRow[];
}

/**
 * Every tenant's transactions, newest first, for the BMS ledger.
 *
 * Scans rather than querying GSI1: the index is defined on the table for the
 * membership lookup and its key space is already spoken for, so adding a
 * fourth access pattern to it is a data-model change rather than a read. At
 * this volume a filtered scan is cheap, and the alternative — a new GSI —
 * should wait until the row count justifies it.
 */
export async function allTransactions(limit = 500): Promise<TransactionRow[]> {
  const out: TransactionRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':sk': 'TXN#' },
      ExclusiveStartKey,
    }));
    out.push(...((res.Items ?? []) as TransactionRow[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);

  return out
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    .slice(0, limit);
}
