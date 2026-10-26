import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../shared/ddb';
import { buildDashboardSummary } from '../shared/dashboard-summary';
import { money } from '../shared/digest';
import type { DisplayCurrency } from '../shared/display-currency';
import { norm, cleanQuery, nameMatcher } from './names';

/** One workspace the asking user belongs to, with what they may see in it. */
export interface WorkspaceScope {
  tenantId: string;
  name: string;
  role: string;
  /** A Member's mapped accounts; null for Owners and Admins, who see all. */
  accountIds: string[] | null;
  currency: Pick<DisplayCurrency, 'code' | 'symbol' | 'rate'>;
}

/**
 * Who the assistant is answering for. Built by the inbound Lambda from the
 * verified WhatsApp number — never from anything the model says — and passed
 * to every tool. A tool can only ever read one of `workspaces`; a name the
 * model passes is matched against this list and nothing else.
 */
export interface AssistantContext {
  workspaces: WorkspaceScope[];
  /**
   * The workspace this conversation is about. Empty when someone in several
   * workspaces has not chosen one yet: questions that can be answered across
   * all of them (a service, an account, a tag) still are, and anything that
   * needs one workspace asks — see NEEDS_WORKSPACE.
   */
  defaultTenantId: string | null;
  userName: string | null;
  timezone: string;
}

/**
 * Returned when a question needs one workspace and none is chosen. The agent
 * stops on it and the WhatsApp Lambda sends the numbered list.
 */
export const NEEDS_WORKSPACE = 'NEEDS_WORKSPACE: this question needs one workspace and the user has not chosen one.';

const WORKSPACE_ARG = {
  workspace: {
    type: 'string',
    description: 'Name of the workspace to read, if the user named one. Omit to use the workspace they are currently in.',
  },
} as const;



/**
 * The workspace a tool call reads. No name: the user's current one. A name:
 * exactly one of their own workspaces must match, or the call fails with the
 * list — it never falls back to a different workspace, because an answer
 * about the wrong workspace is worse than no answer.
 */
export function resolveWorkspace(name: unknown, ctx: AssistantContext): WorkspaceScope | { error: string; yourWorkspaces: string[] } {
  const all = ctx.workspaces;
  const names = all.map((w) => w.name);
  if (typeof name !== 'string' || !name.trim()) {
    if (all.length === 1) return all[0];
    const chosen = all.find((w) => w.tenantId === ctx.defaultTenantId);
    if (chosen) return chosen;
    return { error: NEEDS_WORKSPACE, yourWorkspaces: names };
  }
  const q = norm(name);
  const exact = all.filter((w) => norm(w.name) === q);
  // Either way round: "wrk" finds ACME, and so does "ACME Technologies".
  const partial = (w: WorkspaceScope) => {
    const n = norm(w.name);
    return (q.length >= 3 && n.includes(q)) || (n.length >= 3 && q.includes(n));
  };
  const matches = exact.length ? exact : all.filter(partial);
  if (matches.length === 1) return matches[0];
  return {
    error: matches.length
      ? `"${name}" matches more than one of the user's workspaces; ask which one.`
      : `The user has no workspace called "${name}". Do not answer with another workspace's figures.`,
    yourWorkspaces: matches.length ? matches.map((w) => w.name) : names,
  };
}

