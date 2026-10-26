import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import {
  accountsManagedBy, reassignmentUpdates, needsAccessGrant, grantAccountToMember,
  AssignmentTarget,
} from '../../../shared/account-assignment';
import { renderEmailHtml, renderEmailText, displayName } from '../../../shared/email-layout';

const ses = new SESClient({});

/** What becomes of the outgoing owner. */
const OUTGOING_ROLES = ['admin', 'member', 'remove'] as const;
type OutgoingRole = (typeof OUTGOING_ROLES)[number];

/**
 * Hands a CloudMeter account to someone else.
 *
 * Ownership is not a label: the Owner is the only role that can close the
 * account, change billing, or transfer it on. So exactly one person must hold
 * it at all times — never two, never nobody. The swap is therefore a single
 * DynamoDB transaction: either the new owner is promoted *and* the old one is
 * demoted or removed, or nothing moves at all.
 *
 * The outgoing owner chooses their own fate up front (Admin, Member, or off
 * the team entirely) because there is no sensible default. Staying on as an
 * Admin is the common case; leaving outright is what happens when someone
 * departs the company.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  // Only the current owner can give ownership away. An Admin promoting
  // themselves would be a privilege escalation, not a handover.
  const forbidden = requireRole(caller, ['owner']);
  if (forbidden) return forbidden;

  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return json(400, { message: 'userId is required' });
  if (targetUserId === caller.userId) {
    return json(400, { message: 'You already own this CloudMeter account.' });
  }

  let body: { outgoingRole?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }
  const outgoingRole = body.outgoingRole as OutgoingRole;
  if (!OUTGOING_ROLES.includes(outgoingRole)) {
    return json(400, { message: 'outgoingRole must be admin, member or remove' });
  }

  const tenantId = caller.membership.tenantId;
  const targetKey = { PK: `TENANT#${tenantId}`, SK: `MEMBER#${targetUserId}` };
  const callerKey = { PK: `TENANT#${tenantId}`, SK: `MEMBER#${caller.userId}` };

  const { Item: target } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: targetKey }));
  if (!target) return json(404, { message: 'Member not found' });
  // A pending invitee has never signed in. Handing them the account would
  // leave it owned by someone who may never accept.
  if (target.status === 'pending') {
    return json(400, { message: 'That person has not joined this CloudMeter account yet.' });
  }

  // Only relevant when the outgoing owner is leaving: if they stay on as an
  // Admin or Member their cloud accounts stay with them, unchanged.
  let newManager: AssignmentTarget | null = null;
  let managed: Awaited<ReturnType<typeof accountsManagedBy>> = [];

  if (outgoingRole === 'remove') {
    managed = await accountsManagedBy(tenantId, caller.userId);
    const reassignTo = event.queryStringParameters?.reassignTo ?? targetUserId;

    if (managed.length > 0) {
      if (reassignTo === caller.userId) {
        return json(400, { message: 'Pick someone other than yourself to take on your cloud accounts.' });
      }
      const { Item: next } = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: `MEMBER#${reassignTo}` },
      }));
      if (!next || next.status === 'pending') {
        return json(400, { message: 'Pick someone who has already joined this CloudMeter account.' });
      }
      newManager = next as AssignmentTarget;

      // Moved before the swap, so a failure part-way leaves the current owner
      // in place with their accounts — recoverable — rather than an account
      // whose manager no longer exists.
      for (const account of managed) {
        const move = reassignmentUpdates(account, newManager, caller.userId);
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `TENANT#${tenantId}`, SK: `ACCOUNT#${account.accountId}` },
          UpdateExpression: `SET ${move.sets.join(', ')}, updatedAt = :now`,
          ExpressionAttributeValues: { ...move.values, ':now': new Date().toISOString() },
        }));
        if (needsAccessGrant(newManager)) {
          await grantAccountToMember(tenantId, newManager.userId, account.accountId);
        }
      }
    }
  }

  const now = new Date().toISOString();

  // One transaction, so the account can never be left with two owners or
  // none. The conditions re-check both roles at write time: if a concurrent
  // request already moved ownership, this one fails rather than overwriting
  // it.
  const outgoing = outgoingRole === 'remove'
    ? { Delete: { TableName: TABLE_NAME, Key: callerKey, ConditionExpression: '#role = :owner', ExpressionAttributeNames: { '#role': 'role' }, ExpressionAttributeValues: { ':owner': 'owner' } } }
    : {
        Update: {
          TableName: TABLE_NAME,
          Key: callerKey,
          UpdateExpression: 'SET #role = :newRole',
          ConditionExpression: '#role = :owner',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':newRole': outgoingRole, ':owner': 'owner' },
        },
      };

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: targetKey,
            UpdateExpression: 'SET #role = :owner, ownershipTransferredAt = :now, ownershipTransferredBy = :by',
            ConditionExpression: 'attribute_exists(PK) AND #role <> :owner',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':owner': 'owner', ':now': now, ':by': caller.email },
          },
        },
        outgoing,
        {
          // Kept in step with the membership rows. Nothing reads it today,
          // but leaving it pointing at someone who is no longer the owner —
          // or no longer on the team — is a trap for whatever reads it next.
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
            UpdateExpression: 'SET ownerId = :new, ownerTransferredAt = :now',
            ExpressionAttributeValues: { ':new': targetUserId, ':now': now },
          },
        },
      ],
    }));
  } catch (err) {
    if ((err as Error).name === 'TransactionCanceledException') {
      return json(409, {
        message: 'Ownership changed while this was in flight. Reload the team page and try again.',
      });
    }
    throw err;
  }

  await notifyNewOwner(target, caller, managed.length, outgoingRole);

  return json(200, {
    newOwner: { id: targetUserId, email: target.email ?? null, name: target.name ?? null },
    outgoing: { id: caller.userId, role: outgoingRole === 'remove' ? null : outgoingRole, removed: outgoingRole === 'remove' },
    reassignedAccounts: managed.length,
  });
};

/**
 * Tells the new owner, because this changes what they are answerable for and
 * they did not ask for it. The outgoing owner performed the action and is
 * looking at the result, so they are not mailed.
 */
