import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveBmsCaller, json } from '../../../shared/bms';
import {
  getGateway, setGlobalGateway, isGatewayKey, gatewayOptions, INDIA_GATEWAY,
} from '../../../shared/payment-gateway';
import {
  getPricing, setPricing, PlanPriceOverride, PlanCapOverride,
  DEFAULT_GST_PERCENT, DEFAULT_TRIAL_DAYS, MIN_TRIAL_DAYS, MAX_TRIAL_DAYS,
} from '../../../shared/pricing';
import { PLANS, PlanId } from '../../../shared/plans';

/** A tax rate above this is a typo, not a policy. */
const MAX_GST_PERCENT = 100;
/** Guards against a fat-fingered price that would charge someone a fortune. */
const MAX_PRICE = 10_000_000;

/**
 * Reads and sets what CloudMeter charges, and who processes it.
 *
 * Staff-only by virtue of the BMS authorizer and pool — a customer's token
 * cannot reach any /bms route.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveBmsCaller(event);
  if (!caller) return json(403, { message: 'No BMS access' });

  if (event.requestContext.http.method === 'GET') {
    const [gateway, pricing, options] = await Promise.all([
      getGateway(), getPricing(), gatewayOptions(),
    ]);
    return json(200, {
      ...gateway,
      options,
      pricing,
      // The catalogue, so the editor can label each row and show what the
      // compiled-in default was before anyone overrode it.
      plans: PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        defaultInr: p.priceInr,
        defaultUsd: p.priceUsd,
        defaultCapUsd: p.maxManagedSpendUsd,
      })),
      defaultGstPercent: DEFAULT_GST_PERCENT,
      defaultTrialDays: DEFAULT_TRIAL_DAYS,
      trialDaysRange: { min: MIN_TRIAL_DAYS, max: MAX_TRIAL_DAYS },
    });
  }

  // Changing what CloudMeter charges, or who processes its money, is a
  // root-level decision — not something every staff login should be able to flip.
  if (caller.user.role !== 'root') {
    return json(403, { message: 'Only a root BMS user can change payment settings.' });
  }

  let body: {
    globalGateway?: unknown; prices?: unknown; caps?: unknown;
    gstPercent?: unknown; trialDays?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const wantsGateway = body.globalGateway !== undefined;
  const wantsPricing = body.prices !== undefined || body.caps !== undefined
    || body.gstPercent !== undefined || body.trialDays !== undefined;
  if (!wantsGateway && !wantsPricing) return json(400, { message: 'Nothing to update' });

  if (wantsGateway) {
    if (!isGatewayKey(body.globalGateway)) {
      return json(400, { message: 'globalGateway must be razorpay, paddle or stripe' });
    }
    // India is not settable. Rejecting an attempt rather than ignoring it, so a
    // caller never believes it changed something it did not.
    await setGlobalGateway(body.globalGateway, caller.email);
  }

  if (wantsPricing) {
    const current = await getPricing();

    const gstPercent = body.gstPercent === undefined
      ? current.gstPercent
      : Number(body.gstPercent);
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > MAX_GST_PERCENT) {
      return json(400, { message: `GST must be a percentage between 0 and ${MAX_GST_PERCENT}` });
    }

    const trialDays = body.trialDays === undefined
      ? current.trialDays
      : Number(body.trialDays);
    if (!Number.isInteger(trialDays) || trialDays < MIN_TRIAL_DAYS || trialDays > MAX_TRIAL_DAYS) {
      return json(400, {
        message: `The free trial must be a whole number of days between ${MIN_TRIAL_DAYS} and ${MAX_TRIAL_DAYS}`,
      });
    }

    // Starts from what is in force, so a request that names one plan doesn't
    // blank the others.
    const prices = { ...current.prices } as Record<PlanId, PlanPriceOverride>;
    const caps = { ...current.caps } as Record<PlanId, PlanCapOverride>;

    if (body.prices !== undefined) {
      if (typeof body.prices !== 'object' || body.prices === null || Array.isArray(body.prices)) {
        return json(400, { message: 'prices must be an object keyed by plan id' });
      }
      const input = body.prices as Record<string, { inr?: unknown; usd?: unknown }>;

      for (const [planId, row] of Object.entries(input)) {
        const plan = PLANS.find((p) => p.id === planId);
        if (!plan) return json(400, { message: `Unknown plan: ${planId}` });
        if (typeof row !== 'object' || row === null) {
          return json(400, { message: `${plan.name}: expected an object with inr and usd` });
        }

        const inr = row.inr === undefined ? prices[plan.id].inr : Number(row.inr);
        const usd = row.usd === undefined ? prices[plan.id].usd : Number(row.usd);

        for (const [label, value] of [['INR', inr], ['USD', usd]] as const) {
          if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
            return json(400, {
              message: `${plan.name}: the ${label} price must be a number between 0 and ${MAX_PRICE.toLocaleString('en-US')}`,
            });
          }
        }

        prices[plan.id] = { inr, usd };
      }
    }

    if (body.caps !== undefined) {
      if (typeof body.caps !== 'object' || body.caps === null || Array.isArray(body.caps)) {
        return json(400, { message: 'caps must be an object keyed by plan id' });
      }
      const input = body.caps as Record<string, { inr?: unknown; usd?: unknown }>;

      for (const [planId, row] of Object.entries(input)) {
        const plan = PLANS.find((p) => p.id === planId);
        if (!plan) return json(400, { message: `Unknown plan: ${planId}` });
        if (typeof row !== 'object' || row === null) {
          return json(400, { message: `${plan.name}: expected an object with inr and usd` });
        }

        const next: PlanCapOverride = { ...caps[plan.id] };
        for (const cur of ['inr', 'usd'] as const) {
          if (row[cur] === undefined) continue;
          // Empty and null both mean unlimited — that is the state the UI's
          // blank field represents, and it is a real choice, not a missing one.
          if (row[cur] === null || row[cur] === '') { next[cur] = null; continue; }
          const value = Number(row[cur]);
          if (!Number.isFinite(value) || value < 0) {
            return json(400, {
              message: `${plan.name}: the ${cur.toUpperCase()} spend cap must be a positive number, or blank for unlimited`,
            });
          }
          next[cur] = value;
        }
        caps[plan.id] = next;
      }
    }

    await setPricing({ prices, caps, gstPercent, trialDays }, caller.email);
  }

  const [gateway, pricing, options] = await Promise.all([
    getGateway(), getPricing(), gatewayOptions(),
  ]);
  return json(200, {
    ...gateway,
    options,
    pricing,
    indiaGateway: INDIA_GATEWAY,
  });
};
