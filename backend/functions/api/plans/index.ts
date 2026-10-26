import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { PLANS } from '../../shared/plans';
import { getPricing, priceFor, capFor } from '../../shared/pricing';

/**
 * The plan catalogue.
 *
 * Deliberately public: the marketing page shows the same three plans to people
 * who have no account yet, and serving both from here is what stops the prices
 * on the pricing page drifting from the ones we actually charge and enforce.
 * Nothing here is specific to a customer.
 *
 * Both regions are returned rather than one, because this endpoint has no
 * tenant to place: a signed-out visitor has no billing address. The page picks
 * which to show — and the portal's own Billing page ignores this entirely, as
 * GET /billing resolves the visitor's actual region server-side.
 */
export const handler = async (_event: APIGatewayProxyEventV2) => {
  const pricing = await getPricing();

  const plans = PLANS.map((plan) => ({
    ...plan,
    // Kept alongside the legacy priceUsd/priceInr fields rather than replacing
    // them, so an older cached copy of the pricing page keeps rendering while
    // the new one reads the tax-aware breakdown.
    priceUsd: pricing.prices[plan.id]?.usd ?? plan.priceUsd,
    priceInr: pricing.prices[plan.id]?.inr ?? plan.priceInr,
    india: priceFor(plan, 'india', pricing),
    global: priceFor(plan, 'global', pricing),
    indiaCap: capFor(plan, 'india', pricing),
    globalCap: capFor(plan, 'global', pricing),
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Rarely changes, and a stale price for a few minutes is better than the
      // pricing page failing to render because this call was slow. Short enough
      // that a price change in BMS is live within the hour.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({
      plans,
      gstPercent: pricing.gstPercent,
      trialDays: pricing.trialDays,
    }),
  };
};
