import Core from '@alicloud/pop-core';
import {
  ProviderAdapter,
  ProviderCredentials,
  ProviderAuthError,
  ProviderPermissionError,
  MonthlySnapshot,
  buildSnapshots,
  monthKeyOf,
  monthStart,
} from './types';

// BSS OpenAPI is a single global endpoint (the international one); billing is
// account-scoped rather than region-scoped, so there's no region to pick.
const BSS_ENDPOINT = 'https://business.aliyuncs.com';
const BSS_API_VERSION = '2017-12-14';

// QueryBillOverview is one HTTP call per billing cycle, so a few months of
// history means a handful of round trips. Keep a small amount of parallelism:
// enough to stay well inside the Lambda timeout, low enough not to trip BSS's
// per-account throttling.
const MONTH_CONCURRENCY = 4;

/**
 * The slice of the QueryBillOverview response we actually read. Alibaba's
 * JSON-flattened XML wraps repeated elements in a `{ Item: [...] }` object,
 * and numeric fields come back as strings about as often as numbers, so
 * everything here is deliberately loose and coerced at the point of use.
 */
interface BillOverviewItem {
  ProductName?: string;
  ProductCode?: string;
  PretaxAmount?: number | string;
  PretaxGrossAmount?: number | string;
}

interface BillOverviewResponse {
  Code?: string;
  Message?: string;
  Data?: {
    AccountID?: string;
    BillingCycle?: string;
    Items?: { Item?: BillOverviewItem[] } | BillOverviewItem[];
  };
}

/** Error shape pop-core attaches to a non-success BSS response. */
interface PopCoreError extends Error {
  code?: string;
  data?: { Code?: string; Message?: string };
}

// Codes returned when the AK/SK itself is wrong — a new key pair is the fix.
const AUTH_CODES = new Set([
  'InvalidAccessKeyId',
  'InvalidAccessKeyId.NotFound',
  'InvalidAccessKeyId.Inactive',
  'InvalidAccessKeyId.Disabled',
  'InvalidAccessKeySecret',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'MissingAccessKeyId',
  'InvalidSecurityToken',
  'InvalidSecurityToken.Expired',
  'Unauthorized',
]);

// Codes returned when the key is valid but the RAM user can't read billing —
// the fix is attaching AliyunBSSReadOnlyAccess, not rotating the key.
const PERMISSION_CODES = new Set([
  'Forbidden.RAM',
  'Forbidden',
  'Forbidden.NoPermission',
  'NoPermission',
  'NotAuthorized',
  'NotApplicable',
  'ERR_CODE_NO_PERMISSION',
]);

function errorCodeOf(err: unknown): string {
  const e = err as PopCoreError;
  // pop-core sets `code` from the response body's `Code`; keep `data.Code` and
  // the derived `name` ("<Code>Error") as fallbacks in case one is missing.
  return e?.code ?? e?.data?.Code ?? (e?.name ?? '').replace(/Error$/, '');
}

function isAuthCode(code: string): boolean {
  return AUTH_CODES.has(code) || code.startsWith('InvalidAccessKey') || code.startsWith('SignatureDoesNotMatch');
}

function isPermissionCode(code: string): boolean {
  return PERMISSION_CODES.has(code) || code.startsWith('Forbidden.') || code.includes('NoPermission');
}

/**
 * Re-throws a BSS failure as the adapter-level error the customer can act on.
 * Classification is driven by the returned error *code* — BSS messages are
 * localized and reworded, so matching on them is not reliable. Only the code
 * and HTTP-level error name ever reach the message; never the AK/SK.
 */
function classifyBssError(err: unknown, context: string): never {
  const code = errorCodeOf(err);

  if (isAuthCode(code)) {
    throw new ProviderAuthError(
      `Alibaba Cloud rejected the access key. Check the RAM access key ID and secret are correct and still enabled. (${code})`,
    );
  }

  if (isPermissionCode(code)) {
    throw new ProviderPermissionError(
      `The access key authenticated, but reading billing was denied. Attach the AliyunBSSReadOnlyAccess policy (or an equivalent BSS read permission) to this RAM user. (${code})`,
    );
  }

  throw new Error(`Alibaba Cloud BSS request failed while ${context}${code ? ` (${code})` : ''}`);
}

function clientFor(creds: ProviderCredentials): Core {
  const accessKeyId = creds.access_key_id;
  const accessKeySecret = creds.access_key_secret;

  if (!accessKeyId || !accessKeySecret) {
    throw new ProviderAuthError('Both the RAM access key ID and access key secret are required.');
  }

  return new Core({
    accessKeyId,
    accessKeySecret,
    endpoint: BSS_ENDPOINT,
    apiVersion: BSS_API_VERSION,
  });
}

