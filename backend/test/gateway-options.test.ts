/**
 * Whether the console's "live" badge tells the truth.
 *
 * It was a constant. Stripe's key was pasted, its webhook registered and a
 * test card charged, and the screen went on saying "not configured" because
 * nothing ever looked. The same constant would have said it on production
 * while Stripe was taking real money.
 *
 * Secrets Manager is mocked rather than reached: these assertions are about
 * what the badge concludes from a secret's contents, and a test that needed
 * AWS could not cover the failed-read case at all.
 */

const send = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send })),
  GetSecretValueCommand: jest.fn((input) => ({ input })),
}));

import { gatewayOptions, GATEWAYS } from '../functions/shared/payment-gateway';

/** Answers each secret by ARN, so the two gateways can differ in one test. */
function secrets(byArn: Record<string, unknown>) {
  send.mockImplementation((cmd: { input: { SecretId: string } }) => {
    const body = byArn[cmd.input.SecretId];
    if (body === undefined) return Promise.reject(new Error('ResourceNotFound'));
    return Promise.resolve({ SecretString: JSON.stringify(body) });
  });
}

const STRIPE = 'arn:stripe';
const RAZORPAY = 'arn:razorpay';
const find = (list: Awaited<ReturnType<typeof gatewayOptions>>, key: string) =>
  list.find((g) => g.key === key)!;

beforeEach(() => {
  send.mockReset();
  process.env.STRIPE_SECRET_ARN = STRIPE;
  process.env.RAZORPAY_SECRET_ARN = RAZORPAY;
});

describe('the live badge', () => {
  it('calls a gateway live once its key is actually there', async () => {
    secrets({
      [STRIPE]: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' },
      [RAZORPAY]: { keyId: 'rzp_x', keySecret: 'y', webhookSecret: 'z' },
    });
    const opts = await gatewayOptions();
    expect(find(opts, 'stripe').live).toBe(true);
    expect(find(opts, 'razorpay').live).toBe(true);
    // No "Live." prefix: the badge, not the note, says whether this gateway
    // is the one charging — a note claiming live beside a "ready" badge was
    // the contradiction that wording created.
    expect(find(opts, 'stripe').note).not.toMatch(/live/i);
    expect(find(opts, 'stripe').note).toContain('Stripe Checkout');
  });

  it('says not configured while the secret is still the empty template', async () => {
    // Exactly the state CDK creates the secret in.
    secrets({
      [STRIPE]: { secretKey: '', webhookSecret: '' },
      [RAZORPAY]: { keyId: '', keySecret: '', webhookSecret: '' },
    });
    const opts = await gatewayOptions();
    expect(find(opts, 'stripe').live).toBe(false);
    expect(find(opts, 'stripe').note).toContain('Not configured');
  });

  it('reports the two independently', async () => {
    // The state dev was in all afternoon: Stripe keyed, and it should have
    // said so rather than repeating the constant.
    secrets({
      [STRIPE]: { secretKey: 'sk_test_x' },
      [RAZORPAY]: { keyId: '', keySecret: '' },
    });
    const opts = await gatewayOptions();
    expect(find(opts, 'stripe').live).toBe(true);
    expect(find(opts, 'razorpay').live).toBe(false);
  });

  it('does not require a webhook secret to call checkout live', async () => {
    /*
     * A missing webhook secret means the gateway can take a payment but
     * cannot tell us about it. That is a real problem and a different one;
     * reporting it as "not configured" would send someone to re-paste an API
     * key that was never the issue.
     */
    secrets({ [STRIPE]: { secretKey: 'sk_test_x', webhookSecret: '' }, [RAZORPAY]: {} });
    expect(find(await gatewayOptions(), 'stripe').live).toBe(true);
  });

  it('requires every field a gateway needs, not just one', async () => {
    // Razorpay signs with keyId AND keySecret; half of them is not configured.
    secrets({ [STRIPE]: {}, [RAZORPAY]: { keyId: 'rzp_x', keySecret: '' } });
    expect(find(await gatewayOptions(), 'razorpay').live).toBe(false);
  });
});

describe('when the credentials cannot be read', () => {
  it('reports not configured rather than claiming live', async () => {
    // A denied read or a missing secret is the one case where guessing "live"
    // would be actively harmful: it would invite a switch onto a gateway that
    // cannot take a payment.
    secrets({});
    const opts = await gatewayOptions();
    expect(find(opts, 'stripe').live).toBe(false);
    expect(find(opts, 'razorpay').live).toBe(false);
  });

  it('says the same when the ARN was never wired in', async () => {
    delete process.env.STRIPE_SECRET_ARN;
    delete process.env.RAZORPAY_SECRET_ARN;
    const opts = await gatewayOptions();
    expect(find(opts, 'stripe').live).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Paddle', () => {
  it('stays unconfigured however many secrets exist', async () => {
    // Not a credentials question: there is no Paddle code to configure.
    secrets({ [STRIPE]: { secretKey: 'sk_test_x' }, [RAZORPAY]: { keyId: 'a', keySecret: 'b' } });
    const paddle = find(await gatewayOptions(), 'paddle');
    expect(paddle.live).toBe(false);
    expect(paddle.note).toContain('Placeholder');
  });
});

describe('the catalogue itself', () => {
  it('defaults every gateway to not-live, so a missed check cannot read as live', async () => {
    expect(GATEWAYS.every((g) => g.live === false)).toBe(true);
  });

  it('still offers all three, in the same order', async () => {
    secrets({ [STRIPE]: { secretKey: 'sk_test_x' }, [RAZORPAY]: { keyId: 'a', keySecret: 'b' } });
    expect((await gatewayOptions()).map((g) => g.key)).toEqual(['razorpay', 'stripe', 'paddle']);
  });
});
