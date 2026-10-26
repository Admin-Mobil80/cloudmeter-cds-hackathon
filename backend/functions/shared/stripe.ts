import { createHmac, timingSafeEqual } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
const API = 'https://api.stripe.com/v1';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

let cached: StripeConfig | null = null;

/**
 * Stripe credentials, read once per warm container.
 *
 * Never in the repo, a CDK context value or an environment variable: the key
 * can move money, so it lives in Secrets Manager and is fetched at runtime,
 * exactly like the WhatsApp token.
 */
export async function stripeConfig(): Promise<StripeConfig> {
  if (cached) return cached;

  const arn = process.env.STRIPE_SECRET_ARN;
  if (!arn) throw new Error('STRIPE_SECRET_ARN is not set');

  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(res.SecretString ?? '{}') as Partial<StripeConfig>;

  if (!parsed.secretKey) {
    throw new Error('Stripe is not configured yet — add secretKey to the Stripe secret');
  }
  cached = { secretKey: parsed.secretKey, webhookSecret: parsed.webhookSecret ?? '' };
  return cached;
}

/**
 * Stripe's API takes form-encoded bodies with bracketed paths for nesting,
 * e.g. `line_items[0][price_data][currency]=usd`. Flattening here keeps call
 * sites readable as ordinary objects.
 */
export function formEncode(value: unknown, prefix = ''): string {
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    return value
      .map((v, i) => formEncode(v, `${prefix}[${i}]`))
      .filter(Boolean)
      .join('&');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => formEncode(v, prefix ? `${prefix}[${k}]` : k))
      .filter(Boolean)
      .join('&');
  }
  return `${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`;
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'StripeError';
  }
}

export async function stripeRequest<T>(
  path: string,
  body?: Record<string, unknown>,
  options: { idempotencyKey?: string; method?: 'GET' | 'POST' } = {},
): Promise<T> {
  const cfg = await stripeConfig();
  const method = options.method ?? (body ? 'POST' : 'GET');

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Retries of a checkout or subscription call must not create a second
      // one; Stripe replays the original response instead.
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    ...(body ? { body: formEncode(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    throw new StripeError(err?.message ?? `Stripe ${method} ${path} failed`, res.status, err?.code);
  }
  return data as T;
}

/** Five minutes, matching Stripe's own guidance on replay tolerance. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a webhook came from Stripe and is recent.
 *
 * The webhook route is public — it has to be — so the signature is the only
 * thing separating a real subscription event from anyone who guesses the URL.
 * It must be computed over the exact bytes Stripe sent, which is why the
 * handler passes the raw body rather than a re-serialised object.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!webhookSecret) return { ok: false, reason: 'No webhook secret configured' };
  if (!signatureHeader) return { ok: false, reason: 'Missing Stripe-Signature header' };

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const [k, ...rest] = kv.trim().split('=');
      return [k, rest.join('=')];
    }),
  ) as Record<string, string>;

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'Malformed timestamp' };
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'Timestamp outside tolerance' };
  }

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Stripe may send several v1 signatures during a secret rotation.
  const provided = signatureHeader
    .split(',')
    .map((kv) => kv.trim())
    .filter((kv) => kv.startsWith('v1='))
    .map((kv) => kv.slice(3));

  const expectedBuf = Buffer.from(expected, 'hex');
  const matched = provided.some((sig) => {
    const buf = Buffer.from(sig, 'hex');
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });

  return matched ? { ok: true } : { ok: false, reason: 'Signature mismatch' };
}
