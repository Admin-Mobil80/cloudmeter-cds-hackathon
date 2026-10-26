/**
 * Turns one AWS End User Messaging Social event (as delivered by SNS) into the
 * customer messages the assistant should answer — and nothing else.
 *
 * This is the first loop guard. The same SNS topic also carries status updates
 * for every message we send (sent, delivered, read, failed). Those live under
 * `statuses`, never `messages`, and are dropped here, so a reply can never come
 * back in as a question. Anything not addressed to our own number, or sent from
 * it, is dropped too.
 */
export interface InboundMessage {
  /** WhatsApp's message id (wamid…), used to answer each message once. */
  id: string;
  /** Sender's number, digits only. */
  from: string;
  type: string;
  /** Present for type 'text'. */
  text: string | null;
  /** WhatsApp profile name, if sent. */
  profileName: string | null;
}

interface WebhookEntry {
  changes?: Array<{
    field?: string;
    value?: {
      metadata?: { display_phone_number?: string };
      contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
      messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
    };
  }>;
}

export function extractInbound(snsMessage: string, ourPhoneNumberId: string): InboundMessage[] {
  let event: {
    context?: { MetaPhoneNumberIds?: Array<{ arn?: string }> };
    whatsAppWebhookEntry?: string;
  };
  try {
    event = JSON.parse(snsMessage);
  } catch {
    return [];
  }

  // Only events for the number this environment answers on. CloudMeter holds
  // the id as AWS's API returns it (`phone-number-id-<hex>`); the event's ARN
  // spells the same thing `…:phone-number-id/<hex>`.
  const bareId = ourPhoneNumberId.replace(/^phone-number-id-/, '');
  const forUs = !!bareId && (event.context?.MetaPhoneNumberIds ?? []).some((p) => p.arn?.endsWith(`:phone-number-id/${bareId}`));
  if (!forUs || typeof event.whatsAppWebhookEntry !== 'string') return [];

  let entry: WebhookEntry;
  try {
    entry = JSON.parse(event.whatsAppWebhookEntry);
  } catch {
    return [];
  }

  const out: InboundMessage[] = [];
  for (const change of entry.changes ?? []) {
    if (change.field !== 'messages') continue;
    const value = change.value ?? {};
    const ourNumber = (value.metadata?.display_phone_number ?? '').replace(/\D/g, '');
    for (const m of value.messages ?? []) {
      const from = (m.from ?? '').replace(/\D/g, '');
      if (!m.id || !from || from === ourNumber) continue;
      const contact = (value.contacts ?? []).find((c) => c.wa_id === m.from);
      out.push({
        id: m.id,
        from,
        type: m.type ?? 'unknown',
        text: m.type === 'text' ? (m.text?.body ?? '').trim() || null : null,
        profileName: contact?.profile?.name ?? null,
      });
    }
  }
  return out;
}