/** The tool list as Bedrock's Converse API wants it. */
export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'list_workspaces',
      description: 'The CloudMeter workspaces this user belongs to, their role in each, and which one they are currently in.',
      inputSchema: { json: { type: 'object', properties: {} } },
    },
  },
  {
    toolSpec: {
      name: 'spend_summary',
      description: 'Month-to-date cloud spend for the workspace: total, change against the same days last month, projected month-end, spend per cloud provider, the top services, and how many cost anomalies are open. Use this first for any general question about spend.',
      inputSchema: { json: { type: 'object', properties: { ...WORKSPACE_ARG } } },
    },
  },
  {
    toolSpec: {
      name: 'account_spend',
      description: 'Look up anything the user names that is not one of their workspaces: a cloud account (AWS account, Azure subscription, OpenAI organisation…) or, if no account matches, a service such as "Lambda" or "S3". Returns month-to-date spend, change against the same days last month, top services and open anomalies. Searches the current (or named) workspace first, then the user\'s other workspaces, and says where it found it. Call this first for any bare name.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'The cloud account name, or part of it' },
            ...WORKSPACE_ARG,
          },
          required: ['account'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'tag_spend',
      description: 'Cost by cloud resource tag this month — for questions about a project, application, environment, team, owner or any tag. Give a tag value (e.g. "HelloWRK", "production") to get its cost by account, or a tag name (e.g. "Project", "Environment") to get each of its values. Searches all of the user\'s workspaces unless one is named. Only tagged resources can be split this way; untagged cost is reported separately.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'A tag value or tag name, as the user said it' },
            ...WORKSPACE_ARG,
          },
          required: ['tag'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'list_tags',
      description: 'The cloud resource tags used in a workspace this month (e.g. Project, Environment, Application) with their biggest values and untagged cost. Use when asked which tags, projects or applications exist.',
      inputSchema: { json: { type: 'object', properties: { ...WORKSPACE_ARG } } },
    },
  },
  {
    toolSpec: {
      name: 'cost_breakdown',
      description: 'Month-to-date spend broken down by service, by cloud account, or by cloud provider, largest first, with each item\'s share and its change against the same days last month (services only). Use `search` to find a specific service such as "Lambda" wherever it ranks, and `account` to break down one cloud account.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            ...WORKSPACE_ARG,
            by: { type: 'string', enum: ['service', 'account', 'provider'] },
            search: { type: 'string', description: 'Only items whose name contains this, e.g. "Lambda" — searches every item, not just the largest' },
            account: { type: 'string', description: 'Only this cloud account (name or part of it)' },
            limit: { type: 'integer', minimum: 1, maximum: 15 },
          },
          required: ['by'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'open_alerts',
      description: 'Cost anomalies CloudMeter has detected (cost spikes), newest first: which service and account, when, normal versus current daily cost, estimated impact, likely root cause and suggested action.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { ...WORKSPACE_ARG, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'daily_spend',
      description: 'Spend per day between two dates (inclusive, at most 62 days), optionally for one service and/or one cloud account, plus the biggest services over that range. Use it to compare weeks, find when a cost started rising, or explain a jump.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            ...WORKSPACE_ARG,
            from: { type: 'string', description: 'YYYY-MM-DD' },
            to: { type: 'string', description: 'YYYY-MM-DD' },
            service: { type: 'string', description: 'Exact or partial service name, e.g. "Lambda"' },
            account: { type: 'string', description: 'Exact or partial cloud account name' },
          },
          required: ['from', 'to'],
        },
      },
    },
  },
] as const;

type ToolInput = Record<string, unknown>;

interface AccountRow { accountId: string; name: string; provider: string; sync?: string }

/** Names of the cloud accounts this user may see in a workspace, for "not found" replies. */
async function accountNames(ws: WorkspaceScope): Promise<string[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ACCOUNT#' },
    ProjectionExpression: 'accountId, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  }));
  return (Items ?? [])
    .filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string))
    .map((a) => String(a.name)).sort().slice(0, 25);
}

/** Cloud accounts in a workspace this user may see whose name matches `query` (either way round). */
async function findAccounts(ws: WorkspaceScope, query: string): Promise<AccountRow[]> {
  const q = cleanQuery(query);
  if (!q) return [];
  const matches = nameMatcher(query);
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ACCOUNT#' },
  }));
  const visible = (Items ?? []).filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string));
  const exact = visible.filter((a) => norm(String(a.name ?? '')) === q);
  const hits = exact.length ? exact : visible.filter((a) => q.length >= 3 && matches(String(a.name ?? '')));
  return hits.map((a) => ({ accountId: a.accountId as string, name: String(a.name), provider: String(a.provider), sync: a.sync as string | undefined }));
}

