import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, requireOrgScope, json } from '../../shared/authz';

interface RegionRow {
  name: string;
  displayName: string;
  spend: number;
  pct: number;
  providers: string[];
  accountCount: number;
  /** Which accounts run there, so a region can be opened up. */
  accounts: Array<{ accountId: string; accountName: string; spend: number }>;
}

/**
 * Tenant-wide current-month spend per data-centre location.
 *
 * Region identifiers are provider-scoped, not global: AWS `ap-south-1` and
 * Alibaba `ap-south-1` are different companies' data centres, and Azure calls
 * roughly the same place `centralindia`. So rows are keyed by provider *and*
 * region rather than merged on the code, which would silently add together
 * unrelated locations.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const outOfScope = requireOrgScope(caller);
  if (outOfScope) return outOfScope;

  const { Items: accounts } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ACCOUNT#' },
  }));

  const accountList = accounts ?? [];

  const perAccount = await Promise.all(accountList.map(async (a) => {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':sk': 'MONTHLY#' },
      ScanIndexForward: false,
      Limit: 1,
    }));
    return {
      provider: a.provider as string,
      accountId: a.accountId as string,
      accountName: a.name as string,
      current: Items?.[0],
    };
  }));

  const byKey = new Map<string, RegionRow>();
  let total = 0;

  for (const { provider, accountId, accountName, current } of perAccount) {
    const regions = (current?.regionBreakdown ?? []) as Array<{
      name?: string; displayName?: string; spend?: number;
    }>;
    for (const r of regions) {
      const spend = r.spend ?? 0;
      if (spend <= 0) continue;
      const key = `${provider}::${r.name ?? 'unknown'}`;
      const row = byKey.get(key) ?? {
        name: r.name ?? 'unknown',
        displayName: r.displayName ?? r.name ?? 'Unknown',
        spend: 0,
        pct: 0,
        providers: [provider],
        accountCount: 0,
        accounts: [],
      };
      row.spend += spend;
      row.accountCount += 1;
      row.accounts.push({ accountId, accountName, spend });
      byKey.set(key, row);
      total += spend;
    }
  }

  const regions = Array.from(byKey.values())
    .map((r) => ({
      ...r,
      pct: total > 0 ? (r.spend / total) * 100 : 0,
      accounts: r.accounts.sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.spend - a.spend);

  return json(200, {
    available: regions.length > 0,
    total,
    regions,
  });
};
