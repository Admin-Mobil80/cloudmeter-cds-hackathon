/**
 * Choosing the workspace a WhatsApp question is about.
 *
 * Asked about ACME, then "s3", the assistant answered with Mobil80's S3:
 * an unnamed question fell back to the portal's active workspace. Someone in
 * several workspaces now picks one, and the pick sticks until they name or
 * switch to another.
 */
import { decideWorkspace, pickFrom, workspaceNamedIn, type ChoiceSession } from '../functions/assistant/workspace-choice';

const WS = [
  { tenantId: 't-mobil80', name: 'Mobil80' },
  { tenantId: 't-acme', name: 'ACME' },
  { tenantId: 't-bright', name: 'Initech IT Services Pvt Ltd' },
];

describe('decideWorkspace', () => {
  it('never asks someone with one workspace', () => {
    const d = decideWorkspace('s3', [WS[0]], {});
    expect(d).toEqual({ kind: 'answer', tenantId: 't-mobil80', question: 's3', session: { selectedTenantId: 't-mobil80' } });
  });

  it('tries a question first when nothing is chosen', () => {
    // Service, account and tag questions are answered across workspaces; the
    // list is sent only if the agent reports this one needs a single workspace.
    expect(decideWorkspace('s3', WS, {})).toEqual({ kind: 'answer', tenantId: null, question: 's3', session: {} });
  });

  it('after the list, answers the original question with the pick', () => {
    const awaiting: ChoiceSession = { awaitingChoice: true, pendingQuestion: 'How much did we spend?' };
    expect(decideWorkspace('2', WS, awaiting)).toEqual({ kind: 'answer', tenantId: 't-acme', question: 'How much did we spend?', session: { selectedTenantId: 't-acme' } });
  });

  it('a workspace named in a question scopes that question only', () => {
    const first = decideWorkspace('acme cost', WS, {});
    expect(first).toMatchObject({ kind: 'answer', tenantId: 't-acme' });
    // The next question is back to all workspaces.
    expect(decideWorkspace('s3', WS, first.session)).toMatchObject({ kind: 'answer', tenantId: null, question: 's3' });
  });

  it('keeps a workspace chosen with "switch to", until "all"', () => {
    const chosen = decideWorkspace('switch to acme', WS, {});
    expect(chosen).toMatchObject({ kind: 'reply', session: { selectedTenantId: 't-acme' } });
    expect(decideWorkspace('s3', WS, chosen.session)).toMatchObject({ kind: 'answer', tenantId: 't-acme' });
    expect(decideWorkspace('s3 in Mobil80', WS, chosen.session)).toMatchObject({ kind: 'answer', tenantId: 't-mobil80', session: { selectedTenantId: 't-acme' } });
    const all = decideWorkspace('all', WS, chosen.session);
    expect(all).toMatchObject({ kind: 'reply', session: {} });
    expect(decideWorkspace('s3', WS, all.session)).toMatchObject({ kind: 'answer', tenantId: null });
  });

  it('lists again on "switch", and switches directly on "switch to X"', () => {
    expect(decideWorkspace('switch', WS, { selectedTenantId: 't-acme' })).toMatchObject({ kind: 'reply', session: { awaitingChoice: true } });
    expect(decideWorkspace('workspaces', WS, {})).toMatchObject({ kind: 'reply', session: { awaitingChoice: true } });
    expect(decideWorkspace('switch to initech', WS, {})).toMatchObject({ kind: 'reply', session: { selectedTenantId: 't-bright' } });
  });

  it('treats a non-pick reply to the list as a new question', () => {
    const awaiting: ChoiceSession = { awaitingChoice: true, pendingQuestion: 'old' };
    expect(decideWorkspace('lambda in ACME', WS, awaiting)).toMatchObject({ kind: 'answer', tenantId: 't-acme', question: 'lambda in ACME' });
    expect(decideWorkspace('lambda', WS, awaiting)).toMatchObject({ kind: 'answer', tenantId: null, question: 'lambda' });
  });
});

describe('helpers', () => {
  it('picks by number or name, and rejects out-of-range numbers', () => {
    expect(pickFrom('3', WS)?.tenantId).toBe('t-bright');
    expect(pickFrom('acme', WS)?.tenantId).toBe('t-acme');
    expect(pickFrom('7', WS)).toBeNull();
  });

  it('finds a workspace named in a sentence, by full name or first word', () => {
    expect(workspaceNamedIn('what is the S3 cost for ACME?', WS)?.tenantId).toBe('t-acme');
    expect(workspaceNamedIn('initech lambda', WS)?.tenantId).toBe('t-bright');
    expect(workspaceNamedIn('s3', WS)).toBeNull();
  });
});