const pct = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;

export async function runTool(name: string, input: ToolInput, ctx: AssistantContext): Promise<unknown> {
  if (name === 'list_workspaces') {
    return {
      workspaces: ctx.workspaces.map((w) => ({
        name: w.name,
        role: w.role,
        current: w.tenantId === ctx.defaultTenantId,
        scope: w.accountIds === null ? 'all cloud accounts' : `${w.accountIds.length} assigned cloud account(s)`,
      })),
    };
  }

  if (name === 'account_spend') return accountSpend(input, ctx);
  if (name === 'tag_spend') return tagSpend(input, ctx);

  const resolved = resolveWorkspace(input.workspace, ctx);
  // Several workspaces and none named or chosen: answer for all of them,
  // one line each, rather than for whichever workspace the portal is on.
  if ('error' in resolved && resolved.error === NEEDS_WORKSPACE) return runAcross(name, input, ctx);
  if ('error' in resolved) return resolved;
  const ws = resolved;
  const fmt = (usd: number) => money(usd, ws.currency);
  const result = await runWorkspaceTool(name, input, ws, fmt);
  // Every answer is labelled with the workspace it came from, so the model
  // cannot quote one workspace's figures as another's.
  return Array.isArray(result) ? { workspace: ws.name, items: result } : { workspace: ws.name, ...(result as object) };
}

/**
 * A workspace-level question asked of every workspace the user belongs to.
 * Each workspace is read with its own role scope and shown in its own
 * currency; a total is given only when they all share one.
 */
async function runAcross(name: string, input: ToolInput, ctx: AssistantContext): Promise<unknown> {
  const all = ctx.workspaces;
  const sameCurrency = new Set(all.map((w) => w.currency.code)).size === 1;

  if (name === 'spend_summary') {
    const rows = await Promise.all(all.map(async (ws) => ({ ws, s: await buildDashboardSummary(ws.tenantId, ws.accountIds) })));
    const withSpend = rows.filter((r) => r.s.statTiles.mtdSpend > 0).sort((a, b) => b.s.statTiles.mtdSpend - a.s.statTiles.mtdSpend);
    return {
      note: 'Month-to-date spend for each of the user\'s workspaces, largest first. List every one on its own line.',
      workspaces: withSpend.map(({ ws, s }) => ({
        workspace: ws.name,
        monthToDate: money(s.statTiles.mtdSpend, ws.currency),
        changeVsSameDaysLastMonth: pct(s.statTiles.mtdSpendDeltaPct),
        projectedMonthEnd: money(s.statTiles.projectedMonthEnd, ws.currency),
        openAnomalies: s.statTiles.activeAnomalies,
      })),
      workspacesWithNoSpend: rows.length - withSpend.length,
      ...(sameCurrency && withSpend.length ? { total: money(withSpend.reduce((t, r) => t + r.s.statTiles.mtdSpend, 0), all[0].currency) } : {}),
      acrossWorkspaces: true,
    };
  }

  if (name === 'open_alerts') {
    const rows = await Promise.all(all.map(async (ws) => {
      const { Items } = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ALERT#' },
        ScanIndexForward: false,
      }));
      const visible = (Items ?? []).filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string));
      return { ws, alerts: visible };
    }));
    const withAlerts = rows.filter((r) => r.alerts.length > 0).sort((a, b) => b.alerts.length - a.alerts.length);
    return {
      note: 'Open cost anomalies for each of the user\'s workspaces. List every workspace that has any, with its count and newest alert.',
      workspaces: withAlerts.map(({ ws, alerts }) => ({
        workspace: ws.name,
        openAlerts: alerts.length,
        newest: alerts.slice(0, 2).map((a) => ({
          title: a.title, account: a.accountName, severity: a.severity,
          estimatedImpact: typeof a.impact === 'number' ? money(a.impact, ws.currency) : null,
        })),
      })),
      totalOpenAlerts: withAlerts.reduce((t, r) => t + r.alerts.length, 0),
      workspacesWithNoAlerts: rows.length - withAlerts.length,
      acrossWorkspaces: true,
    };
  }

  // Breakdowns, date ranges and tag lists: the per-workspace answer, trimmed
  // to its top few items so eleven of them still fit one WhatsApp message.
  const rows = await Promise.all(all.map(async (ws) => {
    const r = await runWorkspaceTool(name, input, ws, (usd: number) => money(usd, ws.currency)) as Record<string, unknown>;
    const trimmed: Record<string, unknown> = { workspace: ws.name };
    for (const [k, v] of Object.entries(r ?? {})) {
      if (k === 'perDay') continue;
      trimmed[k] = Array.isArray(v) ? v.slice(0, 3) : v;
    }
    return trimmed;
  }));
  return {
    note: 'The same question for each of the user\'s workspaces. Show each workspace on its own line with its main figures.',
    workspaces: rows.filter((r) => !('error' in r) && !(Array.isArray(r.items) && r.items.length === 0)),
    acrossWorkspaces: true,
  };
}

