import { EMAIL } from './inbound';

/*
 * Inviting a teammate from WhatsApp.
 *
 * An Owner or Admin types "invite" (or "invite preeti@acme.com"), and
 * CloudMeter walks them through it: which workspace, the person's email, then
 * Member or Admin. Nothing is sent until that last reply, and the invite
 * itself goes through the same function the portal uses
 * (shared/team-invite.ts), with the same checks.
 *
 * Deliberately plain code, not the AI agent: the agent stays read-only, and
 * an invitation can never come from a model's guess.
 */

/** A workspace the person belongs to, with their role in it. */
export interface InviteWorkspace {
  tenantId: string;
  name: string;
  role: string;
}

/** Where an invite is up to, remembered between messages (briefly). */
export interface PendingInvite {
  name: string | null;
  email: string | null;
  tenantId: string | null;
  /** The workspaces this person may invite into. */
  options: InviteWorkspace[];
}

export type InviteStep =
  | { kind: 'reply'; message: string; pending: PendingInvite | null }
  | { kind: 'send'; tenantId: string; email: string; role: 'member' | 'admin'; name: string | null };

const CANCEL = /^(no|cancel|stop)\b/i;
const CANCEL_HINT = 'Or reply NO to cancel.';

/** "invite", "invite a teammate", "invite preeti@acme.com as admin"… */
export function isInviteRequest(text: string): boolean {
  return /^\s*invite\b/i.test(text);
}

/** Starts an invite; an email in the message is used, so it isn't asked for. */
export function startFromText(text: string, workspaces: InviteWorkspace[]): InviteStep {
  return begin(null, findEmail(text), workspaces);
}

function begin(name: string | null, email: string | null, workspaces: InviteWorkspace[]): InviteStep {
  const options = workspaces.filter((w) => w.role === 'owner' || w.role === 'admin');
  if (options.length === 0) {
    return { kind: 'reply', message: 'Only a workspace\'s Owner or Admin can invite people. Ask them to invite this person, or do it from Team at portal.cloudmeter.io.', pending: null };
  }
  return prompt({ name, email, tenantId: options.length === 1 ? options[0].tenantId : null, options });
}

export function continueInvite(pending: PendingInvite, text: string): InviteStep {
  const reply = text.trim();
  if (CANCEL.test(reply)) return { kind: 'reply', message: 'OK, no invitation sent.', pending: null };

  if (!pending.tenantId) {
    const picked = pickWorkspace(reply, pending.options);
    if (!picked) return { kind: 'reply', message: `Please reply with a number from the list.\n\n${workspaceList(pending.options)}\n\n${CANCEL_HINT}`, pending };
    return prompt({ ...pending, tenantId: picked.tenantId });
  }

  if (!pending.email) {
    const email = findEmail(reply);
    if (!email) return { kind: 'reply', message: `That doesn't look like an email address. Reply with the email of the person to invite, like name@company.com. ${CANCEL_HINT}`, pending };
    return prompt({ ...pending, email });
  }

  // "1"/"2" as listed, or the word itself.
  const ws = pending.options.find((w) => w.tenantId === pending.tenantId)!;
  if (/^(1|member)\b/i.test(reply)) return send(pending, 'member');
  if (/^(2|admin)\b/i.test(reply)) {
    if (ws.role !== 'owner') {
      return { kind: 'reply', message: `Admins can invite Members; only the Owner of ${ws.name} can add an Admin. Reply 1 to invite as a Member, or NO to cancel.`, pending };
    }
    return send(pending, 'admin');
  }
  return prompt(pending);
}

/** The next question, given what is already known. */
function prompt(p: PendingInvite): InviteStep {
  if (!p.tenantId) {
    return { kind: 'reply', message: `Which workspace should ${p.email ?? 'they'} join? Reply with its number:\n\n${workspaceList(p.options)}\n\n${CANCEL_HINT}`, pending: p };
  }
  if (!p.email) {
    const ws = p.options.find((w) => w.tenantId === p.tenantId)!;
    return { kind: 'reply', message: `Who would you like to invite to ${ws.name}? Reply with their email address; the invitation is emailed there. ${CANCEL_HINT}`, pending: p };
  }
  const ws = p.options.find((w) => w.tenantId === p.tenantId)!;
  const person = p.name ? `${p.name} (${p.email})` : p.email;
  // An Admin can only invite Members, so they get the one option.
  const choice = ws.role === 'owner'
    ? 'Reply with a number to send the invitation:\n\n1. Member: sees the cloud accounts you give them\n2. Admin: manages all cloud accounts and the team'
    : 'Reply 1 to send the invitation:\n\n1. Member: sees the cloud accounts you give them';
  return { kind: 'reply', message: `Invite ${person} to ${ws.name}?\n\n${choice}\n\n${CANCEL_HINT}`, pending: p };
}

function send(p: PendingInvite, role: 'member' | 'admin'): InviteStep {
  return { kind: 'send', tenantId: p.tenantId!, email: p.email!, role, name: p.name };
}

function pickWorkspace(reply: string, options: InviteWorkspace[]): InviteWorkspace | null {
  const n = /^\d+$/.test(reply) ? Number(reply) : NaN;
  if (n >= 1 && n <= options.length) return options[n - 1];
  const wanted = reply.toLowerCase();
  const byName = options.filter((w) => w.name.toLowerCase() === wanted);
  return byName.length === 1 ? byName[0] : null;
}

function workspaceList(options: InviteWorkspace[]): string {
  return options.map((w, i) => `${i + 1}. ${w.name}`).join('\n');
}

function findEmail(text: string): string | null {
  const word = text.split(/[\s,;<>()]+/).map((w) => w.replace(/[.]+$/, '').toLowerCase()).find((w) => EMAIL.test(w));
  return word ?? null;
}
