import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { loadAccountForCaller } from '../../../shared/accounts';
import type { ServiceBreakdownItem } from '../../../shared/seed-cost-data';
import { projectToFullMonth } from '../../../shared/period';
import { projectModelHistory } from '../../../shared/cost-by-model';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  const account = await loadAccountForCaller(caller, accountId);
  if (!account) return json(404, { message: 'Account not found' });

  const service = event.queryStringParameters?.service;

  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':sk': 'MONTHLY#' },
    ScanIndexForward: true,
  }));

  // The chart puts the current month beside finished ones and has always
  // labelled it "(proj.)", but nothing ever projected it — the raw part-month
  // went straight to a bar sized against whole months, so every account looked
  // like it had fallen off a cliff this month. The label was telling the truth
  // about the intent and not about the number.
  //
  // Adhoc accounts are the exception: a subscription charges its full amount on
  // its renewal date, so the month's cost is already complete on day one and
  // scaling it up would invent spend nobody is billed for.
  const projectCurrent = account.dataSource !== 'adhoc';

  /*
   * One project's spend on one model, month by month.
   *
   * The monthly rows can't answer this — they hold spend per model and per
   * project separately — so it is summed from the daily project splits
   * instead. Those only exist from the day the split was first stored, so
   * months before it are reported as having no data rather than zero spend:
   * a bar at zero would claim the project used nothing, when the truth is
   * nobody was looking yet.
   */
  const project = event.queryStringParameters?.project;
  const monthly = Items ?? [];

  if (project && service) {
    const keys = monthly.map((m) => m.monthKey as string);
    const first = keys[0] ?? '';
    const last = keys[keys.length - 1] ?? '';
    const { Items: days } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': `ACCOUNT#${accountId}`,
        ':from': `DAILY#${first}-01`,
        ':to': `DAILY#${last}-31`,
      },
      ProjectionExpression: 'dayKey, projectBreakdown',
    }));
    const history = projectModelHistory(days ?? [], project, service, keys);

    const months = monthly.map((m, i) => {
      const h = history[i];
      const projected = Boolean(m.isCurrent) && projectCurrent && h.hasData;
      return {
        label: m.label,
        spend: projected ? projectToFullMonth(h.spend) : h.spend,
        isCurrent: m.isCurrent,
        isProjected: projected,
        hasData: h.hasData,
      };
    });
    return json(200, { months, scope: { project, service } });
  }

  const months = monthly.map((m) => {
    let spend = m.totalSpend as number;
    if (service) {
      const match = (m.serviceBreakdown as ServiceBreakdownItem[] | undefined)?.find((s) => s.name === service);
      spend = match?.spend ?? 0;
    }
    const projected = Boolean(m.isCurrent) && projectCurrent;
    return {
      label: m.label,
      spend: projected ? projectToFullMonth(spend) : spend,
      isCurrent: m.isCurrent,
      // Lets the UI label only the bars that really are estimates.
      isProjected: projected,
    };
  });

  return json(200, { months });
};