/** BSS bills numbers as strings ("1,234.56") as often as numbers. */
function toAmount(value: number | string | undefined | null): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemsOf(res: BillOverviewResponse): BillOverviewItem[] {
  const items = res?.Data?.Items;
  if (Array.isArray(items)) return items;
  return items?.Item ?? [];
}

/** `YYYY-MM`, which is exactly what BSS calls a BillingCycle. */
function billingCycleOf(d: Date): string {
  return monthKeyOf(d);
}

async function queryBillOverview(client: Core, billingCycle: string): Promise<BillOverviewResponse> {
  return client.request<BillOverviewResponse>(
    'QueryBillOverview',
    { BillingCycle: billingCycle },
    { method: 'POST', timeout: 15000 },
  );
}

/**
 * One product row per service, summed — BSS can list the same product more
 * than once in a cycle (subscription vs pay-as-you-go, different biz types),
 * and the snapshot shape wants a single row per service name.
 */
function servicesFrom(res: BillOverviewResponse): Array<{ name: string; spend: number }> {
  const totals = new Map<string, number>();

  for (const item of itemsOf(res)) {
    const name = item.ProductName?.trim() || item.ProductCode?.trim() || 'Unknown';
    // PretaxAmount is the payable amount after discounts; fall back to the
    // gross figure on the rare row that omits it.
    const spend = toAmount(item.PretaxAmount ?? item.PretaxGrossAmount);
    totals.set(name, (totals.get(name) ?? 0) + spend);
  }

  return [...totals].map(([name, spend]) => ({ name, spend }));
}

/** Runs `worker` over `items` with a bounded number in flight, in order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export const alibabaAdapter: ProviderAdapter = {
  key: 'alibaba',
  displayName: 'Alibaba Cloud',

  // No real Alibaba Cloud account has been connected yet — this adapter is
  // structurally complete but has never round-tripped against live BSS data.
  verified: false,

  // Alibaba has no cross-account role-assumption equivalent for BSS, so this
  // is a stored RAM key pair. Only the secret is held in Secrets Manager.
  credentialFields: [
    {
      name: 'access_key_id',
      label: 'Access Key ID',
      type: 'text',
      required: true,
      placeholder: 'LTAI5t...',
      help: 'RAM user access key ID. The user needs the AliyunBSSReadOnlyAccess policy.',
    },
    {
      name: 'access_key_secret',
      label: 'Access Key Secret',
      type: 'secret',
      required: true,
      help: 'Shown only once when the key is created. Stored encrypted and never returned.',
    },
    {
      // BSS scopes every call to the account that owns the access key, so this
      // isn't sent to the API. It's collected per the onboarding requirements
      // for reconciliation and support, and to let us spot a key pasted from
      // the wrong account.
      name: 'account_uid',
      label: 'Account UID',
      type: 'text',
      required: true,
      placeholder: '1234567890123456',
      help: 'Your Alibaba Cloud account UID, from Account Management > Security Settings.',
    },
  ],

  async verifyAccess(creds) {
    const client = clientFor(creds);

    // The previous full month always exists for an active account and is the
    // cheapest possible proof that both authentication and the BSS read
    // permission are in place.
    const cycle = billingCycleOf(monthStart(new Date(), -1));

    try {
      await queryBillOverview(client, cycle);
    } catch (err) {
      classifyBssError(err, 'verifying billing access');
    }
  },

  async fetchMonthlySnapshots(creds, months): Promise<MonthlySnapshot[]> {
    const client = clientFor(creds);
    const now = new Date();

    // Oldest first, ending with the current (partial) month; buildSnapshots
    // flags that last one as `isCurrent`.
    const monthDates = Array.from({ length: months }, (_, i) => monthStart(now, -(months - 1 - i)));

    const perMonth = await mapWithConcurrency(monthDates, MONTH_CONCURRENCY, async (date) => {
      try {
        const res = await queryBillOverview(client, billingCycleOf(date));
        return { date, services: servicesFrom(res) };
      } catch (err) {
        const code = errorCodeOf(err);
        // Bad credentials or a missing BSS policy affect every month equally,
        // so fail the whole sync loudly rather than silently returning gaps.
        if (isAuthCode(code) || isPermissionCode(code)) {
          classifyBssError(err, 'fetching monthly cost');
        }
        // Anything else (throttling, a transient 5xx, a cycle predating the
        // account) is per-month: drop that month and keep the rest.
        return null;
      }
    });

    return buildSnapshots(
      perMonth.filter((m): m is { date: Date; services: Array<{ name: string; spend: number }> } => m !== null)
        // Alibaba exposes no usable cost-by-tag dimension through BSS, so the
        // tag view is empty for this provider.
        .map((m) => ({ ...m, tagBreakdown: {} })),
    );
  },
};
