import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, json } from '../../../shared/authz';
import { createTeamInvite, type TeamInviteInput } from '../../../shared/team-invite';

const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const PORTAL_URL = process.env.PORTAL_URL!;

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  let body: TeamInviteInput;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  return createTeamInvite(caller, body, { fromEmail: FROM_EMAIL, portalUrl: PORTAL_URL });
};