/**
 * One cloud account's figures, found by name. Searches the named workspace, or
 * every workspace the user belongs to — an account name is often all someone
 * remembers. Each match is labelled with its workspace.
 */
async function accountSpend(input: ToolInput, ctx: AssistantContext): Promise<unknown> {
  const query = typeof input.account === 'string' ? input.account : '';
  if (!query.trim()) return { error: 'account is required' };

  // A workspace named in the call, or else the one this conversation is
  // about (if any), is searched first; then the user's other workspaces.
  // Only ctx.workspaces is ever searched — this person's active memberships,
  // each narrowed to the accounts their role allows — so nothing outside them
  // is read or revealed.
  const named = typeof input.workspace === 'string' && input.workspace.trim() ? resolveWorkspace(input.workspace, ctx) : null;
  if (named && 'error' in named) return named;
  const chosen = named ?? ctx.workspaces.find((w) => w.tenantId === ctx.defaultTenantId) ?? null;

  const search = async (list: WorkspaceScope[]) =>
    (await Promise.all(list.map(async (ws) => (await findAccounts(ws, query)).map((a) => ({ ws, a }))))).flat();
  let found = chosen ? await search([chosen]) : [];
  let elsewhere = false;
  if (found.length === 0) {
    found = await search(ctx.workspaces.filter((w) => w.tenantId !== chosen?.tenantId));
    elsewhere = !!chosen && found.length > 0;
  }

  if (found.length === 0) {
    // Not an account — perhaps a service ("lambda", "s3"). In one workspace
    // if one was named (or the user has only one); otherwise across all of
    // theirs, since the same service is often in several.
    if (named || ctx.workspaces.length === 1) {
      const one = named ?? ctx.workspaces[0];
      const detail = await serviceIn(one, query);
      if (detail) return detail;
      return {
        error: `No cloud account or service matching "${query}" in the ${one.name} workspace this month. Do not answer with a different account's or service's figures, and only name accounts listed here.`,
        accountsIn: { workspace: one.name, accounts: await accountNames(one) },
      };
    }
    const across = await serviceAcross(ctx.workspaces, query);
    if (across) return across;
    return { error: `Nothing called "${query}" — no cloud account in any of the user's ${ctx.workspaces.length} workspaces, and no service matching it this month. Do not answer with other figures or invent names.` };
  }

  const matches = await Promise.all(found.slice(0, 5).map(async ({ ws, a }) => {
    const s = await buildDashboardSummary(ws.tenantId, [a.accountId]);
    const t = s.statTiles;
    const fmt = (usd: number) => money(usd, ws.currency);
    return {
      workspace: ws.name,
      account: a.name,
      provider: a.provider,
      monthToDate: fmt(t.mtdSpend),
      changeVsSameDaysLastMonth: pct(t.mtdSpendDeltaPct),
      projectedMonthEnd: fmt(t.projectedMonthEnd),
      topServices: s.topServices.slice(0, 5).map((x) => ({ service: x.name, spend: fmt(x.spend), change: pct(x.trend) })),
      openAnomalies: t.activeAnomalies,
      lastSyncAt: a.sync ?? null,
    };
  }));
  return {
    ...(elsewhere ? {
      note: `"${query}" is not a cloud account in ${chosen!.name}; it was found in another of the user's own workspaces. Say which workspace it is in.`,
    } : {}),
    // Answers this one question; the conversation keeps its chosen workspace.
    otherWorkspace: elsewhere || !chosen,
    matches,
    more: Math.max(found.length - 5, 0),
  };
}

