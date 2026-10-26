import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, json } from '../../../shared/authz';
import { ALLOWED_FREQUENCIES, normalizeFrequency, intervalMsFor } from '../../../shared/monitoring-frequency';
import { normalizeTimezone, normalizeDigestHour, DEFAULT_TIMEZONE } from '../../../shared/schedule';
import { resolveDisplayCurrency } from '../../../shared/display-currency';

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const tenantId = caller.membership.tenantId;
  const { Item: tenant } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
  }));

  const monitoringFrequency = normalizeFrequency(tenant?.monitoringFrequency);
  const currency = await resolveDisplayCurrency(tenant ?? {});

  /**
   * The rate the tenant *would* convert at, whatever mode is saved.
   *
   * The settings page lets someone switch the dropdown to local currency and
   * read what that means before committing, so it needs the local rate even
   * when USD is the saved mode. resolveDisplayCurrency deliberately
   * short-circuits there — no conversion is happening, so looking a rate up
   * would be waste — and returns rate: 1. The page then quoted that back as
   * "1 USD = 1.00 INR" the moment anyone toggled the dropdown.
   *
   * Resolved a second time against a LOCAL view rather than by loosening the
   * short-circuit, which every digest and alert also depends on. Costs nothing
   * beyond the settings page: rates are cached for 24h, shared across tenants.
   */
  const localView = currency.mode === 'LOCAL'
    ? currency
    : await resolveDisplayCurrency({ ...(tenant ?? {}), displayCurrency: 'LOCAL' });

  return json(200, {
    name: tenant?.name ?? null,
    monitoringFrequency,
    // `timezoneSet` distinguishes "explicitly chose UTC" from "never set one",
    // so the UI can offer the browser's zone without overwriting a real choice.
    timezone: normalizeTimezone(tenant?.timezone),
    timezoneSet: !!tenant?.timezone,
    defaultTimezone: DEFAULT_TIMEZONE,
    digestHour: normalizeDigestHour(tenant?.digestHour),
    billingAddress: tenant?.billingAddress ?? null,
    currency: {
      ...currency,
      // What switching to local currency would give, so the page can describe
      // the choice before it is saved. Equal to rate/rateAsOf when LOCAL is
      // already the saved mode.
      localRate: localView.rate,
      localRateAsOf: localView.rateAsOf,
      localRateSource: localView.rateSource,
    },
    allowedFrequencies: ALLOWED_FREQUENCIES,
    minIntervalHours: intervalMsFor(monitoringFrequency) / 3_600_000,
    // Matches the PUT route: Owners and Admins both. Closing the CloudMeter
    // account is the only Owner-only thing on this page, and it is gated
    // separately by its own route.
    canEdit: caller.membership.role === 'owner' || caller.membership.role === 'admin',
  });
};
