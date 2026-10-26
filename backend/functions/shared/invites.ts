import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

export interface InviteSubject {
  userId: string;
  email: string;
  name?: string | null;
}

/**
 * Turns every pending invitation for this email into a real membership.
 *
 * Invites used to be accepted only by the PostConfirmation Cognito trigger,
 * which fires once, on first-ever sign-up. That left two gaps:
 *
 *  - Someone who already had a CloudMeter account could never be invited into
 *    a second one. They sign in rather than sign up, so the trigger never
 *    fires again, the invite sits `pending` forever, and — because the
 *    account switcher only appears with two or more memberships — they have
 *    no way to reach the account they were invited to.
 *  - Someone invited to two accounts before signing up joined only the first,
 *    since the trigger took `invites[0]` and ignored the rest.
 *
 * Accepting every pending invite, from wherever the caller comes, closes
 * both. Safe to call on any authenticated request: a no-op when nothing is
 * pending, and it never overwrites an existing membership, so a re-run can't
 * undo a role change made since the invite was sent.
 *
 * Returns how many new memberships were created.
 */
export async function acceptPendingInvites(subject: InviteSubject): Promise<number> {
  const { userId, email } = subject;
  if (!userId || !email) return 0;

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :email',
    FilterExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':email': `EMAIL#${email}`, ':pending': 'pending' },
  }));

  const invites = Items ?? [];
  if (invites.length === 0) return 0;

  const now = new Date().toISOString();
  let accepted = 0;

  for (const invite of invites) {
    const tenantId = String(invite.PK).replace('TENANT#', '');

    try {
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${tenantId}`,
          SK: `MEMBER#${userId}`,
          GSI1PK: `USER#${userId}`,
          GSI1SK: `TENANT#${tenantId}`,
          userId,
          email,
          name: invite.name ?? subject.name ?? email,
          role: invite.role,
          status: 'active',
          invitedAt: invite.invitedAt ?? now,
          // The cloud accounts chosen when the invite was sent.
          //
          // Members see only the accounts mapped to them, and this was the
          // one field acceptance dropped — so every Member who was invited
          // *with* accounts selected joined mapped to none of them and was
          // shown an empty Cloud Accounts page reading "no cloud accounts
          // connected yet", while the person who invited them saw the
          // selection they had made sitting on the invite.
          //
          // Omitted rather than written as [] when the invite carried none.
          // normalizeAccountIds treats both the same for a Member — no
          // mapping, so nothing visible — so this is only about not storing
          // an attribute that says nothing.
          ...(Array.isArray(invite.accountIds) && invite.accountIds.length
            ? { accountIds: invite.accountIds }
            : {}),
          // Sorted on by getMembershipsForUser, and always later than an
          // existing membership's — so gaining a second account never
          // silently moves someone off the one they were already using.
          joinedAt: now,
          lastActiveAt: now,
        },
        // Already a member: the invite is moot and their current role is the
        // authority, so a stale invite must not rewrite it.
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      accepted += 1;
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    }

    // Marked accepted either way — an invite for someone who is already a
    // member has done its job and should stop showing as outstanding.
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: invite.PK, SK: invite.SK },
      UpdateExpression: 'SET #status = :accepted, acceptedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':accepted': 'accepted', ':now': now },
    }));
  }

  return accepted;
}