interface TagItem { label: string; spend: number; untagged?: boolean }

/**
 * This month's tag breakdown for every account a user may see in a workspace:
 * { account, tags: { tagKey: [{ label, spend (USD), untagged }] } }. Stored on
 * each account's MONTHLY row by the cost sync.
 */
async function monthTags(ws: WorkspaceScope): Promise<Array<{ account: string; tags: Record<string, TagItem[]> }>> {
  const month = new Date().toISOString().slice(0, 7);
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ACCOUNT#' },
  }));
  const visible = (Items ?? []).filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string));
  const rows = await Promise.all(visible.map(async (a) => {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ACCOUNT#${a.accountId}`, SK: `MONTHLY#${month}` },
      ProjectionExpression: 'tagBreakdown',
    }));
    return { account: String(a.name), tags: (Item?.tagBreakdown ?? {}) as Record<string, TagItem[]> };
  }));
  return rows.filter((r) => Object.keys(r.tags).length > 0);
}

/**
 * Cost for a tag value ("HelloWRK") or a whole tag ("Project"), in one
 * workspace or across all of the user's. Only their own workspaces and the
 * accounts their role allows are read.
 */
async function tagSpend(input: ToolInput, ctx: AssistantContext): Promise<unknown> {
  const raw = typeof input.tag === 'string' ? input.tag : '';
  const q = cleanQuery(raw);
  if (q.length < 2) return { error: 'tag is required' };
  const named = typeof input.workspace === 'string' && input.workspace.trim() ? resolveWorkspace(input.workspace, ctx) : null;
  if (named && 'error' in named) return named;
  const scopes = named ? [named] : ctx.workspaces;
  const match = nameMatcher(raw);

  const values = new Map<string, { workspace: string; tag: string; value: string; usd: number; ws: WorkspaceScope; accounts: Map<string, number> }>();
  const keys = new Map<string, { workspace: string; tag: string; ws: WorkspaceScope; values: Map<string, number>; untagged: number }>();
  const seenKeys = new Set<string>();

  for (const ws of scopes) {
    for (const row of await monthTags(ws)) {
      for (const [tag, items] of Object.entries(row.tags)) {
        seenKeys.add(tag);
        const keyHit = norm(tag) === q || match(tag);
        for (const it of items ?? []) {
          const spend = Number(it.spend) || 0;
          if (keyHit) {
            const k = `${ws.tenantId}|${tag}`;
            const e = keys.get(k) ?? { workspace: ws.name, tag, ws, values: new Map(), untagged: 0 };
            if (it.untagged) e.untagged += spend;
            else e.values.set(it.label, (e.values.get(it.label) ?? 0) + spend);
            keys.set(k, e);
          } else if (!it.untagged && match(String(it.label))) {
            const k = `${ws.tenantId}|${tag}|${it.label}`;
            const e = values.get(k) ?? { workspace: ws.name, tag, value: it.label, usd: 0, ws, accounts: new Map() };
            e.usd += spend;
            e.accounts.set(row.account, (e.accounts.get(row.account) ?? 0) + spend);
            values.set(k, e);
          }
        }
      }
    }
  }

  if (values.size === 0 && keys.size === 0) {
    return {
      error: `No tag or tag value matching "${raw}" in ${named ? `the ${named.name} workspace` : 'any of the user\'s workspaces'} this month. Only tagged resources can be costed by tag. Do not answer with other figures or invent names.`,
      tagsInUse: Array.from(seenKeys).sort().slice(0, 20),
    };
  }

  return {
    note: 'Cost by cloud resource tag, this month. Untagged cost cannot be attributed to any tag value.',
    tagValues: Array.from(values.values()).sort((a, b) => b.usd - a.usd).slice(0, 10).map((e) => ({
      workspace: e.workspace, tag: e.tag, value: e.value, monthToDate: money(e.usd, e.ws.currency),
      accounts: Array.from(e.accounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([account, usd]) => ({ account, spend: money(usd, e.ws.currency) })),
    })),
    tags: Array.from(keys.values()).slice(0, 6).map((e) => {
      const tagged = Array.from(e.values.values()).reduce((t, v) => t + v, 0);
      return {
        workspace: e.workspace, tag: e.tag,
        // Totals computed here: the model once summed these values itself and
        // was out by a thousand rupees.
        taggedTotal: money(tagged, e.ws.currency),
        untagged: money(e.untagged, e.ws.currency),
        values: Array.from(e.values.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, usd]) => ({ value, spend: money(usd, e.ws.currency) })),
        valuesNotShown: Math.max(e.values.size - 8, 0),
      };
    }),
    otherWorkspace: !named,
  };
}

