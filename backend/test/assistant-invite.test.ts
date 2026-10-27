/**
 * Inviting a teammate from WhatsApp: "invite" walks the Owner or Admin
 * through workspace, email and role, and nothing is sent until that final
 * reply.
 */
import { continueInvite, isInviteRequest, startFromText, type InviteStep, type PendingInvite } from '../functions/assistant/invite-flow';

const OWNER_ONE = [{ tenantId: 't1', name: 'Acme', role: 'owner' }];
const MANY = [
  { tenantId: 't1', name: 'Acme', role: 'owner' },
  { tenantId: 't2', name: 'Globex', role: 'admin' },
  { tenantId: 't3', name: 'Initech', role: 'member' },
];

function reply(step: InviteStep): { message: string; pending: PendingInvite | null } {
  if (step.kind !== 'reply') throw new Error(`expected a reply, got ${step.kind}`);
  return step;
}

describe('starting an invite', () => {
  it('starts on "invite", with or without an email', () => {
    expect(isInviteRequest('invite')).toBe(true);
    expect(isInviteRequest('Invite a teammate')).toBe(true);
    expect(isInviteRequest('invite preeti@acme.com as a member')).toBe(true);
    expect(isInviteRequest('how much did we spend?')).toBe(false);
    expect(isInviteRequest('who did I invite?')).toBe(false);
  });

  it('asks for the email when none was given', () => {
    const step = reply(startFromText('invite', OWNER_ONE));
    expect(step.message).toContain('Who would you like to invite to Acme? Reply with their email address');
    expect(step.pending).toMatchObject({ tenantId: 't1', email: null });
  });

  it('goes straight to the role when the email was given', () => {
    const step = reply(startFromText('invite Preeti@Acme.com.', OWNER_ONE));
    expect(step.message).toContain('Invite preeti@acme.com to Acme?');
    expect(step.message).toContain('1. Member');
    expect(step.message).toContain('2. Admin');
  });

  it('asks which workspace, listing only those the person may invite into', () => {
    const step = reply(startFromText('invite', MANY));
    expect(step.message).toContain('1. Acme\n2. Globex');
    expect(step.message).not.toContain('Initech');
  });

  it('refuses a Member', () => {
    const step = reply(startFromText('invite', [{ tenantId: 't3', name: 'Initech', role: 'member' }]));
    expect(step.message).toContain('Only a workspace\'s Owner or Admin can invite people');
    expect(step.pending).toBeNull();
  });
});

describe('continuing an invite', () => {
  const atRole: PendingInvite = { name: null, email: 'preeti@acme.com', tenantId: 't1', options: OWNER_ONE };

  it('sends only after choosing 1 (Member) or 2 (Admin)', () => {
    expect(continueInvite(atRole, '1')).toEqual({ kind: 'send', tenantId: 't1', email: 'preeti@acme.com', role: 'member', name: null });
    expect(continueInvite(atRole, '2')).toMatchObject({ kind: 'send', role: 'admin' });
    expect(continueInvite(atRole, 'member')).toMatchObject({ kind: 'send', role: 'member' });
    expect(continueInvite(atRole, 'Admin please')).toMatchObject({ kind: 'send', role: 'admin' });
    expect(reply(continueInvite(atRole, '3')).pending).toEqual(atRole);
  });

  it('asks again on anything else, and cancels on NO', () => {
    expect(reply(continueInvite(atRole, 'yes')).pending).toEqual(atRole);
    expect(reply(continueInvite(atRole, 'No')).pending).toBeNull();
    expect(reply(continueInvite(atRole, 'cancel')).message).toBe('OK, no invitation sent.');
  });

  it('lets an Admin invite only a Member', () => {
    const admin: PendingInvite = { ...atRole, tenantId: 't2', options: MANY.slice(0, 2) };
    expect(reply(continueInvite(admin, '2')).message).toContain('only the Owner of Globex can add an Admin');
    expect(reply(continueInvite(admin, 'x')).message).not.toContain('2. Admin');
    expect(continueInvite(admin, '1')).toMatchObject({ kind: 'send', role: 'member', tenantId: 't2' });
  });

  it('takes the workspace by number or name', () => {
    const choosing: PendingInvite = { name: null, email: 'preeti@acme.com', tenantId: null, options: MANY.slice(0, 2) };
    expect(reply(continueInvite(choosing, '2')).pending?.tenantId).toBe('t2');
    expect(reply(continueInvite(choosing, 'acme')).pending?.tenantId).toBe('t1');
    expect(reply(continueInvite(choosing, '7')).message).toContain('Please reply with a number');
  });

  it('takes the email when it was missing', () => {
    const noEmail: PendingInvite = { name: null, email: null, tenantId: 't1', options: OWNER_ONE };
    expect(reply(continueInvite(noEmail, 'it is Preeti@Acme.com')).pending?.email).toBe('preeti@acme.com');
    expect(reply(continueInvite(noEmail, 'preeti at acme')).message).toContain("doesn't look like an email");
  });
});
