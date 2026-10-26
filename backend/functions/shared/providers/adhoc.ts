import { ProviderAdapter } from './types';

/**
 * Subscriptions nobody can bill us for programmatically — Claude Pro, ChatGPT
 * Plus, Cursor, Midjourney.
 *
 * This adapter exists to put "Adhoc Spend" in the provider list and to satisfy
 * the registry lookup every connect goes through. It has no credentials and
 * nothing to fetch: the figures are typed in, stored as items on the account,
 * and turned into snapshots by functions/shared/adhoc.ts whenever they change.
 *
 * An adhoc account is written with `dataSource: 'adhoc'`, and the sweep only
 * processes `'live'`, so nothing here is ever called on a schedule. The two
 * methods throw rather than returning empty: silently handing back nothing
 * would blank a customer's subscriptions if this were ever wired up by
 * mistake, and a loud failure is far easier to find than a zero.
 */
export const adhocAdapter: ProviderAdapter = {
  key: 'adhoc',
  displayName: 'Adhoc Spend',
  verified: true,

  // None. The connect flow for this provider collects subscriptions, not
  // secrets, and the UI keys off an empty list to take that path.
  credentialFields: [],

  async verifyAccess() {
    // Nothing to authenticate against.
  },

  async fetchMonthlySnapshots() {
    throw new Error(
      'Adhoc spend is not fetched — its snapshots are recomputed from the '
        + 'subscriptions stored on the account whenever they change.',
    );
  },
};
