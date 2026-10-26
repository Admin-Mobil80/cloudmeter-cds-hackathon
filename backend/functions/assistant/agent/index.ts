import './region';
import http from 'node:http';
import {
  BedrockRuntimeClient, ConverseCommand,
  type ContentBlock, type Message, type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { runTool, TOOL_SPECS, NEEDS_WORKSPACE, type AssistantContext } from '../tools';

/*
 * CloudMeter's cost assistant, hosted on Amazon Bedrock AgentCore Runtime.
 *
 * AgentCore runs this file as a small HTTP server: GET /ping for health, and
 * POST /invocations with { question, history, context }. The agent loop is
 * Bedrock's Converse API with tool use — the model decides which read-only
 * CloudMeter tool to call, we run it against the workspace in `context`, and
 * hand the result back until the model has an answer.
 *
 * `context` comes from the inbound WhatsApp Lambda, which is the only caller
 * allowed to invoke this runtime (IAM). It is never taken from the model.
 */

const PORT = 8080;
const MODEL_ID = process.env.ASSISTANT_MODEL_ID ?? 'us.amazon.nova-2-lite-v1:0';
/** Model calls per question. Bounds both latency and cost if the model keeps asking for tools. */
const MAX_ROUNDS = 6;

const bedrock = new BedrockRuntimeClient({});

interface Turn { role: 'user' | 'assistant'; text: string }
interface Invocation { question: string; history?: Turn[]; context: AssistantContext }

function systemPrompt(ctx: AssistantContext): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const current = ctx.workspaces.length === 1 ? ctx.workspaces[0] : ctx.workspaces.find((w) => w.tenantId === ctx.defaultTenantId);
  const others = ctx.workspaces.filter((w) => w !== current).map((w) => `"${w.name}"`);
  const scope = current
    ? `This conversation is about the "${current.name}" workspace${others.length ? `; they also belong to ${others.join(', ')}` : ''}. Answer for "${current.name}" unless they name another workspace.`
    : `They belong to ${others.length} workspaces (${others.join(', ')}). Unless they name one, answer for all of them: call the tools without a workspace and they return one line per workspace. Only pass a workspace the user named.`;
  return [
    `You are CloudMeter's cost assistant, answering on WhatsApp${ctx.userName ? ` for ${ctx.userName}` : ''}.`,
    `${scope} A workspace is a whole CloudMeter organisation; inside it are cloud accounts.`,
    `Today is ${today} (${ctx.timezone}). Amounts from the tools are already in the workspace's currency; quote them as given.`,
    'CloudMeter monitors cloud spend (AWS, Azure, Google Cloud, Alibaba Cloud, Huawei Cloud, OpenAI) and detects cost spikes. Cloud providers report cost a day late, so "today" is usually not in the data yet.',
    'Rules:',
    '- Every figure and every name (workspace, cloud account, service) you state must come from a tool result in this conversation. Never estimate or invent numbers or names; if the tools do not have it, say so.',
    '- If the user names one of their workspaces, pass that name as `workspace` to the tools. Otherwise omit it and the current workspace is used.',
    '- Every tool result says which workspace it is from. Name that workspace in your answer.',
    '- If the user names a workspace or cloud account you cannot find, say plainly that you could not find it and list what does exist. Never answer with a different workspace\'s or account\'s figures instead.',
    '- A name on its own (e.g. "cyberdyne", "staging", "lambda") is a question about that thing. If it is one of their workspaces, call spend_summary with it; otherwise call account_spend with it, which finds cloud accounts and services. Only if that finds nothing, say you could not find it.',
    '- Always call the tool you need straight away and answer with the result. Never reply that you will check, or ask the user to wait.',
    '- Projects, applications, environments, teams and owners are cloud resource tags. For any such question — even a bare word like "project" or "application" — call tag_spend with the user\'s word first; it searches all their workspaces. Use list_tags only when they ask which tags exist in a workspace. Say how much is untagged when the tool reports it.',
    '- Never add up, subtract or average figures yourself. Quote the totals the tools give; if a tool gives no total, do not state one.',
    '- When a result lists cost per workspace, show every workspace on its own line with its amount, largest first.',
    '- Use spend_summary for general questions, account_spend for one named cloud account, cost_breakdown for "what costs most" (with search for one service, account for one account\'s services), open_alerts for spikes and anomalies, daily_spend for date ranges, comparisons and "when did it start", list_workspaces when asked which workspaces they have.',
    '- You can only read data. You cannot change settings, connect accounts, or act on a cloud account; point to portal.cloudmeter.io for that.',
    '- If the question is not about their cloud costs, say briefly what you can help with.',
    '- Write for WhatsApp: at most about 600 characters, short lines, *single asterisks* for bold, no tables, no markdown headings, at most one emoji.',
  ].join('\n');
}

