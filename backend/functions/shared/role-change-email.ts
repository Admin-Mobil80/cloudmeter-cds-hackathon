import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { renderEmailHtml, renderEmailText, EmailBody } from './email-layout';
import { possessiveAccount } from './handover-email';

const ses = new SESClient({});

export type TeamRole = 'admin' | 'member';

export interface RoleChange {
  toEmail: string;
  toName: string;
  previousRole: TeamRole;
  newRole: TeamRole;
  /** Who made the change — a person's name, not an address. */
  actorName: string;
  tenantName: string;
  portalUrl: string;
  fromEmailAddress: string;
}

/**
 * What each role can actually reach, in the words the person will care about.
 *
 * Kept as plain sentences rather than a feature matrix: someone reading this
 * on a phone wants to know whether their day changes, not to audit a
 * permission table.
 */
const WHAT_YOU_CAN_DO: Record<TeamRole, string> = {
  admin: 'As an Admin you can connect, rename and remove cloud accounts, see '
    + 'organisation-wide spend on the dashboard, and manage the team.',
  member: 'As a Member you see the cloud accounts assigned to you, along with '
    + 'their costs and alerts. Organisation-wide totals and team management '
    + "aren't part of this role.",
};

/**
 * Tells someone their role changed, because nothing else will.
 *
 * A role decides what the portal shows and what the API allows, and it is
 * changed by someone else entirely. Without this the person finds out by
 * hitting a page that has quietly disappeared, or by never discovering the
 * one they gained — and a demotion in particular reads as a bug when it
 * arrives unannounced.
 *
 * Delivery failures are the caller's to swallow: the change is committed
 * before this runs, so failing the request would imply it hadn't been.
 */
export async function sendRoleChangeEmail(change: RoleChange): Promise<void> {
  const where = possessiveAccount(change.tenantName);
  const promoted = change.newRole === 'admin';
  const link = `${change.portalUrl.replace(/\/$/, '')}/dashboard.html`;

  const mail: EmailBody = {
    title: promoted
      ? `You're now an Admin in ${change.tenantName}`
      : `Your role in ${change.tenantName} is now Member`,
    paragraphs: [
      `${change.actorName} changed your role in ${where} from `
        + `${label(change.previousRole)} to ${label(change.newRole)}.`,
      WHAT_YOU_CAN_DO[change.newRole],
      // Named rather than hinted at: someone who has just lost access should
      // be told who to ask, not left to work out whose decision it was.
      promoted
        ? 'The change is already in effect — sign in to see it.'
        : `If this wasn't expected, ${change.actorName} is the person to ask.`,
    ],
    cta: { label: 'Open CloudMeter', url: link },
  };

  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${change.fromEmailAddress}>`,
    Destination: { ToAddresses: [change.toEmail] },
    Message: {
      Subject: { Data: mail.title },
      Body: {
        Text: { Data: renderEmailText(mail) },
        Html: { Data: renderEmailHtml(mail) },
      },
    },
  }));
}

function label(role: TeamRole): string {
  return role === 'admin' ? 'Admin' : 'Member';
}