/** A service's month-to-date cost in one workspace, split by account. */
async function serviceIn(ws: WorkspaceScope, query: string): Promise<unknown | null> {
  if (cleanQuery(query).length < 2) return null;
  const match = nameMatcher(query);
  const s = await buildDashboardSummary(ws.tenantId, ws.accountIds);
  const services = s.services.filter((x) => match(x.name));
  if (!services.length) return null;
  const fmt = (usd: number) => money(usd, ws.currency);
  return {
    note: `No cloud account is called "${query}"; these are services matching it.`,
    workspace: ws.name,
    services: services.slice(0, 8).map((x) => ({
      service: x.name, provider: x.provider, monthToDate: fmt(x.spend), share: `${x.pct.toFixed(1)}%`, change: pct(x.trend),
      accounts: x.accounts.slice(0, 5).map((a) => ({ account: a.accountName, spend: fmt(a.spend) })),
    })),
  };
}

/**
 * A service's month-to-date cost in each of the user's workspaces, largest
 * first. Amounts are in each workspace's own currency; a total is given only
 * when they all share one.
 */
async function serviceAcross(workspaces: WorkspaceScope[], query: string): Promise<unknown | null> {
  if (cleanQuery(query).length < 2) return null;
  const match = nameMatcher(query);
  const rows = await Promise.all(workspaces.map(async (ws) => {
    const s = await buildDashboardSummary(ws.tenantId, ws.accountIds);
    const services = s.services.filter((x) => match(x.name));
    const usd = services.reduce((t, x) => t + x.spend, 0);
    return { ws, services, usd };
  }));
  const using = rows.filter((r) => r.services.length > 0).sort((a, b) => b.usd - a.usd);
  if (!using.length) return null;
  const names = Array.from(new Set(using.flatMap((r) => r.services.map((x) => x.name))));
  const oneCurrency = new Set(using.map((r) => r.ws.currency.code)).size === 1;
  return {
    note: 'Service cost per workspace. List every workspace below with its amount, largest first; mention how many workspaces do not use it.',
    services: names.slice(0, 5),
    workspaces: using.map((r) => ({
      workspace: r.ws.name,
      monthToDate: money(r.usd, r.ws.currency),
      topAccount: r.services.flatMap((x) => x.accounts).sort((a, b) => b.spend - a.spend)[0]?.accountName ?? null,
    })),
    workspacesNotUsingIt: rows.length - using.length,
    ...(oneCurrency ? { total: money(using.reduce((t, r) => t + r.usd, 0), using[0].ws.currency) } : {}),
    otherWorkspace: true,
  };
}

