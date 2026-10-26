import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { tokenForTenant } from '../../../shared/slack';
import { slackConnection, slackEntry } from '../../../shared/slack-prefs';
import {
  allowedChannels, channelUpgrades, type ChannelPlanInput,
} from '../../../shared/plan-channels';

const DEFAULT_PREFS = {
  channels: {
    slack: { connected: false, channel: null },
    whatsapp: { connected: false, phone: null },
  },
  anomaly: { severity: 'critical_serious', threshold: 10, channels: ['email'] },
  // No `time`: when the digest is sent is an account-level setting (see
  // Settings → Timezone & daily digest), not a per-user one.
  digest: { enabled: true, channels: ['email'] },
};

/** Older records may carry a per-user send time that nothing reads any more. */
function stripTime(digest: unknown): Record<string, unknown> | null {
  if (!digest || typeof digest !== 'object') return null;
  const { time: _ignored, ...rest } = digest as Record<string, unknown>;
  return rest;
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const userId = event.requestContext.authorizer.jwt.claims.sub as string;

  const [{ Item }, caller] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
    })),
    resolveCaller(event),
  ]);

  /*
   * Whether this workspace has Slack set up at all.
   *
   * Preferences are per user; this is about the whole tenant, and the page
   * needs both. Without it the Notifications page offered "Install CloudMeter
   * in your Slack" to a workspace already using Slack — printed directly under
   * a channel row reading "Connected", which is a flat contradiction.
   *
   * Deliberately a boolean. The token itself must never leave the backend, and
   * the page has no use for anything but the answer.
   */
  let slackWorkspaceReady = false;
  if (caller) {
    try {
      slackWorkspaceReady = !!(await tokenForTenant(caller.membership.tenantId));
    } catch (err) {
      // Preferences must still load; the page falls back to offering the
      // install, which is the harmless direction to be wrong in.
      console.error('Could not check Slack workspace state', (err as Error).message);
    }
  }

  /*
   * Which channels this workspace's plan actually entitles it to.
   *
   * The sweep now enforces this, and without telling the page, a ticked
   * channel that the plan withholds would be a switch that stays on and
   * delivers nothing — indistinguishable from a broken integration, and the
   * exact failure the Slack disconnect reason was added to end.
   *
   * Read-only and advisory: enforcement lives in the sweep, where the sending
   * happens. An unreadable tenant leaves this permissive, matching
   * `allowedChannels` itself.
   */
  let allowed: string[] = ['email', 'whatsapp', 'slack'];
  /*
   * For each withheld channel, the plan that would grant it — `{slack:
   * 'Scale'}`. Sent rather than written into the page so the tier named on
   * screen comes from the same catalogue the sweep enforces.
   */
  let upgrades: Record<string, string> = {};
  if (caller) {
    try {
      const { Item: tenant } = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `TENANT#${caller.membership.tenantId}`,
          SK: `TENANT#${caller.membership.tenantId}`,
        },
      }));
      const set = allowedChannels(tenant as ChannelPlanInput);
      allowed = [...set];
      upgrades = channelUpgrades(set);
    } catch (err) {
      console.error('Could not read plan for channel entitlement', (err as Error).message);
    }
  }

  if (!Item) return json(200, {
    ...DEFAULT_PREFS, slackWorkspaceReady, allowedChannels: allowed, channelUpgrades: upgrades,
  });

  /*
   * The page is looking at one workspace, so it is shown that workspace's
   * Slack connection rather than the whole per-workspace map. Flattened here
   * so the browser never holds, and so cannot write back, somebody's
   * connections to other workspaces.
   */
  const here = caller ? slackConnection(Item, caller.membership.tenantId) : null;
  /*
   * Why a connection stopped working, where there is a reason.
   *
   * A send that proved the install dead turns the connection off. Showing the
   * bare "Not connected" that results would read as the person's own doing,
   * and leave them with no idea their digests had been failing — which is the
   * silence this whole change exists to end.
   */
  const stored = caller ? slackEntry(Item, caller.membership.tenantId) : undefined;
  const channels = {
    ...(Item.channels as Record<string, unknown> ?? DEFAULT_PREFS.channels),
    slack: here ?? {
      connected: false,
      ...(stored?.disconnectedReason
        ? { disconnectedReason: stored.disconnectedReason, disconnectedAt: stored.disconnectedAt }
        : {}),
    },
  };

  return json(200, {
    channels,
    anomaly: Item.anomaly ?? DEFAULT_PREFS.anomaly,
    digest: stripTime(Item.digest) ?? DEFAULT_PREFS.digest,
    slackWorkspaceReady,
    allowedChannels: allowed,
    channelUpgrades: upgrades,
  });
};
