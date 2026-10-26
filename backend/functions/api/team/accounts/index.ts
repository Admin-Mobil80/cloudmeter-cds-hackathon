import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import { renderEmailHtml, renderEmailText, displayName } from '../../../shared/email-layout';

const ses = new SESClient({});

/**
 * Sets which cloud accounts a Member can see.
 *
 * Owners and Admins are never mapped — they see the whole tenant — so this
 * refuses to write a list for one rather than storing a value that would be
 * silently ignored and read later as if it meant something.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const userId = event.pathParameters?.userId;
  if (!userId) return json(400, { message: 'userId is required' });

  let body: { accountIds?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }
  if (!Array.isArray(body.accountIds)) {
    return json(400, { message: 'accountIds must be a list' });
  }
  const requested = [...new Set(
    body.accountIds.filter((id): id is string => typeof id === 'string' && !!id),
  )];

  const tenantId = caller.membership.tenantId;
  const key = { PK: `TENANT#${tenantId}`, SK: `MEMBER#${userId}` };

  const { Item: target } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (!target) return json(404, { message: 'Member not found' });
  if (target.role !== 'member') {
    return json(400, {
      message: `${target.email ?? 'This teammate'} is ${target.role === 'owner' ? 'the Owner' : 'an Admin'} and already sees every cloud account.`,
    });
  }

  // Grant only from accounts that exist in this tenant. Owners and Admins can
  // both grant any of them: an Admin who could only share what they personally
  // connected would have to escalate to the Owner to onboard a teammate onto a
  // colleague's account, which is ordinary work.
  const { Items: accounts } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: 'accountId, #n, createdBy',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
  }));

  const known = new Set((accounts ?? []).map((a) => a.accountId as string));

  const rejected = requested.filter((id) => !known.has(id));
  if (rejected.length) {
    return json(400, {
      message: 'Those cloud accounts are not part of this CloudMeter account.',
      rejectedAccountIds: rejected,
    });
  }

  const accountIds = requested;

  const before: string[] = Array.isArray(target.accountIds) ? (target.accountIds as string[]) : [];
  const added = accountIds.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !accountIds.includes(id));

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET accountIds = :ids, accountIdsUpdatedAt = :now, accountIdsUpdatedBy = :by',
    ExpressionAttributeValues: {
      ':ids': accountIds,
      ':now': new Date().toISOString(),
      ':by': caller.userId,
    },
  }));

  // Losing sight of an account is as worth knowing as gaining one — otherwise
  // it reads as data disappearing. Sent after the write, best-effort: the
  // change is committed, and a failed send must not report it as failed.
  if (added.length || removed.length) {
    await notifyAccessChange({
      to: target.email as string | undefined,
      memberName: displayName(target.name as string | undefined, (target.email as string) ?? ''),
      actorName: displayName(caller.membership.name, caller.email),
      // The actor is looking at the result on screen; no need to mail them.
      skip: target.email === caller.email,
      tenantName: caller.membership.tenantName ?? 'your CloudMeter account',
      added: added.map((id) => nameOf(accounts, id)),
      removed: removed.map((id) => nameOf(accounts, id)),
      total: accountIds.length,
    });
  }

  return json(200, { userId, accountIds });
};

function nameOf(accounts: Record<string, unknown>[] | undefined, id: string): string {
  const hit = (accounts ?? []).find((a) => a.accountId === id);
  return (hit?.name as string) ?? id;
}

interface AccessChange {
  to?: string;
  memberName: string;
  actorName: string;
  skip: boolean;
  tenantName: string;
  added: string[];
  removed: string[];
  total: number;
}

async function notifyAccessChange(c: AccessChange): Promise<void> {
  const from = process.env.OTP_FROM_EMAIL;
  const portalUrl = process.env.PORTAL_URL;
  if (!c.to || c.skip || !from || !portalUrl) return;

  const list = (names: string[]) => names.join(', ');
  const paragraphs: string[] = [];
  if (c.added.length) {
    paragraphs.push(`${c.actorName} gave you access to ${c.added.length === 1 ? 'a cloud account' : `${c.added.length} cloud accounts`} in ${c.tenantName}: ${list(c.added)}.`);
  }
  if (c.removed.length) {
    paragraphs.push(`${c.actorName} removed your access to ${list(c.removed)}.`);
  }
  paragraphs.push(c.total === 0
    ? 'You no longer have access to any cloud accounts, so CloudMeter will look empty until someone adds you to one.'
    : `You can now see ${c.total} cloud account${c.total === 1 ? '' : 's'} in total.`);

  const title = c.added.length && c.removed.length
    ? 'Your cloud account access has changed'
    : c.added.length
      ? `You have access to ${c.added.length === 1 ? c.added[0] : `${c.added.length} more cloud accounts`}`
      : `Your access to ${c.removed.length === 1 ? c.removed[0] : `${c.removed.length} cloud accounts`} was removed`;

  const mail = {
    title,
    paragraphs,
    ...(c.total > 0
      ? { cta: { label: 'View your cloud accounts', url: `${portalUrl.replace(/\/$/, '')}/accounts.html` } }
      : {}),
  };

  try {
    await ses.send(new SendEmailCommand({
      Source: `CloudMeter <${from}>`,
      Destination: { ToAddresses: [c.to] },
      Message: {
        Subject: { Data: title },
        Body: { Text: { Data: renderEmailText(mail) }, Html: { Data: renderEmailHtml(mail) } },
      },
    }));
  } catch (err) {
    console.error('Access-change email failed', (err as Error).message);
  }
}
