import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { json } from '../../../shared/authz';
import { getMembershipsForUser, setActiveTenantId } from '../../../shared/membership';

/**
 * Switches which CloudMeter account the caller is working in.
 *
 * Someone can belong to several — their own, plus any they have been invited
 * into — and every other endpoint reads this pointer to decide which one a
 * request is about.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const userId = event.requestContext.authorizer.jwt.claims.sub as string;

  let body: { tenantId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }
  if (typeof body.tenantId !== 'string' || !body.tenantId.trim()) {
    return json(400, { message: 'tenantId is required' });
  }
  const tenantId = body.tenantId.trim();

  // The switch is only ever a choice between accounts they already belong to.
  // Checked here against their real memberships, so a crafted request can't
  // point someone at a tenant they were never in.
  const memberships = await getMembershipsForUser(userId);
  const match = memberships.find((m) => String(m.PK).replace('TENANT#', '') === tenantId);
  if (!match) return json(403, { message: 'You are not a member of that CloudMeter account.' });

  await setActiveTenantId(userId, tenantId);
  return json(200, { tenantId, role: match.role });
};
