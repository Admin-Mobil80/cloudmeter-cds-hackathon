import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, requireOrgScope, json } from '../../shared/authz';
import { buildDashboardSummary } from '../../shared/dashboard-summary';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const outOfScope = requireOrgScope(caller);
  if (outOfScope) return outOfScope;

  return json(200, await buildDashboardSummary(caller.membership.tenantId));
};
