import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, Caller, requireWritable } from '../../../shared/authz';
import { sendRoleChangeEmail, TeamRole } from '../../../shared/role-change-email';
import { displayName } from '../../../shared/email-layout';

const MAX_NAME_LENGTH = 80;

// Two different edits behind one route, with two different bars:
//   role — owner only, since it decides what someone can do.
//   name — owner or admin, since it is only how the person is labelled on
//          this account's roster. Names arrive from whatever was typed on the
//          invite, or from the local part of an email address when someone
//          signs themselves up, so a team list left alone drifts into a mix of
//          "Neeta Kumar" and "ranjitm". Tidying that shouldn't need the owner.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return json(400, { message: 'userId is required' });

  let body: { role?: unknown; name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }
  if (body.role === undefined && body.name === undefined) {
    return json(400, { message: 'Nothing to update' });
  }

  const key = { PK: `TENANT#${caller.membership.tenantId}`, SK: `MEMBER#${targetUserId}` };
  const { Item: target } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (!target) return json(404, { message: 'Member not found' });

  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let roleChangedTo: TeamRole | null = null;

  if (body.role !== undefined) {
    if (caller.membership.role !== 'owner') {
      return json(403, { message: 'Only the owner can change roles.' });
    }
    if (!['admin', 'member'].includes(body.role as string)) {
      return json(400, { message: 'role must be admin or member' });
    }
    if (target.role === 'owner') return json(400, { message: "Can't change the owner's role" });
    // Only a real change is worth a write and, below, an email. Re-saving the
    // role someone already has shouldn't tell them it changed.
    if (body.role !== target.role) roleChangedTo = body.role as TeamRole;
    sets.push('#role = :role');
    names['#role'] = 'role';
    values[':role'] = body.role;
  }

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return json(400, { message: 'Enter a name.' });
    if (name.length > MAX_NAME_LENGTH) {
      return json(400, { message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }
    // #name — "name" is a DynamoDB reserved word.
    sets.push('#name = :name');
    names['#name'] = 'name';
    values[':name'] = name;
  }

  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));

  // After the write, so a mail can never describe a change that didn't land.
  if (roleChangedTo) {
    await notifyRoleChange(caller, {
      email: target.email as string | undefined,
      name: target.name as string | undefined,
      previousRole: target.role as TeamRole,
      newRole: roleChangedTo,
    });
  }

  return json(200, {
    id: targetUserId,
    role: Attributes?.role ?? null,
    name: Attributes?.name ?? null,
  });
};

/**
 * Best-effort: the role is already changed by the time this runs, so a mail
 * that won't send must not turn a successful request into a failed one. The
 * owner would retry, and the retry would be a no-op that no longer even counts
 * as a change.
 */
async function notifyRoleChange(
  caller: Caller,
  target: { email?: string; name?: string; previousRole: TeamRole; newRole: TeamRole },
): Promise<void> {
  // A pending invitee has no address on the membership yet, and nobody to read
  // it — their role is settled when they accept.
  if (!target.email) return;

  const from = process.env.OTP_FROM_EMAIL;
  const portalUrl = process.env.PORTAL_URL;
  if (!from || !portalUrl) {
    console.error('Role-change email not configured; skipping', { from: !!from, portalUrl: !!portalUrl });
    return;
  }

  try {
    const { Item: tenant } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `TENANT#${caller.membership.tenantId}` },
    }));

    await sendRoleChangeEmail({
      toEmail: target.email,
      toName: displayName(target.name, target.email),
      previousRole: target.previousRole,
      newRole: target.newRole,
      actorName: displayName(caller.membership.name, caller.email),
      tenantName: (tenant?.name as string) ?? 'your CloudMeter account',
      portalUrl,
      fromEmailAddress: from,
    });
  } catch (err) {
    console.error('Failed to send role-change email', (err as Error).message);
  }
}
