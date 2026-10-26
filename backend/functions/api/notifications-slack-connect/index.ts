import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json, requireWritable, requireNotDemo } from '../../shared/authz';
import { tokenForTenant, findUserByEmail, openDirectMessage, SlackError } from '../../shared/slack';
import { withSlackConnection } from '../../shared/slack-prefs';
import {
  allowedChannels, cheapestPlanWith, type ChannelPlanInput,
} from '../../shared/plan-channels';
import { planById } from '../../shared/plans';

/**
 * Switches Slack on, or off, for the person asking.
 *
 * Unlike WhatsApp there is no code to verify. The workspace has already
 * installed CloudMeter, and Slack is asked to resolve the caller's own email
 * to an account in that workspace — so there is nothing for a typo to
 * subscribe, and no number for a stranger to receive.
 *
 * The DM conversation is opened here rather than at send time. Opening is
 * idempotent and the id is stable, so the daily sweep posts straight to it:
 * a lookup per person per message would be two extra Slack calls on every
 * digest, for an answer that does not change.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller) ?? requireNotDemo(caller);
  if (readOnly) return readOnly;

  let body: { connected?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const prefsKey = { PK: `USER#${caller.userId}`, SK: 'NOTIFPREFS' };
  const { Item: prefs } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: prefsKey }));
  const existing = (prefs?.channels as Record<string, unknown>) ?? {};

  /*
   * Disconnecting must not depend on Slack answering.
   *
   * Someone turning this off may be doing it *because* the workspace removed
   * the app, and an endpoint that called Slack first would fail exactly when
   * it is most needed. Handled before anything else for that reason.
   */
  if (body.connected === false) {
    // Only this workspace's connection. Someone connected in three keeps the
    // other two when they disconnect one.
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: prefsKey,
      UpdateExpression: 'SET channels = :c, updatedAt = :now',
      ExpressionAttributeValues: {
        ':c': withSlackConnection(existing, caller.membership.tenantId, null),
        ':now': new Date().toISOString(),
      },
    }));
    return json(200, { connected: false });
  }

  /*
   * Whether this workspace's plan includes Slack at all.
   *
   * Checked here, after the disconnect branch and before Slack is contacted.
   *
   * After, because someone on a plan without Slack must still be able to turn
   * off a connection they already have — and refusing to let somebody switch
   * something off is worst exactly when they most want to.
   *
   * Before, because without it this endpoint runs a six-step setup for a
   * channel the sweep has already decided not to deliver on: it resolves them
   * in Slack, opens a DM, saves the connection, ticks the digest box, and
   * reports "Connected". Nothing errors, and they find out at the digest hour
   * by receiving nothing. Saying no at the door is the honest version.
   */
  let tenant: Record<string, unknown> = {};
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `TENANT#${caller.membership.tenantId}`,
        SK: `TENANT#${caller.membership.tenantId}`,
      },
    }));
    tenant = Item ?? {};
  } catch (err) {
    // Unreadable tenant means no plan id, which allowedChannels treats as
    // "allow everything" — the same fail-open the sweep uses. A lookup we
    // could not perform must not read as a refusal.
    console.error('Could not read plan before connecting Slack', (err as Error).message);
  }

  if (!allowedChannels(tenant as ChannelPlanInput).has('slack')) {
    const needs = cheapestPlanWith('slack');
    const current = planById(tenant.planId as string | undefined);
    return json(409, {
      // Names the plan that would grant it, taken from the catalogue rather
      // than written here, so this cannot recommend a tier that no longer
      // includes Slack.
      message: needs
        ? `Slack notifications are included on the ${needs.name} plan.`
          + `${current ? ` Your workspace is on ${current.name}.` : ''}`
          + ' Ask an Owner to upgrade, or use email and WhatsApp.'
        : 'Slack notifications are not included on any current plan.',
      needsUpgrade: true,
      requiredPlan: needs?.id ?? null,
    });
  }

  const token = await tokenForTenant(caller.membership.tenantId);
  if (!token) {
    return json(409, {
      message: 'This workspace has not connected Slack yet. An Owner or Admin needs to install CloudMeter in your Slack first.',
      needsInstall: true,
    });
  }

  // The address CloudMeter knows them by, which is what Slack is asked to
  // match. It comes off the verified identity rather than anything submitted.
  const email = caller.email;
  if (!email) return json(400, { message: 'No email address on your account to match in Slack.' });

  let slackUserId: string | null;
  try {
    slackUserId = await findUserByEmail(token, email);
  } catch (err) {
    // The workspace's install is broken rather than this person's request.
    if (err instanceof SlackError && err.needsReconnect) {
      return json(409, {
        message: 'CloudMeter\'s access to your Slack has been removed. An Owner or Admin needs to reinstall it.',
        needsInstall: true,
      });
    }
    throw err;
  }

  /*
   * No Slack account on that address.
   *
   * Common and not a fault: people sign in to Slack with a personal address,
   * or joined before a domain change. Said plainly, because the alternative is
   * a channel that looks connected and silently never delivers — which is what
   * the WhatsApp digests did for eleven people.
   */
  if (!slackUserId) {
    return json(404, {
      message: `No Slack account in this workspace uses ${email}. Ask an admin to add that address to your Slack profile, or use the address your Slack account is under.`,
      noSlackAccount: true,
    });
  }

  const dmChannelId = await openDirectMessage(token, slackUserId);

  // Merged into whatever preferences already exist: this endpoint knows about
  // the Slack channel and nothing else, and must not flatten the user's
  // anomaly or digest settings on the way past.
  /*
   * Stored against this workspace, not against the person.
   *
   * A DM channel exists inside one Slack workspace. The same CloudMeter user
   * may be in several workspaces with their own Slacks, so one connection per
   * person would hand the second workspace a channel belonging to the first.
   */
  const channels = withSlackConnection(existing, caller.membership.tenantId, {
    connected: true, slackUserId, dmChannelId, connectedAt: new Date().toISOString(),
  });

  /*
   * Ticking the digest channel as well as connecting.
   *
   * Connecting is the opt-in — nobody clicks Connect Slack and expects to then
   * hunt for a second switch. The existing list is preserved, so email is not
   * silently turned off by gaining Slack.
   */
  const digest = (prefs?.digest as { enabled?: boolean; channels?: string[] }) ?? {};
  const digestChannels = Array.isArray(digest.channels) ? digest.channels : ['email'];
  const withSlack = digestChannels.includes('slack') ? digestChannels : [...digestChannels, 'slack'];

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: prefsKey,
    UpdateExpression: 'SET channels = :c, digest = :d, updatedAt = :now',
    ExpressionAttributeValues: {
      ':c': channels,
      ':d': { ...digest, enabled: digest.enabled !== false, channels: withSlack },
      ':now': new Date().toISOString(),
    },
  }));

  return json(200, { connected: true, slackUserId });
};
