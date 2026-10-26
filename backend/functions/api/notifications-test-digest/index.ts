import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { resolveCaller, visibleAccountIds, json, requireWritable } from '../../shared/authz';
import { normalizeTimezone } from '../../shared/schedule';
import { buildDigest, money } from '../../shared/digest';
import { sendDigestEmail, digestSubject } from '../../shared/digest-email';
import { sendDigestWhatsApp } from '../../shared/digest-whatsapp';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';

const FROM_EMAIL = process.env.OTP_FROM_EMAIL!;
const PORTAL_URL = process.env.PORTAL_URL!;

/**
 * Sends the caller their own account's digest, right now.
 *
 * Deliberately only ever mails the authenticated caller — it's a preview
 * button, not a broadcast, so it can't be used to mail the whole team on a
 * whim, and it makes the digest verifiable without waiting for 10am somewhere.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const { tenantId, tenantName } = caller.membership;

  const digest = await buildDigest(
    tenantId,
    tenantName ?? 'your CloudMeter account',
    normalizeTimezone(caller.membership.timezone),
    new Date(),
    // A preview has to match what this person would really be sent.
    visibleAccountIds(caller),
  );

  if (!digest) {
    return json(200, {
      sent: false,
      reason: 'No complete day of cost data to summarise yet. Connect an account, '
        + 'or wait for your providers to finish reporting a full day.',
    });
  }

  await sendDigestEmail(digest, {
    email: caller.email,
    portalUrl: PORTAL_URL,
    fromEmail: FROM_EMAIL,
  });

  // Preview the WhatsApp copy too, when the caller has a verified number and
  // has asked for that channel. The template's parameter list has to match
  // Meta's approved body exactly, and a mismatch is invisible until a real
  // send fails — so the preview button is the place to find out.
  let whatsapp: { sent: boolean; to?: string; error?: string } = { sent: false };
  const phone = await verifiedWhatsAppNumber(caller.userId);
  if (phone) {
    try {
      await sendDigestWhatsApp(digest, phone);
      whatsapp = { sent: true, to: phone };
    } catch (err) {
      whatsapp = { sent: false, error: (err as Error).message };
    }
  }

  return json(200, {
    sent: true,
    to: caller.email,
    whatsapp,
    subject: digestSubject(digest),
    covering: digest.dayLabel,
    daySpend: money(digest.daySpend, digest.currency),
    monthToDate: money(digest.monthToDate, digest.currency),
    movers: digest.movers.length,
  });
};

/** The caller's own verified number, or null if WhatsApp isn't set up. */
async function verifiedWhatsAppNumber(userId: string): Promise<string | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
  }));
  const wa = (Item?.channels as { whatsapp?: { connected?: boolean; phone?: string } } | undefined)?.whatsapp;
  const digest = Item?.digest as { channels?: string[] } | undefined;
  const wants = Array.isArray(digest?.channels) ? digest!.channels!.includes('whatsapp') : false;
  return wants && wa?.connected && wa.phone ? wa.phone : null;
}
