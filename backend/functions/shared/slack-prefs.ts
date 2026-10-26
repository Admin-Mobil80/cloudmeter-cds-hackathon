/**
 * Which Slack conversation one person has, in one workspace.
 *
 * Preferences are stored once per CloudMeter user, which is right for email
 * and WhatsApp: an address and a phone number are the same person wherever
 * they are. Slack is the first channel where that is false. A Slack account
 * exists only inside one Slack workspace, so a DM channel id is meaningful in
 * that workspace and nowhere else.
 *
 * One person can be in many CloudMeter workspaces — neeta@mobil80.com is an
 * Admin in twelve — and each may install its own Slack. Storing one `slack`
 * connection per user meant the second workspace to connect would try to post
 * to a channel belonging to the first. The token cannot reach it, so Slack
 * refuses and the error goes to a log: that person silently stops receiving
 * one workspace's digest while the page still says "Connected".
 *
 * It fails safely — a token can only reach its own workspace, so no spend can
 * land in the wrong Slack — but it fails invisibly, which is worse to find.
 *
 * Hence a connection per workspace, keyed by tenant.
 */

export interface SlackConnection {
  connected: boolean;
  slackUserId?: string;
  dmChannelId?: string;
  connectedAt?: string;
  /** Set when a send failed in a way only a person can fix. */
  disconnectedAt?: string;
  disconnectedReason?: string;
}

interface SlackChannelPrefs {
  workspaces?: Record<string, SlackConnection>;
}

/**
 * This person's Slack connection for one workspace, or null.
 *
 * Deliberately no fallback to a legacy flat `{connected, dmChannelId}` shape.
 * Such a record carries no record of which workspace it belonged to, and
 * guessing would be the original bug wearing a disguise: a channel from one
 * workspace handed to another workspace's token. Stored connections were
 * migrated into the map instead.
 */
export function slackConnection(
  prefs: Record<string, unknown> | undefined,
  tenantId: string,
): SlackConnection | null {
  const channels = prefs?.channels as { slack?: SlackChannelPrefs } | undefined;
  const found = channels?.slack?.workspaces?.[tenantId];
  if (!found?.connected || !found.dmChannelId) return null;
  return found;
}

/**
 * The stored entry for one workspace, whatever state it is in.
 *
 * `slackConnection` answers "can we post?" and is null for a disconnected
 * one — which would throw away the record of *why* it stopped. The page needs
 * that, so it can say "Slack stopped working" rather than the bare "Not
 * connected" a reader would read as their own doing.
 */
export function slackEntry(
  prefs: Record<string, unknown> | undefined,
  tenantId: string,
): SlackConnection | undefined {
  const channels = prefs?.channels as { slack?: SlackChannelPrefs } | undefined;
  return channels?.slack?.workspaces?.[tenantId];
}

/** The DM channel to post in for this workspace, or null. */
export function slackDmChannel(
  prefs: Record<string, unknown> | undefined,
  tenantId: string,
): string | null {
  return slackConnection(prefs, tenantId)?.dmChannelId ?? null;
}

/**
 * The stored Slack preferences with one workspace's connection set or cleared.
 *
 * Merged rather than replaced: a person connected in three workspaces must
 * keep the other two when they change one.
 */
export function withSlackConnection(
  existingChannels: Record<string, unknown> | undefined,
  tenantId: string,
  connection: SlackConnection | null,
): Record<string, unknown> {
  const channels = { ...(existingChannels ?? {}) };
  const slack = (channels.slack as SlackChannelPrefs | undefined) ?? {};
  const workspaces = { ...(slack.workspaces ?? {}) };

  if (connection) workspaces[tenantId] = connection;
  else delete workspaces[tenantId];

  channels.slack = { workspaces };
  return channels;
}

/**
 * The stored preferences with one workspace's Slack marked as broken.
 *
 * Until now a revoked install failed into a CloudWatch log and nowhere else:
 * every digest to that person silently failed, their Notifications page went
 * on saying "Connected", and nobody — not them, not us — found out. That is
 * the shape of the WhatsApp channel that looked connected for eleven people
 * and delivered nothing for weeks.
 *
 * Telling them *in Slack* is impossible; Slack is the thing that is broken.
 * So the connection is marked not-connected, which is what the page reads: it
 * then shows "Not connected" with a Connect button, and reconnecting repairs
 * it. The reason and the time are kept so a support question has an answer.
 *
 * Only for failures a person must fix — a removed app, a revoked token, a
 * deleted conversation. A rate limit or a Slack outage must never disconnect
 * anybody; those simply retry on the next sweep.
 *
 * Pure, so the caller owns the write and this can be tested without one.
 */
export function withSlackBroken(
  existingChannels: Record<string, unknown> | undefined,
  tenantId: string,
  reason: string,
): Record<string, unknown> {
  const slack = (existingChannels?.slack as SlackChannelPrefs | undefined);
  const was = slack?.workspaces?.[tenantId];

  return withSlackConnection(existingChannels, tenantId, {
    connected: false,
    // Kept rather than cleared: reconnecting is one lookup away, and what it
    // used to be is what makes the failure explicable afterwards.
    slackUserId: was?.slackUserId,
    dmChannelId: was?.dmChannelId,
    connectedAt: was?.connectedAt,
    disconnectedAt: new Date().toISOString(),
    disconnectedReason: reason,
  });
}
