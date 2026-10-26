import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * Staff access to the Business Management System.
 *
 * BMS users live under a single `BMS` partition rather than inside any
 * tenant: they are CloudMeter's own people and belong to no customer. Being in
 * the BMS Cognito pool is not sufficient on its own — a user record must also
 * exist and be active, so revoking someone is one delete rather than a hunt
 * through a directory.
 */
export const BMS_PK = 'BMS';

export type BmsRole = 'root' | 'staff';

export interface BmsUser {
  email: string;
  name: string | null;
  role: BmsRole;
  status: string;
  createdAt: string | null;
  createdBy: string | null;
  lastActiveAt: string | null;
}

export interface BmsCaller {
  email: string;
  user: BmsUser;
}

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function toUser(item: Record<string, unknown>): BmsUser {
  return {
    email: item.email as string,
    name: (item.name as string) ?? null,
    role: ((item.role as BmsRole) ?? 'staff'),
    status: (item.status as string) ?? 'active',
    createdAt: (item.createdAt as string) ?? null,
    createdBy: (item.createdBy as string) ?? null,
    lastActiveAt: (item.lastActiveAt as string) ?? null,
  };
}

export async function getBmsUser(email: string): Promise<BmsUser | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: BMS_PK, SK: `USER#${email.toLowerCase()}` },
  }));
  return Item ? toUser(Item) : null;
}

export async function listBmsUsers(): Promise<BmsUser[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': BMS_PK, ':sk': 'USER#' },
  }));
  return (Items ?? []).map(toUser).sort((a, b) => {
    // Root first, then oldest joined — the same reading order as the portal's
    // team list.
    if (a.role !== b.role) return a.role === 'root' ? -1 : 1;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

/**
 * Resolves the caller from a BMS-pool JWT.
 *
 * The token proves who they are; the user record decides whether they still
 * have access. Both are required, and the record is read fresh on every
 * request so a revocation takes effect immediately rather than at token
 * expiry.
 */
export async function resolveBmsCaller(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<BmsCaller | null> {
  const email = (event.requestContext.authorizer.jwt.claims.email as string | undefined)?.toLowerCase();
  if (!email) return null;

  const user = await getBmsUser(email);
  if (!user || user.status !== 'active') return null;

  return { email, user };
}

/** Managing staff is the root owner's alone. */
export function requireRoot(caller: BmsCaller): APIGatewayProxyResultV2 | null {
  if (caller.user.role !== 'root') {
    return json(403, { message: 'Only the solution owner can manage BMS users.' });
  }
  return null;
}
