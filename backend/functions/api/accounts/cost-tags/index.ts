import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import { costByModel } from '../../../shared/cost-by-model';
import { comparisonWindow } from '../../../shared/period';
import { monthKeyOf, monthStart } from '../../../shared/providers/types';

// Tag dimensions aren't a fixed list — for live AWS accounts they're whichever
// cost-allocation tag keys that account actually has activated, so the
// available keys come from the stored snapshot rather than a hardcoded set.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'MONTHLY#' },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const current = Items?.[0];
  if (!current) return json(200, { availableDims: [], dim: null, tags: [] });

  const tagBreakdown = (current.tagBreakdown ?? {}) as Record<string, TagRow[]>;
  const availableDims = Object.keys(tagBreakdown);
  const requested = event.queryStringParameters?.dim;
  const dim = requested && availableDims.includes(requested) ? requested : availableDims[0] ?? null;

  /*
   * Which models each project used this month — the join the monthly row
   * cannot make. Read from the month's daily rows, which carry a per-day
   * project split for providers that have projects (OpenAI). Served here
   * rather than on a route of its own: the account page already calls this
   * for the Projects card, and the stack is at 424 of 500 resources.
   *
   * One extra query for every account, project dimension or not — cheaper
   * than a second round trip to find out, and it answers null for accounts
   * without one.
   */
  const now = new Date();
  const month = monthKeyOf(now);
  const previousMonth = monthKeyOf(monthStart(now, -1));
  // This month and last, in one range read: the trends compare the same
  // days of each. totalSpend is what tells a zero-spend day from a gap.
  const { Items: days } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': `ACCOUNT#${accountId}`,
      ':from': `DAILY#${previousMonth}-01`,
      ':to': `DAILY#${month}-31`,
    },
    ProjectionExpression: 'dayKey, totalSpend, projectBreakdown',
  }));
  const rows = days ?? [];

  return json(200, {
    byModel: costByModel(rows, month, {
      window: comparisonWindow(now),
      previousRows: rows,
    }),
    // Unchanged fields — the per-dimension view is still the correct answer to
    // "what has no <key> tag?", and anything already reading this keeps working.
    availableDims,
    dim,
    tags: dim ? tagBreakdown[dim] : [],
    // Added: every tag key at once. Showing one key at a time meant the
    // "Untagged" figure changed completely each time the user switched key —
    // each key partitions the whole account, so it's ~66% under one key and
    // ~98% under another, which reads as broken even though both are right.
    ...groupedView(tagBreakdown, Number(current.totalSpend ?? 0)),
    /*
     * What the untagged remainder is actually spent on.
     *
     * Asked of the provider directly — spend grouped by service, filtered to
     * resources carrying none of the account's tag keys — rather than derived
     * from the residual, which is a subtraction and cannot be broken down.
     *
     * Absent on an account synced before this existed, and on providers with
     * no tag dimension, so the card has to treat "not there" as "not known"
     * rather than "nothing".
     */
    untaggedServices: (current.untaggedServices as Array<{ name: string; spend: number }>) ?? null,
    asOf: (account.sync as string) ?? null,
  });
};

interface TagRow { label: string; spend: number; untagged?: boolean }

/**
 * Rolls the per-key breakdown into one cross-tag view.
 *
 * `untaggedShared` is spend carrying none of the account's tag keys, derived as
 * total − everything tagged. That subtraction is only sound while no resource
 * carries two different tag keys; when one does its cost lands under both keys,
 * the tagged sum overshoots the account total, and the honest answer is to say
 * so rather than report a clamped zero — hence `overlap`.
 */
function groupedView(tagBreakdown: Record<string, TagRow[]>, totalSpend: number) {
  const groups = Object.entries(tagBreakdown)
    .map(([tagKey, rows]) => {
      const values = (rows ?? [])
        .filter((r) => !r.untagged && Number(r.spend) > 0)
        .map((r) => ({ label: r.label, spend: Number(r.spend) }))
        .sort((a, b) => b.spend - a.spend);
      return {
        tagKey,
        tagged: values.reduce((sum, v) => sum + v.spend, 0),
        // Kept per key: "spend with no <key> tag" is still a real question,
        // it just isn't the headline number any more.
        untaggedForKey: (rows ?? [])
          .filter((r) => r.untagged)
          .reduce((sum, r) => sum + Number(r.spend), 0),
        values,
      };
    })
    .filter((g) => g.values.length > 0)
    .sort((a, b) => b.tagged - a.tagged);

  const totalTagged = groups.reduce((sum, g) => sum + g.tagged, 0);

  return {
    groups,
    totalSpend,
    totalTagged,
    untaggedShared: Math.max(0, totalSpend - totalTagged),
    overlap: totalTagged > totalSpend + 0.01,
  };
}
