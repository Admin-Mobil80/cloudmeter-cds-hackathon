import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import { resolveCaller, json, requireWritable } from '../../shared/authz';
import { generateOtp, hashOtp } from '../../shared/otp';
import { sendTemplate, looksLikePhone, toE164, WhatsAppError } from '../../shared/whatsapp';

const TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE ?? 'cloudmeter_verify_code';
const TEMPLATE_LANG = process.env.WHATSAPP_OTP_LANGUAGE ?? 'en';

/** Long enough to find the phone, short enough that a leaked code is useless. */
const CODE_TTL_SECONDS = 10 * 60;

/**
 * Starts WhatsApp number verification: sends a one-time code to the number the
 * user typed.
 *
 * Verifying matters more here than it looks. Cost figures are commercially
 * sensitive, and a mistyped digit would send a company's spend to a stranger's
 * phone — silently, forever, with nothing to indicate it.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  let body: { phone?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!looksLikePhone(phone)) {
    return json(400, { message: 'Enter a valid phone number including its country code.' });
  }

  const code = generateOtp();
  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;

  // Stored hashed and keyed to the user, so the pending code is worthless to
  // anyone reading the table and can't be replayed against a different account.
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `USER#${caller.userId}`,
      SK: 'WHATSAPP_VERIFY',
      phone: toE164(phone),
      codeHash: hashOtp(code, caller.userId),
      attempts: 0,
      expiresAt,
      createdAt: new Date().toISOString(),
    },
  }));

  try {
    // Authentication templates take the code twice: once in the body text and
    // once as the copy-code button's payload.
    const { messageId } = await sendTemplate(phone, TEMPLATE_NAME, TEMPLATE_LANG, [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ]);
    return json(200, { sent: true, phone: `+${toE164(phone)}`, messageId, expiresInSeconds: CODE_TTL_SECONDS });
  } catch (err) {
    const e = err as WhatsAppError;
    console.error('WhatsApp OTP send failed', e.code, e.message);
    // Meta's reasons are actionable ("template does not exist", "number not on
    // WhatsApp"), so pass them through rather than hiding behind a generic
    // failure the user can do nothing with.
    return json(e.retryable ? 429 : 502, {
      sent: false,
      message: `WhatsApp could not send the code: ${e.message}`,
      retryable: e.retryable,
    });
  }
};
