import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { renderEmailHtml, renderEmailText, EmailBody } from './email-layout';
import { possessiveAccount } from './handover-email';
import { PeriodKind } from './subscription-period';
import { redirectNotification } from './email-redirect';

const ses = new SESClient({});

export type NoticeStage = 'ending-soon' | 'ended';

export interface RenewalNotice {
  toEmail: string;
  toName: string;
  tenantName: string;
  kind: PeriodKind;
  stage: NoticeStage;
  endsAt: string;
  daysLeft: number;
  /** Set when the subscription is on a gateway that should have charged it. */
  autoRenews: boolean;
  portalUrl: string;
  fromEmailAddress: string;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Tells the Owner their access is about to lapse, or has.
 *
 * Only the Owner: they are the one who can actually pay, and a renewal notice
 * to a Member is an alarm about something they cannot act on.
 *
 * Sent only when the account has genuinely not renewed. A subscription that
 * auto-charged has already had its end date moved forward by the gateway
 * webhook, so by the time this runs it is not in the window at all — the
 * "unless the auto-charge took effect" case needs no special handling, it just
 * never matches.
 */
export async function sendRenewalNotice(n: RenewalNotice): Promise<void> {
  const where = possessiveAccount(n.tenantName);
  const link = `${n.portalUrl.replace(/\/$/, '')}/billing.html`;
  const mail = n.stage === 'ended' ? endedMail(n, where, link) : endingSoonMail(n, where, link);

  const route = redirectNotification(n.toEmail, mail.title);
  if (route.redirected) {
    console.log('Renewal notice redirected', { intendedFor: route.intendedFor, to: route.to });
  }

  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${n.fromEmailAddress}>`,
    Destination: { ToAddresses: [route.to] },
    Message: {
      Subject: { Data: route.subject },
      Body: {
        Text: { Data: renderEmailText(mail) },
        Html: { Data: renderEmailHtml(mail) },
      },
    },
  }));
}

function endingSoonMail(n: RenewalNotice, where: string, link: string): EmailBody {
  const days = n.daysLeft === 1 ? 'tomorrow' : `in ${n.daysLeft} days`;

  if (n.kind === 'trial') {
    return {
      title: `Your CloudMeter trial ends ${days}`,
      paragraphs: [
        `The free trial on ${where} ends on ${when(n.endsAt)}.`,
        'Choosing a plan keeps your connected accounts, their cost history and '
          + 'your alert rules exactly as they are — nothing is re-set up.',
        'If you do nothing, the account stays but stops monitoring.',
      ],
      cta: { label: 'Choose a plan', url: link },
    };
  }

  // An auto-renewing subscription still gets this, worded as a heads-up rather
  // than a demand: the card on file can have expired, and the first anyone
  // hears of that is usually a failed charge.
  if (n.autoRenews) {
    return {
      title: `CloudMeter renews ${days}`,
      paragraphs: [
        `The subscription on ${where} renews automatically on ${when(n.endsAt)}. `
          + 'You do not need to do anything.',
        'Worth a glance only if the card or mandate on file has changed since '
          + 'you set it up — a failed charge is the usual way people find out it has.',
      ],
      cta: { label: 'View billing', url: link },
    };
  }

  return {
    title: `CloudMeter subscription ends ${days}`,
    paragraphs: [
      `The subscription on ${where} ends on ${when(n.endsAt)} and will not renew on its own.`,
      'Renewing keeps your connected accounts, their cost history and your alert '
        + 'rules exactly as they are.',
    ],
    cta: { label: 'Renew now', url: link },
  };
}

function endedMail(n: RenewalNotice, where: string, link: string): EmailBody {
  if (n.kind === 'trial') {
    return {
      title: 'Your CloudMeter trial has ended',
      paragraphs: [
        `The free trial on ${where} ended on ${when(n.endsAt)}.`,
        'Your connected accounts and their cost history are still here. Choosing '
          + 'a plan picks up exactly where the trial left off.',
      ],
      cta: { label: 'Choose a plan', url: link },
    };
  }

  return {
    title: 'Your CloudMeter subscription has ended',
    paragraphs: [
      `The subscription on ${where} ended on ${when(n.endsAt)}.`,
      n.autoRenews
        ? 'The automatic charge did not go through — usually an expired card or a '
          + 'cancelled mandate. Renewing takes a moment and nothing has been lost.'
        : 'Renewing keeps your connected accounts, their cost history and your alert '
          + 'rules exactly as they are.',
    ],
    cta: { label: 'Renew now', url: link },
  };
}
