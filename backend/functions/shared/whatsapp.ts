import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SocialMessagingClient, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging';

const secrets = new SecretsManagerClient({});
const GRAPH_VERSION = 'v21.0';

/*
 * Sending through AWS End User Messaging Social instead of Meta's API.
 *
 * Set where the environment's WhatsApp number is linked to AWS (since
 * 2026-10-21 in the second account): the number's AWS id, e.g.
 * `phone-number-id-…`. Sends then go through this function's own IAM role, so
 * no Meta access token is needed. The message body is Meta's own JSON, passed
 * through unchanged; the templates must exist on the WhatsApp account AWS is
 * linked to.
 *
 * AWS hands the message to Meta asynchronously, so a Meta-side rejection (an
 * unknown template, say) does not surface here: the message just never
 * arrives. Unset, sends go straight to Meta as before.
 */
const AWS_PHONE_NUMBER_ID = (process.env.WHATSAPP_ORIGINATION_PHONE_ID ?? '').trim();
const social = new SocialMessagingClient({});

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  appSecret: string;
  webhookVerifyToken: string;
}

/**
 * Cached for the life of the execution environment. The token is long-lived, so
 * re-reading it on every send would add a Secrets Manager call — and its cost —
 * to every message for no benefit.
 */
let cached: WhatsAppConfig | null = null;

export async function whatsappConfig(): Promise<WhatsAppConfig> {
  if (cached) return cached;

  const arn = process.env.WHATSAPP_SECRET_ARN;
  if (!arn) throw new Error('WHATSAPP_SECRET_ARN is not set');

  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!SecretString) throw new Error('WhatsApp secret is empty');

  const parsed = JSON.parse(SecretString) as WhatsAppConfig;
  if (!parsed.accessToken || !parsed.phoneNumberId) {
    throw new Error('WhatsApp credentials are not configured yet');
  }
  cached = parsed;
  return parsed;
}

export class WhatsAppError extends Error {
  constructor(message: string, readonly code?: number, readonly retryable = false) {
    super(message);
  }
}

interface TemplateComponent {
  // 'header' matters: a template with a TEXT header variable needs its own
  // component, and omitting it is rejected exactly like a wrong body count.
  type: 'header' | 'body' | 'button';
  sub_type?: string;
  index?: string;
  parameters: Array<Record<string, unknown>>;
}

/**
 * Sends an approved template message.
 *
 * Templates are not optional: outside a 24-hour window opened by the *user*
 * messaging us first, Meta rejects anything else. Every message CloudMeter
 * sends is business-initiated to someone who is asleep or hasn't replied in
 * weeks, so this is the only send path that exists.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components: TemplateComponent[],
): Promise<{ messageId: string }> {
  if (AWS_PHONE_NUMBER_ID) return sendTemplateViaAws(to, templateName, languageCode, components);

  const cfg = await whatsappConfig();

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toE164(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    },
  );

  const body = await res.json().catch(() => null) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  } | null;

  if (!res.ok || body?.error) {
    const err = body?.error;
    // Meta's own message is more useful than anything we'd invent, and
    // error_data.details carries the specific reason (wrong language code,
    // template not approved, number not on WhatsApp).
    const detail = err?.error_data?.details ? ` — ${err.error_data.details}` : '';
    throw new WhatsAppError(
      `${err?.message ?? `HTTP ${res.status}`}${detail}`,
      err?.code,
      // 130429 is rate limiting and 131048 is a per-number send limit: both
      // mean "try later", unlike an unapproved template which never will.
      err?.code === 130429 || err?.code === 131048,
    );
  }

  const messageId = body?.messages?.[0]?.id;
  if (!messageId) throw new WhatsAppError('WhatsApp accepted the request but returned no message id');
  return { messageId };
}

async function sendTemplateViaAws(
  to: string,
  templateName: string,
  languageCode: string,
  components: TemplateComponent[],
): Promise<{ messageId: string }> {
  const message = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Unlike Meta's API, AWS rejects a destination without the leading '+'
    // ("Invalid destination phone number"), so it is added back here.
    to: `+${toE164(to)}`,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
  try {
    const res = await social.send(new SendWhatsAppMessageCommand({
      originationPhoneNumberId: AWS_PHONE_NUMBER_ID,
      metaApiVersion: GRAPH_VERSION,
      message: new TextEncoder().encode(message),
    }));
    if (!res.messageId) throw new WhatsAppError('AWS accepted the WhatsApp message but returned no message id');
    return { messageId: res.messageId };
  } catch (err) {
    if (err instanceof WhatsAppError) throw err;
    const e = err as { name?: string; message?: string };
    // Throttling is the one AWS failure worth retrying; a validation error
    // (bad number, malformed template call) will fail the same way again.
    const retryable = e.name === 'ThrottledRequestException' || e.name === 'ThrottlingException';
    throw new WhatsAppError(`${e.name ?? 'AWS'}: ${e.message ?? 'send failed'}`, undefined, retryable);
  }
}

/**
 * Sends a plain text reply through AWS End User Messaging Social.
 *
 * Only valid inside the 24-hour window a customer opens by messaging us — the
 * assistant's replies, which always answer a message that just arrived. Every
 * other send is business-initiated and must use sendTemplate. AWS only: the
 * assistant is not built on the Meta-direct path.
 */
export async function sendTextViaAws(to: string, body: string): Promise<{ messageId: string }> {
  if (!AWS_PHONE_NUMBER_ID) throw new WhatsAppError('WHATSAPP_ORIGINATION_PHONE_ID is not set');
  const message = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: `+${toE164(to)}`,
    type: 'text',
    // WhatsApp's own limit is 4096; the assistant is asked for far less.
    text: { preview_url: false, body: body.slice(0, 4000) },
  });
  const res = await social.send(new SendWhatsAppMessageCommand({
    originationPhoneNumberId: AWS_PHONE_NUMBER_ID,
    metaApiVersion: GRAPH_VERSION,
    message: new TextEncoder().encode(message),
  }));
  if (!res.messageId) throw new WhatsAppError('AWS accepted the WhatsApp message but returned no message id');
  return { messageId: res.messageId };
}

/**
 * Meta wants digits only — no '+', spaces or dashes. It's lenient about the
 * leading '+', but strict about everything else, and a stray space produces a
 * confusing "invalid parameter" rather than a useful message.
 */
export function toE164(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

/** Basic sanity check before we spend an API call on an obvious typo. */
export function looksLikePhone(phone: string): boolean {
  const digits = toE164(phone);
  // ITU E.164 allows at most 15 digits; 8 is below any real country+number.
  return digits.length >= 8 && digits.length <= 15;
}