async function runWorkspaceTool(name: string, input: ToolInput, ws: WorkspaceScope, fmt: (usd: number) => string): Promise<unknown> {
  switch (name) {
    case 'list_tags': {
      const rows = await monthTags(ws);
      const byKey = new Map<string, { values: Map<string, number>; untagged: number }>();
      rows.forEach((r) => Object.entries(r.tags).forEach(([tag, items]) => {
        const e = byKey.get(tag) ?? { values: new Map(), untagged: 0 };
        (items ?? []).forEach((it) => {
          const spend = Number(it.spend) || 0;
          if (it.untagged) e.untagged += spend; else e.values.set(it.label, (e.values.get(it.label) ?? 0) + spend);
        });
        byKey.set(tag, e);
      }));
      if (byKey.size === 0) return { tags: [], note: 'No tagged cost in this workspace this month.' };
      return {
        tags: Array.from(byKey.entries()).slice(0, 15).map(([tag, e]) => ({
          tag,
          taggedTotal: fmt(Array.from(e.values.values()).reduce((t, v) => t + v, 0)),
          untagged: fmt(e.untagged),
          topValues: Array.from(e.values.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, usd]) => ({ value, spend: fmt(usd) })),
        })),
      };
    }

    case 'spend_summary': {
      const s = await buildDashboardSummary(ws.tenantId, ws.accountIds);
      const t = s.statTiles;
      return {
        currency: ws.currency.code,
        monthToDate: fmt(t.mtdSpend),
        changeVsSameDaysLastMonth: pct(t.mtdSpendDeltaPct),
        comparedDays: t.comparisonDays,
        projectedMonthEnd: fmt(t.projectedMonthEnd),
        daysReported: `${t.coveredDays} of ${t.daysInMonth}`,
        connectedAccounts: t.connectedAccounts,
        byProvider: s.byProvider.map((p) => ({ provider: p.provider, spend: fmt(p.spend), share: `${p.pct.toFixed(0)}%` })),
        topServices: s.topServices.map((x) => ({ service: x.name, spend: fmt(x.spend), share: `${x.pct.toFixed(0)}%`, change: pct(x.trend) })),
        openAnomalies: t.activeAnomalies,
        lastSyncAt: s.lastSyncAt,
      };
    }

    case 'cost_breakdown': {
      const by = String(input.by);
      const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 15);

      // One account's breakdown: the same roll-up, narrowed to its id.
      let accountIds = ws.accountIds;
      let accountLabel: string | null = null;
      if (typeof input.account === 'string' && input.account.trim()) {
        const hits = await findAccounts(ws, input.account);
        if (hits.length === 0) return { error: `No cloud account matching "${input.account}" in ${ws.name}. Do not answer with a different account's figures, and only name accounts listed here.`, accountsInWorkspace: await accountNames(ws) };
        if (hits.length > 1) return { error: `"${input.account}" matches several accounts; ask which one.`, accounts: hits.map((h) => h.name) };
        accountIds = [hits[0].accountId];
        accountLabel = hits[0].name;
      }

      const s = await buildDashboardSummary(ws.tenantId, accountIds);
      const total = s.statTiles.mtdSpend;
      const q = typeof input.search === 'string' ? cleanQuery(input.search) : '';
      const matchSearch = q ? nameMatcher(String(input.search)) : null;
      // Searched across every item before the limit applies, so a small cost
      // is still found when asked for by name.
      const keep = (label: string) => !matchSearch || matchSearch(label);

      let items: Array<Record<string, unknown>>;
      if (by === 'provider') {
        items = s.byProvider.filter((p) => keep(p.provider))
          .map((p) => ({ provider: p.provider, accounts: p.accountCount, spend: fmt(p.spend), share: `${p.pct.toFixed(0)}%` }));
      } else if (by === 'account') {
        const perAccount = new Map<string, number>();
        s.services.forEach((svc) => svc.accounts.forEach((a) => perAccount.set(a.accountName, (perAccount.get(a.accountName) ?? 0) + a.spend)));
        items = Array.from(perAccount.entries()).filter(([n]) => keep(n))
          .sort((a, b) => b[1] - a[1])
          .map(([account, spend]) => ({ account, spend: fmt(spend), share: total > 0 ? `${((spend / total) * 100).toFixed(0)}%` : null }));
      } else {
        items = s.services.filter((x) => keep(x.name))
          .map((x) => ({ service: x.name, provider: x.provider, spend: fmt(x.spend), share: `${x.pct.toFixed(0)}%`, change: pct(x.trend) }));
      }
      if (q && items.length === 0) {
        return { error: `Nothing matching "${input.search}" in ${accountLabel ?? ws.name} this month.`, ...(accountLabel ? { account: accountLabel } : {}) };
      }
      return { ...(accountLabel ? { account: accountLabel } : {}), totalMonthToDate: fmt(total), items: items.slice(0, limit), matching: items.length };
    }

    case 'open_alerts': {
      const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);
      const { Items } = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ALERT#' },
        ScanIndexForward: false,
      }));
      const visible = (Items ?? []).filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string));
      return {
        total: visible.length,
        alerts: visible.slice(0, limit).map((a) => ({
          title: a.title,
          severity: a.severity,
          provider: a.provider,
          account: a.accountName,
          service: a.service,
          detectedFor: a.dayKey,
          normalPerDay: typeof a.baseline === 'number' ? fmt(a.baseline) : null,
          currentPerDay: typeof a.current === 'number' ? fmt(a.current) : null,
          estimatedImpact: typeof a.impact === 'number' ? fmt(a.impact) : null,
          likelyRootCause: a.rootCause ?? null,
          suggestedAction: a.action ?? null,
        })),
      };
    }

    case 'daily_spend': {
      const from = String(input.from ?? '');
      const to = String(input.to ?? '');
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return { error: 'from and to must be YYYY-MM-DD with from <= to' };
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      if (days > MAX_RANGE_DAYS) return { error: `range is ${days} days; the most is ${MAX_RANGE_DAYS}` };

      const serviceQ = typeof input.service === 'string' ? input.service.toLowerCase() : null;
      const accountQ = typeof input.account === 'string' ? input.account.toLowerCase() : null;

      const { Items: accounts } = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `TENANT#${ws.tenantId}`, ':sk': 'ACCOUNT#' },
      }));
      const chosen = (accounts ?? [])
        .filter((a) => ws.accountIds === null || ws.accountIds.includes(a.accountId as string))
        .filter((a) => !accountQ || String(a.name ?? '').toLowerCase().includes(accountQ));
      if (chosen.length === 0) return { error: accountQ ? `no cloud account matches "${input.account}"` : 'no cloud accounts connected' };

      const perDay = new Map<string, number>();
      const perService = new Map<string, number>();
      await Promise.all(chosen.map(async (a) => {
        const { Items } = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': `ACCOUNT#${a.accountId}`, ':from': `DAILY#${from}`, ':to': `DAILY#${to}` },
        }));
        (Items ?? []).forEach((d) => {
          const day = String(d.SK).replace('DAILY#', '');
          const services = (d.serviceBreakdown ?? []) as Array<{ name: string; spend: number }>;
          const matched = serviceQ ? services.filter((x) => x.name.toLowerCase().includes(serviceQ)) : null;
          const spend = matched ? matched.reduce((s, x) => s + (x.spend ?? 0), 0) : ((d.totalSpend as number) ?? 0);
          perDay.set(day, (perDay.get(day) ?? 0) + spend);
          (matched ?? services).forEach((x) => perService.set(x.name, (perService.get(x.name) ?? 0) + (x.spend ?? 0)));
        });
      }));

      const ordered = Array.from(perDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const total = ordered.reduce((s, [, v]) => s + v, 0);
      return {
        from, to,
        accounts: chosen.map((a) => a.name),
        service: input.service ?? null,
        total: fmt(total),
        daysWithData: ordered.length,
        perDay: ordered.map(([day, v]) => ({ day, spend: fmt(v) })),
        topServices: Array.from(perService.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([service, v]) => ({ service, spend: fmt(v) })),
      };
    }

    default:
      return { error: `unknown tool ${name}` };
  }
}
