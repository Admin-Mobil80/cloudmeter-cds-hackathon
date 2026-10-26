import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { exchangeOAuthCode, storeTenantToken } from '../../shared/slack';

const PORTAL_URL = process.env.PORTAL_URL ?? '';

/**
 * Where Slack sends somebody after they approve, or decline, the install.
 *
 * Deliberately public — Slack redirects the person's browser here and carries
 * no CloudMeter credentials — which makes `state` the entire security of the
 * flow. It is a random value this backend issued moments earlier against one
 * tenant, stored server-side, single-use and short-lived. Without it anyone
 * could call this endpoint with a code from their own Slack and bind their
 * workspace to another company's CloudMeter, which would send that company's
 * spend to strangers.
 *
 * Nothing is read from the query string except the code and that state. In
 * particular the tenant is never taken from the request: it comes from the
 * stored state and nowhere else.
 */
function back(path: string): APIGatewayProxyResultV2 {
  // A browser landed here, so the answer is a redirect rather than JSON. The
  // portal says what happened; this endpoint has no page of its own.
  return {
    statusCode: 302,
    headers: { Location: `${PORTAL_URL.replace(/\/$/, '')}/notifications.html${path}` },
    body: '',
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const q = event.queryStringParameters ?? {};

  /*
   * They pressed Cancel on Slack's consent screen.
   *
   * An ordinary outcome, not a failure. Sent back quietly rather than to an
   * error page that implies something broke.
   */
  if (q.error) return back('?slack=cancelled');

  const code = typeof q.code === 'string' ? q.code : '';
  const state = typeof q.state === 'string' ? q.state : '';
  if (!code || !state) return back('?slack=failed');

  const Key = { PK: `SLACKSTATE#${state}`, SK: 'STATE' };
  const { Item: pending } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key }));

  // TTL deletion is eventual, so an expired row can still be present. The
  // timestamp decides, not the row's existence.
  const expired = !pending || (pending.expiresAt as number) * 1000 < Date.now();
  if (expired) return back('?slack=expired');

  /*
   * Spent before the exchange, not after.
   *
   * A state that survived a failed exchange could be replayed, and a slow
   * Slack could otherwise let two concurrent callbacks both pass this check.
   * Deleting first costs a retry its state — which is correct: the person
   * starts again rather than the same install landing twice.
   */
  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key }));

  const tenantId = pending.tenantId as string;
  const redirectUri = process.env.SLACK_REDIRECT_URI ?? '';

  try {
    const install = await exchangeOAuthCode(code, redirectUri);
    await storeTenantToken(tenantId, install);
    console.log(`Slack installed for tenant ${tenantId}`, {
      teamId: install.teamId, teamName: install.teamName,
    });
  } catch (err) {
    // The person is mid-flow in a browser; they get told, and the detail goes
    // to the log where it is useful.
    console.error(`Slack install failed for tenant ${tenantId}`, (err as Error).message);
    return back('?slack=failed');
  }

  return back('?slack=installed');
};
