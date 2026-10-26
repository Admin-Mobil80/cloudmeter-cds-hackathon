import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { json, resolveCaller, requireWritable } from '../../../shared/authz';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const userId = event.requestContext.authorizer.jwt.claims.sub as string;

  // These preferences are stored per user, not per tenant, so this handler
  // never needed to resolve a membership before. It does now: the Notifications
  // page is read-only while the workspace someone is *currently in* has lapsed.
  // Resolving the active tenant is the right question to ask — somebody who
  // also belongs to a healthy workspace can switch to it and edit there, rather
  // than one frozen tenant silencing their preferences everywhere.
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  let body: { channels?: unknown; anomaly?: unknown; digest?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }
  if (!body.channels || !body.anomaly || !body.digest) {
    return json(400, { message: 'channels, anomaly, and digest are required' });
  }

  // Send time is an account-level setting, not a personal one: the digest is
  // built once per account per day, so per-person times would have colleagues
  // quoting different "as of" dates for the same day. An older cached page may
  // still post `time`; drop it rather than storing a value nothing honours.
  const { time: _ignoredTime, ...digest } = body.digest as Record<string, unknown>;

  /*
   * The Slack connection is server-owned and must survive this write.
   *
   * It is stored per workspace, while the page is shown — and posts back —
   * only the one workspace it is looking at. Writing `channels` straight from
   * the body would flatten that map to a single entry and silently sever this
   * person's Slack in every other workspace they belong to.
   *
   * Connecting and disconnecting go through /notifications/slack/connect,
   * which is the only writer of this field. Here it is preserved verbatim.
   */
  const { Item: stored } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
  }));
  const storedSlack = (stored?.channels as Record<string, unknown> | undefined)?.slack;
  const channels = { ...(body.channels as Record<string, unknown>) };
  if (storedSlack === undefined) delete channels.slack;
  else channels.slack = storedSlack;

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `USER#${userId}`,
      SK: 'NOTIFPREFS',
      channels,
      anomaly: body.anomaly,
      digest,
      updatedAt: new Date().toISOString(),
    },
  }));

  return json(200, { ...body, channels, digest });
};
