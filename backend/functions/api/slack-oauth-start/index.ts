import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json, requireRole, requireWritable } from '../../shared/authz';
import { slackConfig } from '../../shared/slack';

/** The scopes the digest and alerts need, and nothing beyond them. */
const SCOPES = ['chat:write', 'im:write', 'users:read', 'users:read.email'].join(',');

/**
 * How long an install may sit half-finished.
 *
 * Long enough to read Slack's consent screen and pick a workspace; short
 * enough that a state left in a browser tab overnight is useless to anybody.
 */
const STATE_TTL_SECONDS = 15 * 60;

/**
 * Begins installing CloudMeter into a workspace's Slack.
 *
 * Returns the URL to send the person to rather than redirecting: the caller is
 * a signed-in page making an authenticated request, and a 302 on an XHR is
 * neither followed usefully nor visible to the user.
 *
 * The `state` is the security of this whole flow. Slack hands it back on the
 * callback, which is a public endpoint — without it, anyone could call that
 * callback with their own code and bind their Slack to somebody else's
 * CloudMeter workspace. It is random, single-use, short-lived, and the only
 * thing that says which tenant an install belongs to.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  /*
   * Owners and Admins only.
   *
   * Installing grants CloudMeter the right to post into the company's Slack
   * and to read its member list — a decision about the organisation, not a
   * personal preference. A Member connecting *themselves* is the separate,
   * unrestricted endpoint.
   */
  const wrongRole = requireRole(caller, ['owner', 'admin']);
  if (wrongRole) return wrongRole;

  const { clientId } = await slackConfig();
  if (!clientId) {
    /*
     * About CloudMeter, not about this workspace.
     *
     * The first wording — "Slack is not configured on this CloudMeter yet" —
     * printed under a channel row reading "Connected" and read as a denial
     * that the workspace's own Slack worked. It is CloudMeter's app
     * credentials that are missing, which is nothing the customer can fix.
     */
    return json(503, {
      message: "Slack installs aren't switched on yet — CloudMeter's own Slack app isn't finished being set up. Nothing to do with your workspace.",
    });
  }

  const redirectUri = process.env.SLACK_REDIRECT_URI;
  if (!redirectUri) return json(503, { message: 'Slack redirect URI is not configured.' });

  const state = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `SLACKSTATE#${state}`,
      SK: 'STATE',
      tenantId: caller.membership.tenantId,
      startedBy: caller.userId,
      createdAt: new Date().toISOString(),
      // TTL deletion is eventual, so the callback checks this value too rather
      // than trusting the row's absence to mean expired.
      expiresAt: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    },
  }));

  const url = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  })}`;

  return json(200, { url });
};