async function notifyNewOwner(
  target: Record<string, unknown>,
  caller: { email: string; membership: { name: string | null; tenantName: string | null } },
  reassignedCount: number,
  outgoingRole: OutgoingRole,
): Promise<void> {
  const from = process.env.OTP_FROM_EMAIL;
  const portalUrl = process.env.PORTAL_URL;
  const to = target.email as string | undefined;
  if (!to || !from || !portalUrl) return;

  const tenantName = caller.membership.tenantName ?? 'your CloudMeter account';
  const actor = displayName(caller.membership.name, caller.email);
  const title = `You now own ${tenantName} in CloudMeter`;

  const paragraphs = [
    `${actor} transferred ownership of ${tenantName} to you.`,
    'As the owner you can manage billing and the plan, change what everyone else can do, '
      + 'transfer ownership on, and close the account.',
    outgoingRole === 'remove'
      ? `${actor} has left this CloudMeter account.`
      : `${actor} stays on the team as ${outgoingRole === 'admin' ? 'an Admin' : 'a Member'}.`,
  ];
  if (reassignedCount > 0) {
    paragraphs.push(
      `${reassignedCount} cloud account${reassignedCount === 1 ? '' : 's'} they managed `
        + `${reassignedCount === 1 ? 'has' : 'have'} been assigned to you.`,
    );
  }

  const mail = {
    title,
    paragraphs,
    cta: { label: 'Open CloudMeter', url: `${portalUrl.replace(/\/$/, '')}/dashboard.html` },
  };

  try {
    await ses.send(new SendEmailCommand({
      Source: `CloudMeter <${from}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: title },
        Body: { Text: { Data: renderEmailText(mail) }, Html: { Data: renderEmailHtml(mail) } },
      },
    }));
  } catch (err) {
    // The transfer is already committed; a failed send must not report it failed.
    console.error('Ownership transfer email failed', (err as Error).message);
  }
}
