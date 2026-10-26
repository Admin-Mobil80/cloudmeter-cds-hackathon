import { norm } from './names';

/**
 * Which workspace a WhatsApp question is about, decided in code rather than by
 * the model.
 *
 * For someone in several workspaces, a question covers all of them — one line
 * per workspace — whatever the portal is set to. Naming a workspace scopes
 * that question; "switch to X" (or picking from the "switch" list) makes X
 * stick until "all". Someone in one workspace is never asked anything.
 */

export interface ChoiceSession {
  selectedTenantId?: string;
  /** Set while the numbered list is out, waiting for a pick. */
  awaitingChoice?: boolean;
  /** The question that prompted the list, answered once a workspace is picked. */
  pendingQuestion?: string;
}

export interface WorkspaceName { tenantId: string; name: string }

export type Decision =
  /** tenantId null: none chosen yet — answer what can be answered across workspaces, ask if it can't. */
  | { kind: 'answer'; tenantId: string | null; question: string; session: ChoiceSession }
  | { kind: 'reply'; message: string; session: ChoiceSession };

const SWITCH_ONLY = /^(switch|change)(\s+(the\s+)?(workspace|organi[sz]ation)s?)?\s*[.!?]*$/i;
const LIST_ONLY = /^(list\s+|show\s+|my\s+)?(workspaces?|organi[sz]ations?)\s*[.!?]*$/i;
const ALL_ONLY = /^(all|all\s+(of\s+)?(my\s+)?(workspaces|organi[sz]ations)|every\s*thing)\s*[.!?]*$/i;
const SWITCH_TO = /^(switch|change|use|go)\s+(to\s+)?(the\s+)?(.+?)(\s+(workspace|organi[sz]ation))?\s*[.!?]*$/i;

/** The workspace named inside a question, if exactly one is. Longest name wins. */
export function workspaceNamedIn(text: string, workspaces: WorkspaceName[]): WorkspaceName | null {
  const t = norm(text);
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const hits = workspaces.filter((w) => {
    const n = norm(w.name);
    if (n.length >= 3 && t.includes(n)) return true;
    // A long name is usually typed by its first word: "initech" for
    // "Initech IT Services Pvt Ltd".
    const first = norm(w.name.split(/\s+/)[0] ?? '');
    return first.length >= 4 && words.has(first);
  });
  if (hits.length === 0) return null;
  const longest = Math.max(...hits.map((w) => norm(w.name).length));
  const best = hits.filter((w) => norm(w.name).length === longest);
  return best.length === 1 ? best[0] : null;
}

/** A reply to the numbered list: its number, or a name that fits one workspace. */
export function pickFrom(text: string, workspaces: WorkspaceName[]): WorkspaceName | null {
  const t = text.trim();
  const n = Number(t.replace(/[^0-9]/g, ''));
  if (/^\s*#?\d+\s*[.)]?\s*$/.test(t) && n >= 1 && n <= workspaces.length) return workspaces[n - 1];
  const exact = workspaces.filter((w) => norm(w.name) === norm(t));
  if (exact.length === 1) return exact[0];
  // Just a name ("acme", "the initech one") is a pick; a sentence that
  // mentions one ("lambda in ACME") is a new question, decided elsewhere.
  if (t.split(/\s+/).length > 3) return null;
  const named = workspaceNamedIn(t, workspaces);
  const rest = norm(t.toLowerCase().replace(/\b(the|one|workspace|organi[sz]ation|please)\b/g, ''));
  return named && (rest === norm(named.name) || rest === norm(named.name.split(/\s+/)[0] ?? '')) ? named : null;
}

export function chooseMessage(workspaces: WorkspaceName[]): string {
  const list = workspaces.slice(0, 30).map((w, i) => `${i + 1}. ${w.name}`).join('\n');
  return `You're in ${workspaces.length} workspaces. Which one is this about?\n\n${list}\n\nReply with the number or the name. Say *switch* any time to change.`;
}

export function decideWorkspace(text: string, workspaces: WorkspaceName[], session: ChoiceSession): Decision {
  const t = text.trim();
  if (workspaces.length === 1) {
    return { kind: 'answer', tenantId: workspaces[0].tenantId, question: t, session: { selectedTenantId: workspaces[0].tenantId } };
  }

  const ask = (pendingQuestion?: string): Decision => ({
    kind: 'reply',
    message: chooseMessage(workspaces),
    session: { awaitingChoice: true, ...(pendingQuestion ? { pendingQuestion } : {}) },
  });
  const nowUsing = (w: WorkspaceName): Decision => ({
    kind: 'reply',
    message: `Now using *${w.name}* for your questions. What would you like to know? Say *all* to go back to all your workspaces.`,
    session: { selectedTenantId: w.tenantId },
  });

  if (SWITCH_ONLY.test(t) || LIST_ONLY.test(t)) return ask();
  if (ALL_ONLY.test(t)) {
    return { kind: 'reply', message: 'Now answering for *all* your workspaces. Ask me anything, e.g. "How much did we spend this month?"', session: {} };
  }

  const switchTo = SWITCH_TO.exec(t);
  if (switchTo) {
    const target = pickFrom(switchTo[4], workspaces);
    if (target) return nowUsing(target);
  }

  if (session.awaitingChoice) {
    const picked = pickFrom(t, workspaces);
    if (picked) {
      if (session.pendingQuestion) {
        return { kind: 'answer', tenantId: picked.tenantId, question: session.pendingQuestion, session: { selectedTenantId: picked.tenantId } };
      }
      return nowUsing(picked);
    }
    // Not a pick: a fresh question, decided below like any other.
  }

  // A workspace named in the question scopes that question only. Each
  // question otherwise covers all of their workspaces — only an explicit
  // "switch to X" makes one stick.
  const named = workspaceNamedIn(t, workspaces);
  if (named) return { kind: 'answer', tenantId: named.tenantId, question: t, session: { ...session, awaitingChoice: undefined, pendingQuestion: undefined } };

  const selected = workspaces.find((w) => w.tenantId === session.selectedTenantId);
  if (selected) return { kind: 'answer', tenantId: selected.tenantId, question: t, session: { selectedTenantId: selected.tenantId } };

  // Nothing chosen: try anyway. Service, account and tag questions are
  // answered across all their workspaces; the agent reports back if this one
  // needs a single workspace, and only then is the list sent.
  return { kind: 'answer', tenantId: null, question: t, session: {} };
}
