import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * Which payment gateway CloudMeter charges through.
 *
 * Split by region, because the two are not interchangeable. Indian sales are
 * in INR with GST, settled to an Indian entity — Razorpay is the gateway with
 * a live account and the only one of the three that does INR mandates, so
 * India is fixed to it in code rather than offered as a choice that has one
 * valid answer. Everywhere else is USD, where Razorpay, Paddle and Stripe are
 * all plausible, so that half is a setting.
 *
 * One gateway per region, not several. Money is the last place to want
 * ambiguity: two gateways live at once for the same customers means two
 * sources of truth for whether a subscription is paid, two webhook streams
 * that can disagree, and a reconciliation problem nobody asked for.
 *
 * Switching does *not* migrate anything. Subscriptions already running on the
 * old gateway keep billing there until they're cancelled and re-created —
 * a gateway has no way to hand a live mandate to a competitor. So the setting
 * governs new checkouts, and the BMS screen says so.
 */
export type GatewayKey = 'razorpay' | 'paddle' | 'stripe';

export interface GatewayOption {
  key: GatewayKey;
  label: string;
  live: boolean;
  note: string;
}

/**
 * The catalogue, as it reads before anyone checks the credentials.
 *
 * `live` here is only the default for a gateway nobody has asked about — see
 * gatewayOptions(), which replaces it with the truth for the two that have
 * code behind them. It was a hardcoded flag until Stripe went in: the console
 * went on saying "not configured" after the key was pasted, the webhook
 * registered and a test card had been charged, because nothing ever looked.
 *
 * Wrong in the dangerous direction, too. On production it would have read
 * "not configured" while Stripe was taking real money, and the next person to
 * open that screen would reasonably conclude payments were broken.
 */
export const GATEWAYS: GatewayOption[] = [
  {
    key: 'razorpay',
    label: 'Razorpay',
    live: false,
    note: 'Razorpay Subscriptions — UPI Autopay / card mandate. Also handles all Indian sales, whatever is chosen here.',
  },
  {
    key: 'stripe',
    label: 'Stripe',
    live: false,
    note: 'Stripe Checkout — card subscriptions for customers outside India.',
  },
  {
    key: 'paddle',
    label: 'Paddle',
    live: false,
    // Not a credentials question: there is no Paddle code to configure, so
    // this one stays false however many secrets exist.
    note: 'Placeholder. Selecting it will refuse checkout until it is implemented.',
  },
];

/** Reads a secret and says whether the named fields all carry a value. */
async function hasCredentials(arn: string | undefined, fields: string[]): Promise<boolean> {
  if (!arn) return false;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(res.SecretString ?? '{}') as Record<string, unknown>;
    return fields.every((f) => typeof parsed[f] === 'string' && parsed[f] !== '');
  } catch (err) {
    // A gateway we cannot ask about is reported as not configured. Saying
    // "live" on a failed read would be the one wrong answer here.
    console.error('Gateway credential check failed', arn, (err as Error).message);
    return false;
  }
}

/**
 * The catalogue with `live` decided by whether the credentials are actually
 * there, so the console describes the system rather than a constant.
 *
 * The same fields each gateway's own client insists on before it will make a
 * call, so "live" here means precisely "a checkout would get past config".
 * A webhook secret is deliberately not required: without one the gateway can
 * still take a payment, it just cannot tell us about it, which is a different
 * failure and not one to report as "not configured".
 */
export async function gatewayOptions(): Promise<GatewayOption[]> {
  const [razorpay, stripe] = await Promise.all([
    hasCredentials(process.env.RAZORPAY_SECRET_ARN, ['keyId', 'keySecret']),
    hasCredentials(process.env.STRIPE_SECRET_ARN, ['secretKey']),
  ]);
  const live: Partial<Record<GatewayKey, boolean>> = { razorpay, stripe };

  return GATEWAYS.map((g) => (live[g.key] === undefined ? g : {
    ...g,
    live: live[g.key]!,
    // No "Live." prefix: the badge says whether this gateway is the one
    // charging, and a note that says live beside a badge that says ready is
    // the contradiction this replaced.
    note: live[g.key]
      ? g.note
      : `Not configured — add credentials to the ${g.label} secret before checkout will work. ${g.note}`,
  }));
}

const KEY = { PK: 'PLATFORM#config', SK: 'PAYMENTS' };

/**
 * India's gateway, not a setting.
 *
 * Razorpay is the only one of the three that settles INR to an Indian entity
 * and supports UPI Autopay / eNACH mandates, so there is exactly one correct
 * answer. Offering a picker here would be offering a way to break Indian
 * checkout.
 */
export const INDIA_GATEWAY: GatewayKey = 'razorpay';

/** Razorpay is the default abroad too, because it is the one that is live. */
const DEFAULT_GLOBAL_GATEWAY: GatewayKey = 'razorpay';

export interface GatewaySetting {
  /** Fixed. Present so callers and the BMS screen can state it without knowing why. */
  indiaGateway: GatewayKey;
  /** The configurable half — used for every non-Indian customer. */
  globalGateway: GatewayKey;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function isGatewayKey(value: unknown): value is GatewayKey {
  return value === 'razorpay' || value === 'paddle' || value === 'stripe';
}

export async function getGateway(): Promise<GatewaySetting> {
  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: KEY }));
    // `gateway` is the pre-region field name. Read as the global choice so an
    // existing selection survives the split rather than silently resetting.
    const stored = Item?.globalGateway ?? Item?.gateway;
    return {
      indiaGateway: INDIA_GATEWAY,
      globalGateway: isGatewayKey(stored) ? stored : DEFAULT_GLOBAL_GATEWAY,
      updatedAt: (Item?.updatedAt as string) ?? null,
      updatedBy: (Item?.updatedBy as string) ?? null,
    };
  } catch (err) {
    // Never leave checkout unable to decide: fall back to the default rather
    // than failing the request outright.
    console.error('Gateway setting read failed', (err as Error).message);
    return {
      indiaGateway: INDIA_GATEWAY,
      globalGateway: DEFAULT_GLOBAL_GATEWAY,
      updatedAt: null,
      updatedBy: null,
    };
  }
}

/** Which gateway charges a given customer. India is decided, not looked up. */
export function gatewayForRegion(setting: GatewaySetting, region: 'india' | 'global'): GatewayKey {
  return region === 'india' ? setting.indiaGateway : setting.globalGateway;
}

export async function setGlobalGateway(gateway: GatewayKey, updatedBy: string): Promise<GatewaySetting> {
  const updatedAt = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    // `gateway` is written alongside so a rollback to the pre-region build
    // reads the same choice rather than falling back to the default.
    Item: { ...KEY, globalGateway: gateway, gateway, updatedAt, updatedBy },
  }));
  console.log('Global payment gateway changed', { gateway, by: updatedBy });
  return { indiaGateway: INDIA_GATEWAY, globalGateway: gateway, updatedAt, updatedBy };
}
