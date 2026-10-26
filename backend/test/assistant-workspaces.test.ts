/**
 * Which workspace a WhatsApp question reads.
 *
 * Asked about ACME while sitting in Mobil80, the first version could only
 * see Mobil80 — and the model answered with Mobil80's largest account,
 * labelled as ACME. A wrong workspace's figures are worse than none, so a
 * name must resolve to exactly one of the user's own workspaces or fail with
 * the list.
 */
import { resolveWorkspace, type AssistantContext, type WorkspaceScope } from '../functions/assistant/tools';

const ws = (tenantId: string, name: string): WorkspaceScope => ({
  tenantId, name, role: 'admin', accountIds: null, currency: { code: 'INR', symbol: '₹', rate: 95 },
});

const ctx: AssistantContext = {
  workspaces: [ws('t-mobil80', 'Mobil80'), ws('t-acme', 'ACME'), ws('t-bright', 'Initech IT Services Pvt Ltd'), ws('t-bright2', 'Initech Labs')],
  defaultTenantId: 't-mobil80',
  userName: 'Neeta',
  timezone: 'Asia/Kolkata',
};

const id = (r: ReturnType<typeof resolveWorkspace>) => ('error' in r ? r : r.tenantId);

describe('resolveWorkspace', () => {
  it('uses the current workspace when none is named', () => {
    expect(id(resolveWorkspace(undefined, ctx))).toBe('t-mobil80');
    expect(id(resolveWorkspace('  ', ctx))).toBe('t-mobil80');
  });

  it('finds a workspace by name, ignoring case and punctuation', () => {
    expect(id(resolveWorkspace('acme', ctx))).toBe('t-acme');
    expect(id(resolveWorkspace('ACME Technologies Pvt Ltd', ctx))).toBe('t-acme');
    expect(id(resolveWorkspace('initech it services', ctx))).toBe('t-bright');
  });

  it('refuses a name the user has no workspace for, and lists theirs', () => {
    const r = resolveWorkspace('Zenith', ctx);
    expect(r).toEqual({ error: expect.stringContaining('no workspace called "Zenith"'), yourWorkspaces: ['Mobil80', 'ACME', 'Initech IT Services Pvt Ltd', 'Initech Labs'] });
  });

  it('asks rather than guesses when a name fits more than one', () => {
    const r = resolveWorkspace('initech', ctx);
    expect(r).toEqual({ error: expect.stringContaining('more than one'), yourWorkspaces: ['Initech IT Services Pvt Ltd', 'Initech Labs'] });
  });

  it('never reaches a workspace the user is not in', () => {
    const r = resolveWorkspace('t-other', ctx);
    expect('error' in r).toBe(true);
  });
});
