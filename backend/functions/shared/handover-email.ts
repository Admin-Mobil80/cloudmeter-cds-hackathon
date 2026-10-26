import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { renderEmailHtml, renderEmailText, EmailBody } from './email-layout';

const ses = new SESClient({});

export interface Handover {
  accountName: string;
  providerLabel: string;
  externalId: string;
  /** Who performed the reassignment — a person's name, not an address. */
  actorName: string;
  /** Absent when the account had no manager before. */
  fromEmail?: string;
  fromName?: string;
  toEmail: string;
  toName: string;
  tenantName: string;
  portalUrl: string;
  fromEmailAddress: string;
  accountId: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  alibaba: 'Alibaba Cloud',
  huawei: 'Huawei Cloud',
  openai: 'OpenAI',
  whatsapp: 'WhatsApp Business',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.toUpperCase();
}

/**
 * "Mobil80 Solutions" -> "Mobil80 Solutions' CloudMeter account".
 *
 * The tenant name is the customer's own business name, so it belongs in the
 * sentence as a possessive rather than as a bare noun — "in Mobil80 Solutions"
 * reads like a place. Names already ending in s take the bare apostrophe.
 */
export function possessiveAccount(tenantName: string): string {
  const name = tenantName.trim();
  if (!name) return 'your CloudMeter account';
  return /s$/i.test(name) ? `${name}' CloudMeter account` : `${name}'s CloudMeter account`;
}

/**
 * Tells both sides of a handover what changed.
 *
 * Managing an account carries real authority — removing it destroys stored
 * credentials and cost history, and forcing a refresh spends metered API
 * budget. So neither side should discover the change by finding a button
 * missing, or by never noticing they acquired one.
 *
 * Delivery failures are the caller's to swallow: the reassignment is already
 * committed by the time this runs, and failing the request would imply it
 * didn't happen.
 */
export async function sendHandoverEmails(h: Handover): Promise<void> {
  const link = `${h.portalUrl.replace(/\/$/, '')}/account-detail.html?id=${encodeURIComponent(h.accountId)}`;
  const who = `${h.accountName} (${h.providerLabel} · ${h.externalId})`;
  const where = possessiveAccount(h.tenantName);

  const sends: Array<Promise<unknown>> = [];

  sends.push(send(h, h.toEmail, {
    title: `You now manage ${h.accountName} in CloudMeter`,
    paragraphs: [
      `${h.actorName} assigned ${who} to you in ${where}.`,
      'As its manager you can open it, force a cost refresh, and act on its alerts.',
      h.fromName ? `It was previously managed by ${h.fromName}.` : 'It had no manager until now.',
    ],
    cta: { label: 'View the account', url: link },
  }));

  // Nothing to tell someone who was never there.
  if (h.fromEmail) {
    sends.push(send(h, h.fromEmail, {
      title: `${h.accountName} is now managed by ${h.toName}`,
      paragraphs: [
        `${h.actorName} reassigned ${who} in ${where} to ${h.toName}.`,
        'You keep whatever access you had to the account and its costs — you are '
          + 'simply no longer the person answerable for its spend.',
      ],
      cta: { label: 'View the account', url: link },
    }));
  }

  await Promise.all(sends);
}

async function send(h: Handover, to: string, mail: EmailBody): Promise<void> {
  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${h.fromEmailAddress}>`,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: mail.title },
      Body: {
        Text: { Data: renderEmailText(mail) },
        Html: { Data: renderEmailHtml(mail) },
      },
    },
  }));
}
