import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json } from '../../shared/authz';
import { describeProviders } from '../../shared/providers';
import { getCatalog } from '../../shared/adhoc-catalog';
import { getPricing } from '../../shared/pricing';
import { resolveDisplayCurrency } from '../../shared/display-currency';

// Drives the connect form: the UI renders whatever credential fields each
// provider declares, so adding a provider needs no frontend change. Returns
// field *metadata* only — never any stored credential values.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  // The Adhoc Spend plan lists ride along here rather than on a route of their
  // own: every page that needs them is already entitled to this one, and an
  // extra Lambda is not free in a stack sitting at 415 of 500 resources.
  const catalog = await getCatalog();

  /*
   * What the subscription form needs to quote a plan without inventing a
   * figure: which currency this workspace buys in, and whether tax is added
   * to the vendor's price.
   *
   * The quoted price itself comes from the plan's own `prices` map — what the
   * vendor publishes in that currency — and is never computed here. `rate` is
   * carried only to fill the USD `amount` that every roll-up is totalled in,
   * so a rupee subscription still lands in the same column as a dollar one.
   * It is recorded alongside the line as `paidRate`, so the figure can always
   * be traced back rather than drifting with the market.
   *
   * The tax reads the billing address and nothing else. The gateway's region
   * rule falls back to the signup timezone, which is right for choosing when
   * a digest fires and far too thin to add 18% to a price with — most
   * accounts have no address, so that fallback is really "the browser said
   * Asia/Calcutta once". No address means no tax rather than a guessed one.
   *
   * Best-effort: a failure here leaves the form quoting plain USD list
   * prices, which is what it did before this existed.
   */
  let adhocPricing = {
    currency: 'USD', symbol: '$', rate: 1, taxPercent: 0, taxLabel: null as string | null,
  };
  try {
    const [{ Item: tenant }, pricing] = await Promise.all([
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${caller.membership.tenantId}`, SK: `TENANT#${caller.membership.tenantId}` },
      })),
      getPricing(),
    ]);
    const display = await resolveDisplayCurrency(tenant ?? {});
    const country = ((tenant?.billingAddress as { country?: string } | undefined)?.country ?? '')
      .trim().toLowerCase();
    const india = country === 'india' || country === 'in';
    adhocPricing = {
      currency: display.code,
      symbol: display.symbol,
      rate: display.rate,
      taxPercent: india ? pricing.gstPercent : 0,
      taxLabel: india && pricing.gstPercent > 0 ? `GST ${pricing.gstPercent}%` : null,
    };
  } catch (err) {
    console.error('Adhoc pricing context unavailable; quoting USD list prices', (err as Error).message);
  }

  return json(200, {
    providers: describeProviders(),
    adhocCatalog: catalog.tools,
    adhocPricing,
  });
};
