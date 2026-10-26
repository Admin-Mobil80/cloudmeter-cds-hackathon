import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ScanCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveBmsCaller, json } from '../../../shared/bms';
import { planById } from '../../../shared/plans';
import { trialEndFrom } from '../../../shared/subscription-period';
import { statusGrantsAccess } from '../../../shared/subscription';
import { slackDmChannel } from '../../../shared/slack-prefs';

const secrets = new SecretsManagerClient({});

/**
 * Every CloudMeter account on the platform, with the numbers needed to decide
 * whether it is healthy and what it should be paying.
 *
 * A Scan, because tenant items are identified by PK === SK and have no index
 * of their own. Fine at this size and this is a staff console, not a hot path,
 * but it is the first thing to outgrow the design.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  const tenants: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :t) AND PK = SK',
      ExpressionAttributeValues: { ':t': 'TENANT#' },
      ExclusiveStartKey,
    }));
    tenants.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  /*
   * Which workspaces have CloudMeter installed in their Slack.
   *
   * One listing rather than a describe per tenant: the names carry the tenant
   * id, so a single page of results answers it for everybody. Secrets Manager
   * being unreachable must not take the whole console down — Slack is one
   * column on a page about subscriptions and spend — so a failure here leaves
   * the column unknown rather than throwing.
   */
  const slackInstalled = new Set<string>();
  let slackReadable = true;
  try {
    let NextToken: string | undefined;
    do {
      const page = await secrets.send(new ListSecretsCommand({
        Filters: [{ Key: 'name', Values: ['cloudmeter/slack/tenant/'] }],
        MaxResults: 100,
        NextToken,
      }));
      for (const sec of page.SecretList ?? []) {
        const id = (sec.Name ?? '').split('/').pop();
        if (id) slackInstalled.add(id);
      }
      NextToken = page.NextToken;
    } while (NextToken);
  } catch (err) {
    slackReadable = false;
    console.error('Could not list Slack installs', (err as Error).message);
  }

  const rows = await Promise.all(tenants.map(async (t) => {
    const tenantId = String(t.PK).replace('TENANT#', '');

    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ProjectionExpression: 'SK, #n, spend, dataSource, #st, email, #r, lastActiveAt, userId',
      ExpressionAttributeNames: { '#n': 'name', '#st': 'status', '#r': 'role' },
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}` },
    }));

    const items = Items ?? [];
    const accounts = items.filter((i) => String(i.SK).startsWith('ACCOUNT#'));
    const members = items.filter((i) => String(i.SK).startsWith('MEMBER#'));
    const owner = members.find((m) => m.role === 'owner');

    /*
     * How many people in this workspace actually receive Slack.
     *
     * Preferences are per user, so this is a read each — done only where the
     * workspace has an install, which is a handful of tenants rather than all
     * of them. "Installed but nobody connected" is a real and useful state:
     * it is what a workspace looks like after an admin sets Slack up and
     * nobody follows through.
     */
    const installed = slackInstalled.has(tenantId);
    let slackMembers = 0;
    if (installed) {
      const prefs = await Promise.all(members.map(async (m) => {
        const { Item } = await ddb.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${m.userId}`, SK: 'NOTIFPREFS' },
        }));
        return Item;
      }));
      slackMembers = prefs.filter((pr) => !!slackDmChannel(pr, tenantId)).length;
    }

    const subscription = {
      planId: (t.planId as string) ?? null,
      status: (t.subscriptionStatus as string) ?? null,
      currentPeriodEnd: (t.currentPeriodEnd as string) ?? null,
      // Derived for accounts created before trials carried a stored date, so
      // the list can show every account's clock rather than only the newer ones.
      trialEndsAt: (t.trialEndsAt as string) ?? trialEndFrom(t.createdAt as string) ?? null,
      stripeCustomerId: (t.stripeCustomerId as string) ?? null,
      // Set by hand from this console rather than by Stripe, for accounts
      // onboarded outside it. Surfaced so nobody mistakes one for the other.
      manual: t.subscriptionSource === 'bms',
    };

    return {
      tenantId,
      name: (t.name as string) ?? null,
      createdAt: (t.createdAt as string) ?? null,
      timezone: (t.timezone as string) ?? null,
      ownerEmail: (owner?.email as string) ?? null,
      ownerName: (owner?.name as string) ?? null,
      members: members.length,
      cloudAccounts: accounts.length,
      liveAccounts: accounts.filter((a) => a.dataSource === 'live').length,
      // Live accounts only. Sample data is generated for demos and counting
      // it would overstate what CloudMeter actually monitors — the number
      // every tier and every commercial conversation rests on.
      managedSpendUsd: accounts
        .filter((a) => a.dataSource === 'live')
        .reduce((s, a) => s + ((a.spend as number) ?? 0), 0),
      sampleAccounts: accounts.filter((a) => a.dataSource !== 'live').length,
      lastActiveAt: members
        .map((m) => (m.lastActiveAt as string) ?? '')
        .sort()
        .pop() || null,
      slack: {
        // null rather than false where Secrets Manager could not be read, so
        // the console can say "unknown" instead of claiming nobody has it.
        installed: slackReadable ? installed : null,
        connectedMembers: slackMembers,
      },
      subscription: {
        ...subscription,
        planName: planById(subscription.planId)?.name ?? null,
        entitled: statusGrantsAccess(subscription.status),
      },
    };
  }));

  // Busiest first: the accounts worth looking at are the ones with spend.
  rows.sort((a, b) => b.managedSpendUsd - a.managedSpendUsd);

  return json(200, { tenants: rows, viewer: caller.user });
};
