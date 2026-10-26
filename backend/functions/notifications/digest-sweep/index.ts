import { ScanCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { isDigestDue, normalizeTimezone } from '../../shared/schedule';
import { buildDigest, Digest } from '../../shared/digest';
import { accountNotificationsOn, unmutedAccounts } from '../../shared/alert-notify';
import { sendDigestEmail } from '../../shared/digest-email';
import { sendDigestWhatsApp } from '../../shared/digest-whatsapp';
import { sendDigestSlack } from '../../shared/digest-slack';
import { slackDmChannel, withSlackBroken } from '../../shared/slack-prefs';
import {
  allowedChannels, gateChannels, type Channel, type ChannelPlanInput,
} from '../../shared/plan-channels';
import { SlackError } from '../../shared/slack';
import { syncFrozen } from '../../shared/subscription-period';

const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const PORTAL_URL = process.env.PORTAL_URL!;

interface SweepResult {
  tenantsChecked: number;
  due: number;
  sent: number;
  whatsappSent: number;
  slackSent: number;
  /** Installs found dead while sending, and marked for reconnection. */
  slackDisconnected: number;
  /**
   * Channels someone had ticked that their workspace's plan does not include.
   *
   * Counted and logged rather than passed over in silence: a plan limit that
   * removes a channel looks identical, from the outside, to a channel that has
   * broken. Somebody must be able to tell the two apart.
   */
  planBlocked: number;
  /** People left with no channel at all once the plan was applied. */
  planSilenced: number;
  skipped: Array<{ tenant: string; reason: string }>;
}

interface Recipient {
  email: string | null;
  /** Verified WhatsApp number, or null if the channel isn't set up. */
  whatsapp: string | null;
  /** The DM channel to post in, for someone who connected Slack. */
  slack: string | null;
  /** Who this is, so a dead Slack can be marked against them. */
  userId: string;
  /**
   * null = sees the whole tenant (Owner, Admin). A list = a Member, who gets
   * one digest per account instead — mailing them a combined total would hand
   * over exactly the roll-up the dashboard withholds.
   */
  visibleAccountIds: string[] | null;
  /** Their stored preferences, for the per-account switches a Member sets. */
  prefs?: Record<string, unknown>;
}

/**
 * Runs hourly. Finds the tenants whose local digest hour it currently is and
 * emails them a summary of the last complete day.
 *
 * Hourly-and-check rather than one schedule per tenant: a per-tenant schedule
 * would need creating on signup, rewriting whenever someone changes timezone,
 * and deleting on account closure — three lifecycle hooks, each of which can
 * leave an orphan behind. This has none.
 */
export const handler = async (): Promise<SweepResult> => {
  const now = new Date();
  const result: SweepResult = {
    tenantsChecked: 0, due: 0, sent: 0, whatsappSent: 0, slackSent: 0, slackDisconnected: 0,
    planBlocked: 0, planSilenced: 0,
    skipped: [],
  };

  for (const tenant of await allTenants()) {
    result.tenantsChecked += 1;
    const tenantId = tenant.tenantId as string;
    const name = (tenant.name as string) ?? 'your CloudMeter account';

    // A digest reports figures that stopped moving when the sweep stopped
    // refreshing them, so sending one would mail the same numbers every
    // evening and read as a product that had quietly broken. Checked before
    // isDigestDue so a frozen tenant is reported as frozen rather than as
    // "not the digest hour here".
    const freeze = syncFrozen(tenant);
    if (freeze) {
      result.skipped.push({ tenant: name, reason: `subscription ${freeze}` });
      continue;
    }

    const { due, localDate, reason } = isDigestDue(
      {
        timezone: tenant.timezone as string | undefined,
        digestHour: tenant.digestHour as number | undefined,
        lastDigestDate: tenant.lastDigestDate as string | undefined,
      },
      now,
    );
    if (!due) continue;
    result.due += 1;

    try {
      const digest = await buildDigest(tenantId, name, normalizeTimezone(tenant.timezone), now);
      if (!digest) {
        // No accounts, or nothing recent enough to summarise. Still stamp the
        // date so we don't retry this tenant every hour for the rest of the day.
        await stampSent(tenantId, localDate);
        result.skipped.push({ tenant: name, reason: 'no reportable cost data' });
        continue;
      }

      /*
       * The plan decides which channels may be used, which is new: the
       * catalogue has carried a `channels` list per plan since the plans were
       * written and nothing ever read it.
       *
       * Applied here, against the tenant record the sweep already holds, so it
       * costs no extra read. A channel a workspace is grandfathered into
       * survives regardless of the plan — see shared/plan-channels.
       */
      const allowed = allowedChannels(tenant as ChannelPlanInput);
      const recipients = await digestRecipients(tenantId, allowed, name, result);
      const accounts = await tenantAccountNames(tenantId);
      if (recipients.length === 0) {
        await stampSent(tenantId, localDate);
        result.skipped.push({ tenant: name, reason: 'no one has digests enabled' });
        continue;
      }

      // Stamped before sending, not after: a partial send followed by a crash
      // must not re-mail everyone who already received it on the next sweep.
      await stampSent(tenantId, localDate);

      // Channels are settled independently. A WhatsApp failure — a blocked
      // number, a template hiccup — must not cost someone their email digest,
      // and vice versa.
      const jobs: Array<{
        label: string;
        channel: 'email' | 'whatsapp' | 'slack';
        run: Promise<unknown>;
        /** Present on Slack jobs, so a dead install can be marked. */
        recipient?: Recipient;
      }> = [];
      for (const r of recipients) {
        // Owners and Admins get the organisation's roll-up. A Member gets one
        // digest per cloud account they hold, each headed with that account's
        // name — a combined figure would be a roll-up across accounts, which
        // is the thing their role deliberately doesn't grant.
        const theirDigests: Digest[] = [];
        if (r.visibleAccountIds === null) {
          // A muted account is left out of the roll-up rather than costing
          // them the digest: someone silencing one noisy account still wants
          // to hear about the rest. Rebuilt only when something is actually
          // muted, so the common case keeps using the digest built once for
          // the whole tenant.
          const wanted = unmutedAccounts(r.prefs, [...accounts.keys()], 'digest');
          if (wanted.length === accounts.size) {
            theirDigests.push(digest);
          } else if (wanted.length > 0) {
            const some = await buildDigest(
              tenantId, name, normalizeTimezone(tenant.timezone), now, wanted,
            );
            if (some) theirDigests.push(some);
          }
          // Everything muted: nothing to say, and saying it anyway is the bug
          // this replaced.
        } else {
          for (const accountId of r.visibleAccountIds) {
            if (!accountNotificationsOn(r.prefs, accountId, 'digest')) continue;
            const one = await buildDigest(
              tenantId, name, normalizeTimezone(tenant.timezone), now, [accountId],
            );
            // Nothing to report on that account — silence beats an empty summary.
            if (!one) continue;
            theirDigests.push({
              ...one,
              // Names the account in the subject line and the WhatsApp header,
              // which otherwise only ever say the organisation.
              tenantName: accountLabel(accounts, accountId, name),
            });
          }
        }

        for (const theirs of theirDigests) {
          if (r.email) {
            jobs.push({
              label: r.email,
              channel: 'email',
              run: sendDigestEmail(theirs, { email: r.email, portalUrl: PORTAL_URL, fromEmail: FROM_EMAIL }),
            });
          }
          if (r.whatsapp) {
            jobs.push({ label: r.whatsapp, channel: 'whatsapp', run: sendDigestWhatsApp(theirs, r.whatsapp) });
          }
          if (r.slack) {
            jobs.push({
              label: r.slack,
              channel: 'slack',
              run: sendDigestSlack(theirs, tenantId, r.slack, PORTAL_URL),
              recipient: r,
            });
          }
        }
      }

      /*
       * Slack installs that have gone away, collected while sending.
       *
       * Written after the sends rather than inside the loop: marking a person
       * mid-flight would have the next job for them read a half-updated
       * record, and a write per failure would hammer the table during the
       * storm that a dead install produces.
       */
      const broken: Array<{ recipient: Recipient; reason: string }> = [];

      const outcomes = await Promise.allSettled(jobs.map((j) => j.run));
      outcomes.forEach((o, i) => {
        if (o.status === 'fulfilled') {
          // One counter per channel, and `sent` counts email only. Written as
          // a chain rather than separate ifs: an `else` that silently attaches
          // to the wrong `if` double-counts every WhatsApp send as an email.
          if (jobs[i].channel === 'whatsapp') result.whatsappSent += 1;
          else if (jobs[i].channel === 'slack') result.slackSent += 1;
          else result.sent += 1;
        } else {
          console.error(`Digest via ${jobs[i].channel} to ${jobs[i].label} failed`, o.reason);
          /*
           * A Slack install that is gone, rather than a bad minute.
           *
           * Marked not-connected so the person's Notifications page says so
           * and offers a Connect button. Before this the send failed into
           * this log line alone: the page kept saying "Connected", every
           * later digest failed the same way, and nobody found out.
           *
           * Deliberately only for failures a person must fix. A rate limit or
           * an outage retries on the next sweep and must not disconnect
           * anybody.
           */
          const dead = o.reason instanceof SlackError && o.reason.needsReconnect;
          if (dead && jobs[i].recipient) {
            broken.push({ recipient: jobs[i].recipient!, reason: (o.reason as SlackError).code });
          }
        }
      });
      for (const { recipient, reason } of broken) {
        try {
          const { Item: prefs } = await ddb.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${recipient.userId}`, SK: 'NOTIFPREFS' },
          }));
          await ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${recipient.userId}`, SK: 'NOTIFPREFS' },
            UpdateExpression: 'SET channels = :c, updatedAt = :now',
            ExpressionAttributeValues: {
              ':c': withSlackBroken(prefs?.channels as Record<string, unknown>, tenantId, reason),
              ':now': new Date().toISOString(),
            },
          }));
          result.slackDisconnected += 1;
          console.error(
            `Slack marked not-connected for user ${recipient.userId} in tenant ${tenantId}: ${reason}`,
          );
        } catch (markErr) {
          // Failing to record it must not fail the sweep; the log still has it.
          console.error('Could not mark Slack as broken', (markErr as Error).message);
        }
      }
    } catch (err) {
      // One tenant's bad data must not stop every later tenant's digest.
      console.error(`Digest failed for tenant ${tenantId}`, (err as Error).message);
      result.skipped.push({ tenant: name, reason: (err as Error).message });
    }
  }

  console.log('Digest sweep', JSON.stringify(result));
  return result;
};

