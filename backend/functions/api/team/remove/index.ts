import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import {
  accountsManagedBy, reassignmentUpdates, needsAccessGrant, grantAccountToMember,
  AssignmentTarget,
} from '../../../shared/account-assignment';
import { renderEmailHtml, renderEmailText, displayName } from '../../../shared/email-layout';

const ses = new SESClient({});

// Owners can remove admins or members. Admins can only remove members —
// never the owner, never another admin.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return json(400, { message: 'userId is required' });

  const tenantId = caller.membership.tenantId;
  const key = { PK: `TENANT#${tenantId}`, SK: `MEMBER#${targetUserId}` };
  const { Item: target } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (!target) return json(404, { message: 'Member not found' });
  if (target.role === 'owner') return json(400, { message: "Can't remove the owner" });
  if (caller.membership.role === 'admin' && target.role !== 'member') {
    return json(403, { message: 'Admins can only remove members' });
  }

  // An account whose manager has left is not lost, but it is unattended: the
  // person answerable for its spend is gone, and nobody is told. So removal
  // stops here and asks where those accounts should go, rather than quietly
  // leaving them pointing at someone who no longer exists.
  const managed = await accountsManagedBy(tenantId, targetUserId);
  const reassignTo = event.queryStringParameters?.reassignTo;

  if (managed.length > 0 && !reassignTo) {
    return json(409, {
      message: `${displayName(target.name as string | undefined, (target.email as string) ?? '')} manages `
        + `${managed.length} cloud account${managed.length === 1 ? '' : 's'}. `
        + 'Choose who should take them on before removing them.',
      needsReassignment: true,
      managedAccounts: managed.map((a) => ({ id: a.accountId, name: a.name, provider: a.provider })),
    });
  }

  let newManager: AssignmentTarget | null = null;
  if (managed.length > 0 && reassignTo) {
    if (reassignTo === targetUserId) {
      return json(400, { message: 'Pick someone other than the person being removed.' });
    }
    const { Item: next } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `MEMBER#${reassignTo}` },
    }));
    if (!next || next.status === 'pending') {
      return json(400, { message: 'Pick someone who has already joined this CloudMeter account.' });
    }
    newManager = next as AssignmentTarget;

    // Moved before the membership is deleted, so a failure part-way leaves the
    // person still on the team with their accounts — recoverable — rather than
    // removed with accounts pointing at nobody.
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

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));

  // Only the incoming manager is told. The person removed has left the
  // organisation, so mailing them about its accounts would be telling an
  // outsider — and the caller is looking at the result on screen.
  if (newManager && managed.length > 0 && newManager.email !== caller.email) {
    await notifyNewManager(newManager, managed, caller, tenantId);
  }

  return json(204, {});
};

async function notifyNewManager(
  next: AssignmentTarget,
  accounts: Array<{ name: string }>,
  caller: { email: string; membership: { name: string | null; tenantName: string | null } },
  _tenantId: string,
): Promise<void> {
  const from = process.env.OTP_FROM_EMAIL;
  const portalUrl = process.env.PORTAL_URL;
  if (!next.email || !from || !portalUrl) return;

  const names = accounts.map((a) => a.name).join(', ');
  const actor = displayName(caller.membership.name, caller.email);
  const title = accounts.length === 1
    ? `You now manage ${accounts[0].name} in CloudMeter`
    : `You now manage ${accounts.length} cloud accounts in CloudMeter`;

  const mail = {
    title,
    paragraphs: [
      `${actor} removed a teammate from ${caller.membership.tenantName ?? 'your CloudMeter account'} `
        + `and assigned their cloud account${accounts.length === 1 ? '' : 's'} to you: ${names}.`,
      'As their manager you can open them, force a cost refresh, and act on their alerts.',
    ],
    cta: { label: 'View your cloud accounts', url: `${portalUrl.replace(/\/$/, '')}/accounts.html` },
  };

  try {
    await ses.send(new SendEmailCommand({
      Source: `CloudMeter <${from}>`,
      Destination: { ToAddresses: [next.email] },
      Message: {
        Subject: { Data: title },
        Body: { Text: { Data: renderEmailText(mail) }, Html: { Data: renderEmailHtml(mail) } },
      },
    }));
  } catch (err) {
    // The removal is already committed; a failed send must not report it failed.
    console.error('Handover-on-removal email failed', (err as Error).message);
  }
}
