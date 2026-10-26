import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, canManageAccount, json, Caller, requireWritable } from '../../../shared/authz';
import { loadAccountForCaller, CloudAccountItem } from '../../../shared/accounts';
import { sendHandoverEmails, providerLabel } from '../../../shared/handover-email';
import { displayName } from '../../../shared/email-layout';
import { reassignmentUpdates, needsAccessGrant, grantAccountToMember } from '../../../shared/account-assignment';

const MAX_OWNER_LENGTH = 120;
const MAX_NAME_LENGTH = 80;

/**
 * Updates the editable parts of a connected account.
 *
 * Credentials are deliberately not changeable here — rotating them is a
 * reconnect, so the new ones get verified before anything is stored, rather
 * than being written and discovered broken at the next sync.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  let body: { owner?: unknown; createdBy?: unknown; name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const wantsOwner = body.owner !== undefined;
  const wantsReassign = body.createdBy !== undefined;
  const wantsName = body.name !== undefined;
  if (!wantsOwner && !wantsReassign && !wantsName) return json(400, { message: 'Nothing to update' });

  let handover: {
    fromEmail?: string;
    fromName?: string;
    toEmail: string;
    toName: string;
    fromStillOnTeam: boolean;
  } | null = null;
  let grantToMember: string | null = null;

  const sets: string[] = ['updatedAt = :now'];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };

  if (wantsName) {
    if (typeof body.name !== 'string') return json(400, { message: 'name must be text' });
    const name = body.name.trim();
    if (!name) return json(400, { message: 'Give the account a name.' });
    if (name.length > MAX_NAME_LENGTH) {
      return json(400, { message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }

    // Deliberately not checked for uniqueness — connecting an account doesn't
    // enforce it either, and two accounts legitimately share a label often
    // enough (same business unit in two providers) that blocking it here would
    // be a rule the rest of the product doesn't keep.
    //
    // #nm — "name" is a DynamoDB reserved word.
    names['#nm'] = 'name';
    sets.push('#nm = :nm', 'nameUpdatedAt = :now');
    values[':nm'] = name;
  }

  if (wantsOwner) {
    // Same rule as removing the account: Owners anywhere, Admins on what they
    // are answerable for.
    if (!canManageAccount(caller, account)) return json(403, { message: cannotManageMessage(account) });

    if (typeof body.owner !== 'string') return json(400, { message: 'owner must be text' });
    const owner = body.owner.trim().slice(0, MAX_OWNER_LENGTH);

    names['#o'] = 'owner';
    // Clearing it removes the attribute rather than storing an empty string,
    // so "no owner recorded" stays a single state.
    if (owner) {
      sets.push('#o = :o', 'ownerUpdatedAt = :now');
      values[':o'] = owner;
    } else {
      removes.push('#o');
      sets.push('ownerUpdatedAt = :now');
    }
  }

  if (wantsReassign) {
    if (!canReassign(caller, account)) {
      return json(403, { message: `Only an Admin or the account owner can reassign ${account.name}.` });
    }

    if (typeof body.createdBy !== 'string' || !body.createdBy.trim()) {
      return json(400, { message: 'createdBy must be the user ID of a teammate' });
    }
    const targetId = body.createdBy.trim();

    const target = await getMember(caller.membership.tenantId, targetId);
    if (!target || target.status === 'pending') {
      // Pending invitees have no Cognito identity yet, so assigning to one
      // would leave the account managed by nobody until they accept.
      return json(400, { message: 'Pick someone who has already joined this CloudMeter account.' });
    }
    const move = reassignmentUpdates(account, target, caller.userId);
    sets.push(...move.sets);
    Object.assign(values, move.values);
    if (needsAccessGrant(target)) grantToMember = target.userId;

    // Reassigning to whoever already holds it changes nothing, so it shouldn't
    // generate mail saying it did.
    if (target.userId !== account.createdBy && target.email) {
      // Someone removed from the team keeps their address on the account, but
      // they are no longer part of this organisation — mailing them about its
      // internal account management would be telling an outsider.
      const previous = account.createdBy
        ? await getMember(caller.membership.tenantId, account.createdBy)
        : null;
      handover = {
        fromEmail: account.createdByEmail,
        fromName: account.createdByEmail
          ? displayName(previous?.name, account.createdByEmail)
          : undefined,
        toEmail: target.email,
        toName: displayName(target.name, target.email),
        fromStillOnTeam: !!previous,
      };
    }
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `ACCOUNT#${accountId}` },
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));

  // Deliberately not the reverse: an outgoing manager keeps whatever access
  // they had. Handing on a duty is not a reason to revoke someone's visibility
  // of an account they may still work on.
  if (grantToMember) await grantAccountToMember(caller.membership.tenantId, grantToMember, accountId);

  if (handover) await notifyHandover(caller, account, handover);

  const updated = await loadAccountForCaller(caller, accountId);
  return json(200, {
    id: accountId,
    name: updated?.name ?? null,
    owner: updated?.owner ?? null,
    createdBy: updated?.createdBy ?? null,
    createdByEmail: updated?.createdByEmail ?? null,
    connectedByEmail: updated?.connectedByEmail ?? null,
  });
};

function cannotManageMessage(account: CloudAccountItem): string {
  return `Only an Admin or the account owner can change ${account.name}.`;
}

/**
 * Handing an account to someone else is an Owner's or Admin's call.
 *
 * A Member who holds one cannot pass it on — they are answerable for its spend,
 * not for who is answerable next. In practice this only excludes Members, since
 * any Owner or Admin holding an account already qualifies above.
 */
function canReassign(caller: Caller, _account: CloudAccountItem): boolean {
  return canManageAccount(caller);
}

interface MemberItem {
  userId: string;
  email?: string;
  name?: string;
  role?: string;
  status?: string;
}

async function getMember(tenantId: string, userId: string): Promise<MemberItem | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `MEMBER#${userId}` },
  }));
  return (Item as MemberItem | undefined) ?? null;
}

/**
 * Best-effort: the write is already committed, so a failed send must not turn a
 * successful reassignment into an error the caller will retry.
 */
async function notifyHandover(
  caller: Caller,
  account: CloudAccountItem,
  handover: { fromEmail?: string; fromName?: string; toEmail: string; toName: string; fromStillOnTeam: boolean },
): Promise<void> {
  const from = process.env.OTP_FROM_EMAIL;
  const portalUrl = process.env.PORTAL_URL;
  if (!from || !portalUrl) {
    console.error('Handover email not configured; skipping', { from: !!from, portalUrl: !!portalUrl });
    return;
  }

  try {
    const { Item: tenant } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `TENANT#${caller.membership.tenantId}` },
    }));

    await sendHandoverEmails({
      accountName: account.name,
      providerLabel: providerLabel(account.provider),
      externalId: account.externalId,
      actorName: displayName(caller.membership.name, caller.email),
      // Skipped for someone who has left, and for the person clicking the
      // button — they don't need mail describing what they just did.
      fromEmail: handover.fromStillOnTeam && handover.fromEmail !== caller.email
        ? handover.fromEmail
        : undefined,
      toEmail: handover.toEmail,
      toName: handover.toName,
      // Unconditional: the incoming manager should know who held it before,
      // even if that person has since left. Only the outgoing *send* above is
      // gated on them still being here.
      fromName: handover.fromName,
      tenantName: (tenant?.name as string) ?? '',
      portalUrl,
      fromEmailAddress: from,
      accountId: account.accountId,
    });
  } catch (err) {
    console.error('Handover email failed', (err as Error).message);
  }
}