/**
 * Every tenant record.
 *
 * A Scan, because tenant items have no index of their own — they're identified
 * by PK === SK. Fine at this size and it runs once an hour, but it's the first
 * thing to outgrow the design: past a few thousand tenants this wants a sparse
 * GSI keyed on the digest hour so each sweep reads only the tenants it needs.
 */
async function allTenants(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :t) AND attribute_exists(tenantId)',
      ExpressionAttributeValues: { ':t': 'TENANT#' },
      // The subscription fields feed syncFrozen; none of them is a reserved
      // word, so only `name` and `timezone` still need aliasing.
      ProjectionExpression: 'tenantId, #n, #tz, digestHour, lastDigestDate, planId, '
        + 'currentPeriodEnd, trialEndsAt, createdAt, subscriptionStatus',
      ExpressionAttributeNames: { '#n': 'name', '#tz': 'timezone' },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return out;
}

/**
 * Members who want the daily digest, and on which channels.
 *
 * Preferences are per user, so one person opting out doesn't silence the team.
 * A member with no stored preferences gets email — digests default to on, and
 * every email carries a link to turn them off. WhatsApp is the opposite: it is
 * only ever used for a number the user verified and a channel they ticked,
 * because an unwanted WhatsApp gets the sender blocked outright.
 */
