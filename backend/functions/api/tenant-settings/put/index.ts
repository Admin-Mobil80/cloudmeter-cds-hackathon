import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import { ALLOWED_FREQUENCIES, isValidFrequency, intervalMsFor } from '../../../shared/monitoring-frequency';
import { isValidTimezone, normalizeDigestHour } from '../../../shared/schedule';
import { resolveDisplayCurrency } from '../../../shared/display-currency';

const MAX_NAME_LENGTH = 80;
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'zip', 'country'] as const;
const MAX_ADDRESS_FIELD_LENGTH = 120;

// Partial updates: a caller may send just the name, just the frequency, or
// both, so each field is validated only when present.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  // These are workspace-wide settings, and monitoring frequency drives real
  // metered provider spend, so both stay owner-only.
  // Admins can change settings — the business name, timezone, digest hour and
  // monitoring frequency are operational. Closing the CloudMeter account stays
  // the Owner's alone and lives on its own route.
  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  let body: {
    monitoringFrequency?: unknown; name?: unknown; timezone?: unknown; digestHour?: unknown;
    billingAddress?: unknown;
    displayCurrency?: unknown; fxSource?: unknown; fxRateManual?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  // Always written, which also guarantees `:now` is referenced by the
  // expression. Seeding it as an unconditional value while only *using* it in
  // some branches made DynamoDB reject any save that touched neither the name
  // nor the frequency — saving just a timezone failed with a 500.
  const sets: string[] = ['settingsUpdatedAt = :now'];
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const names: Record<string, string> = {};

  if (body.monitoringFrequency !== undefined) {
    if (!isValidFrequency(body.monitoringFrequency)) {
      return json(400, { message: `monitoringFrequency must be one of: ${ALLOWED_FREQUENCIES.join(', ')}` });
    }
    sets.push('monitoringFrequency = :f', 'monitoringFrequencyUpdatedAt = :now');
    values[':f'] = body.monitoringFrequency;
  }

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return json(400, { message: 'Organization name cannot be empty' });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return json(400, { message: `Organization name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }
    // #name — "name" is a DynamoDB reserved word.
    sets.push('#name = :n', 'nameUpdatedAt = :now');
    names['#name'] = 'name';
    values[':n'] = name;
  }

  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) {
      return json(400, { message: 'timezone must be a valid IANA name, e.g. Asia/Kolkata' });
    }
    sets.push('#tz = :tz');
    names['#tz'] = 'timezone';
    values[':tz'] = body.timezone;
  }

  if (body.digestHour !== undefined) {
    const hour = Number(body.digestHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return json(400, { message: 'digestHour must be a whole number from 0 to 23' });
    }
    sets.push('digestHour = :dh');
    values[':dh'] = hour;
  }

  if (body.displayCurrency !== undefined) {
    if (body.displayCurrency !== 'USD' && body.displayCurrency !== 'LOCAL') {
      return json(400, { message: 'displayCurrency must be USD or LOCAL' });
    }
    sets.push('displayCurrency = :dc');
    values[':dc'] = body.displayCurrency;
  }

  if (body.fxSource !== undefined) {
    if (body.fxSource !== 'auto' && body.fxSource !== 'manual') {
      return json(400, { message: 'fxSource must be auto or manual' });
    }
    sets.push('fxSource = :fxs');
    values[':fxs'] = body.fxSource;
  }

  if (body.fxRateManual !== undefined) {
    // null clears it, which is how you go back to the live rate without
    // having to remember what was typed before.
    if (body.fxRateManual === null) {
      sets.push('fxRateManual = :fxr');
      values[':fxr'] = null;
    } else {
      const rate = Number(body.fxRateManual);
      if (!Number.isFinite(rate) || rate <= 0) {
        return json(400, { message: 'The exchange rate must be a positive number.' });
      }
      sets.push('fxRateManual = :fxr');
      values[':fxr'] = rate;
    }
  }

  if (body.billingAddress !== undefined) {
    if (typeof body.billingAddress !== 'object' || body.billingAddress === null || Array.isArray(body.billingAddress)) {
      return json(400, { message: 'billingAddress must be an object' });
    }
    const input = body.billingAddress as Record<string, unknown>;
    const address: Record<string, string> = {};
    for (const field of ADDRESS_FIELDS) {
      const raw = typeof input[field] === 'string' ? input[field].trim() : '';
      if (raw.length > MAX_ADDRESS_FIELD_LENGTH) {
        return json(400, { message: `${field} must be ${MAX_ADDRESS_FIELD_LENGTH} characters or fewer` });
      }
      address[field] = raw;
    }
    sets.push('billingAddress = :addr');
    values[':addr'] = address;
  }

  // One entry is the timestamp above, so anything less means the request
  // carried no actual setting.
  if (sets.length === 1) {
    return json(400, { message: 'Nothing to update' });
  }

  const tenantId = caller.membership.tenantId;
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));

  const frequency = (Attributes?.monitoringFrequency as number) ?? undefined;

  return json(200, {
    name: Attributes?.name ?? null,
    monitoringFrequency: frequency,
    timezone: Attributes?.timezone ?? null,
    digestHour: normalizeDigestHour(Attributes?.digestHour),
    billingAddress: Attributes?.billingAddress ?? null,
    currency: await resolveDisplayCurrency(Attributes ?? {}),
    ...(frequency ? { minIntervalHours: intervalMsFor(frequency as 1 | 2 | 3 | 4 | 6) / 3_600_000 } : {}),
  });
};