/**
 * Models write Markdown; WhatsApp has its own, smaller dialect. **bold** shows
 * as literal asterisks there, so it is turned into WhatsApp's *bold*, and
 * Markdown headings into plain bold lines.
 */
export function forWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

async function answer(inv: Invocation): Promise<{ answer: string; toolsUsed: string[]; workspaceTenantId?: string; needsWorkspace?: boolean }> {
  const messages: Message[] = [
    ...(inv.history ?? []).slice(-6).map((t): Message => ({ role: t.role, content: [{ text: t.text }] })),
    { role: 'user', content: [{ text: inv.question }] },
  ];
  const toolsUsed: string[] = [];
  // The workspace the last tool result came from, so the caller can keep the
  // conversation on it. Read from the result's own label, never the model.
  let workspaceTenantId: string | undefined;
  const noteWorkspace = (result: unknown) => {
    const r = result as { workspace?: unknown; matches?: Array<{ workspace?: unknown }>; otherWorkspace?: boolean; acrossWorkspaces?: boolean };
    // An account found in another workspace, or an all-workspaces answer,
    // answers that one question; it chooses no workspace.
    if (r?.otherWorkspace || r?.acrossWorkspaces) return;
    const name = typeof r?.workspace === 'string' ? r.workspace : r?.matches?.length === 1 ? r.matches[0].workspace : undefined;
    const hit = inv.context.workspaces.find((w) => w.name === name);
    if (hit) workspaceTenantId = hit.tenantId;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt(inv.context) }],
      messages,
      // The first call must use a tool. Without this the model once answered
      // a follow-up ("lambda") from the shape of its previous reply, with
      // figures that were nowhere in CloudMeter's data. Every answer now
      // starts from a fresh read.
      toolConfig: { tools: TOOL_SPECS as unknown as Tool[], ...(round === 0 ? { toolChoice: { any: {} } } : {}) },
      inferenceConfig: { maxTokens: 700, temperature: 0.2 },
    }));
    const out = res.output?.message;
    if (!out) break;
    messages.push(out);

    if (res.stopReason !== 'tool_use') {
      const text = (out.content ?? []).map((c) => c.text ?? '').join('').trim();
      return { answer: forWhatsApp(text) || 'Sorry, I could not work that out.', toolsUsed, workspaceTenantId };
    }

    const results: ContentBlock[] = [];
    for (const block of out.content ?? []) {
      if (!block.toolUse) continue;
      const { toolUseId, name, input } = block.toolUse;
      toolsUsed.push(name!);
      try {
        const result = await runTool(name!, (input ?? {}) as Record<string, unknown>, inv.context);
        // A question that needs one workspace, with none chosen: stop here and
        // let the WhatsApp side ask which — deterministic, not left to the model.
        if ((result as { error?: unknown })?.error === NEEDS_WORKSPACE) {
          return { answer: '', toolsUsed: [...toolsUsed], needsWorkspace: true };
        }
        noteWorkspace(result);
        // Converse wants a JSON object here; a list is wrapped rather than refused.
        const json = Array.isArray(result) ? { items: result } : result;
        results.push({ toolResult: { toolUseId, content: [{ json: json as never }] } });
      } catch (err) {
        console.error('tool failed', name, (err as Error).message);
        results.push({ toolResult: { toolUseId, status: 'error', content: [{ text: 'The tool failed; tell the user the data is unavailable right now.' }] } });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'Sorry, that took too many steps. Try asking a more specific question.', toolsUsed, workspaceTenantId };
}

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/ping') return send(200, { status: 'Healthy' });
  if (req.method !== 'POST' || req.url !== '/invocations') return send(404, { error: 'not found' });

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    try {
      const inv = JSON.parse(raw) as Invocation;
      if (!inv?.question || !inv?.context?.workspaces?.length) return send(400, { error: 'question and context are required' });
      const started = Date.now();
      const result = await answer(inv);
      console.log(JSON.stringify({ defaultTenantId: inv.context.defaultTenantId, toolsUsed: result.toolsUsed, ms: Date.now() - started }));
      send(200, result);
    } catch (err) {
      console.error('invocation failed', (err as Error).message);
      send(500, { error: 'invocation failed' });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`CloudMeter assistant listening on ${PORT}`));
