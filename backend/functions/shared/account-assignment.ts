import { GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { CloudAccountItem } from './accounts';

export interface AssignmentTarget {
  userId: string;
  email?: string;
  name?: string;
  role?: string;
  status?: string;
}

/**
 * The DynamoDB fragments that move an account to a new manager.
 *
 * Returned as fragments rather than executed, so a caller changing several
 * things about an account at once still does it in a single write. Two callers
 * need these — a deliberate reassignment, and removing the teammate who held
 * the account — and the rules below (what is preserved, what is stamped) must
 * not drift between them.
 */
export function reassignmentUpdates(
  account: CloudAccountItem,
  target: AssignmentTarget,
  actorUserId: string,
): { sets: string[]; values: Record<string, unknown> } {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};

  // Preserve who actually connected it, once, the first time it moves. After
  // that createdBy is an assignment and connectedBy is the audit fact.
  if (!account.connectedBy && account.createdBy) {
    sets.push('connectedBy = :cb', 'connectedByEmail = :cbe');
    values[':cb'] = account.createdBy;
    values[':cbe'] = account.createdByEmail ?? null;
  }

  sets.push(
    'createdBy = :new',
    'createdByEmail = :newEmail',
    'createdByUpdatedAt = :now',
    'createdByUpdatedBy = :by',
  );
  values[':new'] = target.userId;
  values[':newEmail'] = target.email ?? null;
  values[':by'] = actorUserId;

  return { sets, values };
}

/**
 * Being answerable for an account has to imply being able to open it.
 *
 * Only Members carry a mapping at all — Owners and Admins already see every
 * account, so writing one for them would be data that means nothing.
 */
export function needsAccessGrant(target: AssignmentTarget): boolean {
  return target.role === 'member';
}

/** Adds one account to a Member's mapping, leaving the rest of it alone. */
export async function grantAccountToMember(
  tenantId: string,
  userId: string,
  accountId: string,
): Promise<void> {
  const key = { PK: `TENANT#${tenantId}`, SK: `MEMBER#${userId}` };
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const existing: string[] = Array.isArray(Item?.accountIds) ? (Item!.accountIds as string[]) : [];
  if (existing.includes(accountId)) return;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET accountIds = :ids, accountIdsUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':ids': [...existing, accountId],
      ':now': new Date().toISOString(),
    },
  }));
}

/** Every account in a tenant currently assigned to one person. */
export async function accountsManagedBy(
  tenantId: string,
  userId: string,
): Promise<CloudAccountItem[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: 'createdBy = :u',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#', ':u': userId },
  }));
  return (Items ?? []) as CloudAccountItem[];
}