async function digestRecipients(
  tenantId: string,
  allowed: Set<Channel>,
  tenantName: string,
  result: SweepResult,
): Promise<Recipient[]> {
  const { Items: members } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MEMBER#' },
  }));

  const wanted = await Promise.all((members ?? []).map(async (m): Promise<Recipient | null> => {
    const email = m.email as string | undefined;
    if (!email || m.status !== 'active') return null;

    const { Item: prefs } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${m.userId}`, SK: 'NOTIFPREFS' },
    }));

    const digest = prefs?.digest as { enabled?: boolean; channels?: string[] } | undefined;
    if (digest?.enabled === false) return null;

    const ticked = Array.isArray(digest?.channels) ? digest!.channels : ['email'];

    /*
     * What the plan permits of what they asked for.
     *
     * The withheld ones are logged with the person and the workspace named,
     * because this is the one failure mode that produces no error anywhere: a
     * channel they ticked, that used to work, simply stops. Somebody asking
     * "why did my WhatsApp digest stop?" needs an answer that exists.
     */
    const { kept: channels, blocked } = gateChannels(ticked, allowed);
    if (blocked.length) {
      result.planBlocked += blocked.length;
      const silenced = channels.length === 0;
      if (silenced) result.planSilenced += 1;
      console.warn(
        `Digest channels withheld by plan for ${email} in ${tenantName}: `
        + `${blocked.join(', ')}${silenced ? ' — this leaves them with no channel at all' : ''}`,
      );
    }

    const wa = (prefs?.channels as { whatsapp?: { connected?: boolean; phone?: string } } | undefined)?.whatsapp;
    /*
     * Slack, on the same terms as WhatsApp: only to someone who connected it
     * and ticked the channel. Looked up per workspace — a DM channel belongs
     * to one Slack workspace and means nothing in another, and this person may
     * be in several CloudMeter workspaces with their own Slacks.
     */
    const slackDm = slackDmChannel(prefs as Record<string, unknown> | undefined, tenantId);

    return {
      email: channels.includes('email') ? email : null,
      whatsapp: channels.includes('whatsapp') && wa?.connected && wa.phone ? wa.phone : null,
      slack: channels.includes('slack') ? slackDm : null,
      userId: m.userId as string,
      visibleAccountIds: m.role === 'member'
        ? (Array.isArray(m.accountIds) ? (m.accountIds as string[]) : [])
        : null,
      prefs: prefs as Record<string, unknown> | undefined,
    };
  }));

  return wanted.filter((r): r is Recipient => !!r && (!!r.email || !!r.whatsapp || !!r.slack));
}

async function stampSent(tenantId: string, localDate: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    UpdateExpression: 'SET lastDigestDate = :d, lastDigestAt = :now',
    ExpressionAttributeValues: { ':d': localDate, ':now': new Date().toISOString() },
  }));
}

/** accountId -> display name, for labelling a Member's per-account digest. */
async function tenantAccountNames(tenantId: string): Promise<Map<string, string>> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: 'accountId, #n',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'ACCOUNT#' },
  }));
  return new Map((Items ?? []).map((a) => [a.accountId as string, a.name as string]));
}

function accountLabel(accounts: Map<string, string>, accountId: string, tenantName: string): string {
  const name = accounts.get(accountId);
  return name ? `${tenantName} · ${name}` : tenantName;
}
