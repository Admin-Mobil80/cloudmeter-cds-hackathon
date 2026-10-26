import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveBmsCaller, json } from '../../../shared/bms';
import {
  getCatalog, setCatalog, validateCatalog, DEFAULT_CATALOG,
  MAX_TOOLS, MAX_PLANS_PER_TOOL,
} from '../../../shared/adhoc-catalog';

/**
 * The AI-tool plans and list prices the Adhoc Spend form offers.
 *
 * Editable by any staff login rather than root only, unlike plan pricing. This
 * is third-party reference data used to pre-fill a field — it never decides
 * what CloudMeter charges anyone, and no customer's stored cost is derived
 * from it. `updatedBy` is recorded either way, so a wrong price has a name
 * against it.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  if (event.requestContext.http.method === 'GET') {
    const catalog = await getCatalog();
    return json(200, {
      ...catalog,
      // So the editor can say what the built-in default was before anyone
      // edited it, and offer to restore it.
      defaults: DEFAULT_CATALOG,
      limits: { maxTools: MAX_TOOLS, maxPlansPerTool: MAX_PLANS_PER_TOOL },
    });
  }

  let body: { tools?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const tools = validateCatalog(body.tools);
  if (typeof tools === 'string') return json(400, { message: tools });

  const saved = await setCatalog(tools, caller.email);
  return json(200, saved);
};
