import { createHmac, timingSafeEqual } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { Plan, Currency } from './plans';

const secrets = new SecretsManagerClient({});
const API = 'https://api.razorpay.com/v1';

const REQUEST_TIMEOUT_MS = 15_000;

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

let cached: RazorpayConfig | null = null;

/**
 * Razorpay credentials, read once per warm container.
 *
 * Never in the repo, CDK context or an environment variable — the key can
 * move money, so it lives in Secrets Manager exactly like the Stripe key and
 * the WhatsApp token.
 */
export async function razorpayConfig(): Promise<RazorpayConfig> {
  if (cached) return cached;

  const arn = process.env.RAZORPAY_SECRET_ARN;
  if (!arn) throw new Error('RAZORPAY_SECRET_ARN is not set');

  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(res.SecretString ?? '{}') as Partial<RazorpayConfig>;

  if (!parsed.keyId || !parsed.keySecret) {
    throw new RazorpayNotConfiguredError(
      'Razorpay is not configured yet — add keyId and keySecret to the Razorpay secret.',
    );
  }
  cached = {
    keyId: parsed.keyId,
    keySecret: parsed.keySecret,
    webhookSecret: parsed.webhookSecret ?? '',
  };
  return cached;
}

/** Told apart from a genuine API failure so the UI can say "not set up yet". */
export class RazorpayNotConfiguredError extends Error {}

export class RazorpayError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/**
 * One Razorpay REST call. Auth is HTTP Basic with keyId:keySecret — Razorpay
 * takes JSON bodies, unlike Stripe's form encoding.
 */
export async function razorpayRequest<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const config = await razorpayConfig();
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RazorpayError(`Couldn't reach Razorpay (${(err as Error).name})`, 0);
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Gateway/proxy errors ahead of Razorpay can be HTML.
  }

  if (!res.ok) {
    const error = (body.error ?? {}) as { description?: string; code?: string };
    const stated = error.description || text.replace(/\s+/g, ' ').trim().slice(0, 300);
    console.error('Razorpay request failed', { path, status: res.status, body: stated });
    throw new RazorpayError(stated || `Razorpay returned ${res.status}`, res.status, error.code);
  }

  return body as T;
}

// ---- plans -------------------------------------------------------------

interface RazorpayPlan { id: string }

/**
 * The Razorpay Plan id for one of our plans at one price, created on first use
 * and remembered.
 *
 * Razorpay Subscriptions bill against a Plan object, and a Plan is immutable
 * once created — its amount and currency are fixed. So the cache key carries
 * the tier, the currency *and* the exact amount: change a price in BMS, or
 * change the GST rate, and this mints a new Razorpay Plan rather than silently
 * charging the old amount, which is the failure this key is shaped to prevent.
 *
 * `amountMinor` is the full amount to charge including any tax. Razorpay bills
 * a fixed figure per cycle, so GST has to be inside it — the breakdown is
 * recorded on our side and shown on the invoice.
 */
export async function razorpayPlanId(
  plan: Plan,
  currency: Currency,
  amountMinor: number,
): Promise<string> {
  const amount = amountMinor;
  const cacheId = `${plan.id}:${currency}:${amount}`;
  const key = { PK: 'PLATFORM#razorpay', SK: `PLAN#${cacheId}` };

  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (typeof Item?.razorpayPlanId === 'string') return Item.razorpayPlanId;

  const created = await razorpayRequest<RazorpayPlan>('/plans', {
    method: 'POST',
    body: {
      period: 'monthly',
      interval: 1,
      item: {
        name: `CloudMeter ${plan.name}`,
        description: plan.features.join(' · '),
        amount,
        currency,
      },
      notes: { cloudmeterPlanId: plan.id },
    },
  });

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { ...key, razorpayPlanId: created.id, amount, currency, createdAt: new Date().toISOString() },
  }));

  return created.id;
}

// ---- subscriptions -----------------------------------------------------

export interface RazorpaySubscription {
  id: string;
  status: string;
  short_url: string;
  current_end?: number;
  plan_id?: string;
}

/**
 * A subscription the customer can pay for.
 *
 * `short_url` is Razorpay's hosted authorisation page — the equivalent of a
 * Stripe Checkout URL. The customer sets up a UPI Autopay or card mandate
 * there, and Razorpay charges each cycle from then on.
 */
export async function createSubscription(params: {
  planId: string;
  tenantId: string;
  email: string;
  tenantName: string | null;
  totalCount?: number;
}): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>('/subscriptions', {
    method: 'POST',
    body: {
      plan_id: params.planId,
      // Razorpay requires a finite cycle count — there is no "until cancelled"
      // — and states the resulting end date on its hosted checkout. 60 months
      // is five years: far longer than a typical subscription lives, and it
      // reads as a considered horizon rather than the decade-away date 120
      // produced.
      //
      // Nothing listens for `subscription.completed`, so on the final cycle
      // charges simply stop and currentPeriodEnd lapses — the account then
      // expires the same way an unrenewed one does, visibly, rather than
      // staying live unpaid. Worth handling properly before 2031: warn, or
      // re-subscribe, instead of letting a five-year customer be told their
      // subscription expired with no explanation.
      total_count: params.totalCount ?? 60,
      customer_notify: 1,
      notes: {
        tenantId: params.tenantId,
        email: params.email,
        tenantName: params.tenantName ?? '',
      },
    },
  });
}

export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    body: { cancel_at_cycle_end: 1 },
  });
}

// ---- webhooks ----------------------------------------------------------

/**
 * Verifies a Razorpay webhook.
 *
 * Not currently called — the Razorpay webhook handler had this check removed
 * on 2026-08-26 at the account owner's explicit request (see the comment on
 * that handler for why). Left here, correct and tested, as the one-line fix
 * for re-enabling it: pass this the raw body, the `x-razorpay-signature`
 * header, and `webhookSecret` from Secrets Manager.
 *
 * The signature is a plain HMAC-SHA256 of the *raw* body with the webhook
 * secret — no timestamp, unlike Stripe — so the body must be the exact bytes
 * received, never a re-serialised object. Compared in constant time so a
 * forged signature can't be discovered a byte at a time.
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Razorpay subscription status -> the status CloudMeter stores. */
export function mapSubscriptionStatus(status: string): string {
  switch (status) {
    // `authenticated` means the mandate is set up but the first charge hasn't
    // landed. Treated as active: the customer has done everything asked of
    // them, and locking them out while Razorpay settles would be wrong.
    case 'authenticated':
    case 'active':
      return 'active';
    case 'pending':
    case 'halted':
      return 'past_due';
    case 'cancelled':
    case 'completed':
    case 'expired':
      return 'canceled';
    default:
      return status;
  }
}
