import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

/**
 * The plans each AI tool sells, and what they list at.
 *
 * Used to fill the Adhoc Spend form: pick "Claude" and "Pro" and the cost box
 * starts at $20. It is a convenience and never an authority — whatever the
 * customer types wins, and no stored figure is computed or corrected from
 * anything here. That matters, because list prices go stale: vendors reprice,
 * and a customer's negotiated rate was never this number anyway.
 *
 * It lives in the table rather than only in code for the same reason plan
 * pricing does — a price change should not need a deploy. DEFAULT_CATALOG
 * stays the seed and the fallback, so an unreadable or never-written config
 * leaves the form with plans rather than an empty dropdown.
 */

export interface AdhocPlan {
  name: string;
  /** List price, or null where there is no single public figure. */
  usd: number | null;
  cadence: 'monthly' | 'yearly';
  /** Free text shown beside the price — "per seat", "negotiated". */
  note?: string | null;
  /**
   * What the vendor charges in other currencies, keyed by ISO code: the
   * price as published, never a conversion of `usd`.
   *
   * A vendor selling at $20 charges a round local figure elsewhere, not
   * twenty times today's rate, and tax is added to that figure rather than
   * to an exchange calculation. Converting produced a number nobody is
   * billed — ₹1,919 against a real ₹1,999 — and one that moved daily while
   * the subscription did not.
   *
   * The same reasoning as `priceInr` on CloudMeter's own plans: a held
   * price, reviewed by hand, not a live conversion.
   *
   * Absent for a currency nobody has entered a price for. The form then
   * quotes the vendor's own USD figure rather than inventing a local one.
   */
  prices?: Record<string, number>;
  /**
   * The same plan bought for a year: the whole amount paid up front, not a
   * monthly equivalent.
   *
   * Most vendors advertise an annual deal as "$17/month billed annually" and
   * never state the year's total, so this is absent far more often than it is
   * present — and absent is the honest answer. Multiplying the monthly figure
   * by twelve states a price the vendor does not, and "save 20%" is two
   * guesses deep. Where a vendor does publish the total, as Anthropic does
   * for Claude Pro at $200 and Midjourney does for all four of its plans,
   * that figure goes here as published.
   *
   * With this absent, choosing Yearly on the form leaves the cost to be
   * typed rather than filling it with arithmetic nobody is billed.
   */
  yearlyUsd?: number | null;
  /** The year's total in other currencies, under the same rule as `prices`. */
  yearlyPrices?: Record<string, number>;
}

export interface AdhocTool {
  /** Stable id. Never shown; renaming the label must not orphan stored plans. */
  key: string;
  label: string;
  /** Other spellings that should find this tool — "anthropic" finds Claude. */
  aliases: string[];
  plans: AdhocPlan[];
}

export interface AdhocCatalog {
  tools: AdhocTool[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The compiled-in seed. Public list prices as of September 2026 — accurate
 * when written, certain to drift, which is exactly why BMS can edit them.
 */
export const DEFAULT_CATALOG: AdhocTool[] = [
  {
    key: 'claude',
    label: 'Claude',
    aliases: ['anthropic', 'claude ai', 'claude.ai'],
    plans: [
      // The rupee figures are Anthropic's published Indian prices, GST
      // included — the whole price, which is why nothing is added to them.
      { name: 'Free', usd: 0, cadence: 'monthly' },
      { name: 'Pro', usd: 20, cadence: 'monthly', prices: { INR: 2399 }, yearlyUsd: 200 },
      { name: 'Max 5x', usd: 100, cadence: 'monthly', prices: { INR: 11999 } },
      { name: 'Max 20x', usd: 200, cadence: 'monthly', prices: { INR: 23999 } },
      { name: 'Team Standard', usd: 30, cadence: 'monthly', note: 'per seat', prices: { INR: 2999 } },
      // No dollar figure on file for Premium; BMS is where one gets added
      // rather than a number being guessed at here.
      { name: 'Team Premium', usd: null, cadence: 'monthly', note: 'per seat', prices: { INR: 14999 } },
      { name: 'Enterprise', usd: null, cadence: 'monthly', note: 'negotiated' },
    ],
  },
  {
    key: 'chatgpt',
    label: 'ChatGPT',
    aliases: ['openai', 'open ai', 'gpt'],
    plans: [
      // OpenAI's lineup as they sell it now: Go is theirs, not a tier we
      // invented, and Business is two seat types rather than one. The rupee
      // figures are the pay-monthly ones from their Indian pricing page;
      // both seats are cheaper billed annually.
      { name: 'Free', usd: 0, cadence: 'monthly', prices: { INR: 0 } },
      // No dollar figure published for Go on the page that lists it.
      { name: 'Go', usd: null, cadence: 'monthly', prices: { INR: 399 } },
      { name: 'Plus', usd: 20, cadence: 'monthly', prices: { INR: 1999 } },
      { name: 'Pro', usd: 200, cadence: 'monthly', note: 'from', prices: { INR: 10699 } },
      { name: 'Standard seat', usd: 30, cadence: 'monthly', note: 'per seat', prices: { INR: 2250 } },
      { name: 'Premium seat', usd: null, cadence: 'monthly', note: 'per seat', prices: { INR: 11250 } },
      { name: 'Enterprise', usd: null, cadence: 'monthly', note: 'negotiated' },
    ],
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot',
    aliases: ['github copilot', 'gh copilot', 'github'],
    plans: [
      { name: 'Free', usd: 0, cadence: 'monthly' },
      { name: 'Pro', usd: 10, cadence: 'monthly' },
      { name: 'Pro+', usd: 39, cadence: 'monthly' },
      { name: 'Max', usd: 100, cadence: 'monthly' },
      { name: 'Business', usd: 19, cadence: 'monthly', note: 'per seat' },
      { name: 'Enterprise', usd: 39, cadence: 'monthly', note: 'per seat' },
    ],
  },
  {
    key: 'cursor',
    label: 'Cursor',
    aliases: ['cursor ai', 'cursor.sh'],
    plans: [
      // No rupee prices here, and that is the right answer rather than a gap:
      // Cursor bills in USD everywhere and states its prices exclude tax, so
      // an Indian workspace is quoted the dollar figure with GST added.
      { name: 'Hobby', usd: 0, cadence: 'monthly' },
      { name: 'Pro', usd: 20, cadence: 'monthly' },
      { name: 'Pro+', usd: 60, cadence: 'monthly' },
      { name: 'Ultra', usd: 200, cadence: 'monthly' },
      { name: 'Teams Standard', usd: 40, cadence: 'monthly', note: 'per seat' },
      { name: 'Teams Premium', usd: 120, cadence: 'monthly', note: 'per seat' },
      { name: 'Enterprise', usd: null, cadence: 'monthly', note: 'negotiated' },
    ],
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    aliases: ['perplexity ai'],
    plans: [
      { name: 'Free', usd: 0, cadence: 'monthly' },
      { name: 'Pro', usd: 20, cadence: 'monthly' },
      { name: 'Max', usd: 200, cadence: 'monthly' },
      // Perplexity publishes the seat tiers as a per-month figure billed
      // annually, and that is the figure here — multiplying it out into a
      // yearly total would state a price the page does not.
      { name: 'Enterprise Pro', usd: 34, cadence: 'monthly', note: 'per seat · annual' },
      { name: 'Enterprise Max', usd: 271, cadence: 'monthly', note: 'per seat · annual' },
    ],
  },
  {
    key: 'gemini',
    label: 'Gemini',
    aliases: ['google gemini', 'google one ai', 'bard'],
    plans: [
      // Google publishes Indian prices for these, so they are the vendor's own
      // rupee figures rather than the USD fallback.
      { name: 'Free', usd: 0, cadence: 'monthly', prices: { INR: 0 } },
      { name: 'AI Plus', usd: 4.99, cadence: 'monthly', prices: { INR: 399 } },
      { name: 'AI Pro', usd: 19.99, cadence: 'monthly', prices: { INR: 1950 } },
      { name: 'AI Ultra', usd: 99.99, cadence: 'monthly', prices: { INR: 6500 } },
      { name: 'AI Ultra 20x', usd: 199.99, cadence: 'monthly', note: '20x limits', prices: { INR: 19500 } },
    ],
  },
  {
    key: 'midjourney',
    label: 'Midjourney',
    aliases: ['mid journey'],
    plans: [
      // Midjourney is the one vendor here that publishes the year's total
      // for every plan rather than a per-month-billed-annually figure.
      { name: 'Basic', usd: 10, cadence: 'monthly', yearlyUsd: 96 },
      { name: 'Standard', usd: 30, cadence: 'monthly', yearlyUsd: 288 },
      { name: 'Pro', usd: 60, cadence: 'monthly', yearlyUsd: 576 },
      { name: 'Mega', usd: 120, cadence: 'monthly', yearlyUsd: 1152 },
    ],
  },
];

const KEY = { PK: 'PLATFORM#config', SK: 'ADHOC_CATALOG' };

export const MAX_TOOLS = 100;
export const MAX_PLANS_PER_TOOL = 30;
export const MAX_NAME = 60;
/** A list price above this is a typo, not a plan. */
export const MAX_PRICE = 100_000;
/**
 * The same guard for a local price, loosened for currencies whose unit is
 * small: ₹100,000 is an ordinary enterprise seat, and the dollar ceiling
 * would reject it.
 */
export const MAX_PRICE_LOCAL = 10_000_000;
/**
 * Currencies a regional price may be entered in — the ones the app can
 * already display. A price in a currency nothing can render is a number
 * nobody will ever see, so it is refused at the door rather than stored.
 */
export const SUPPORTED_PRICE_CURRENCIES = new Set(['USD', 'INR', 'GBP', 'EUR', 'SGD', 'AED', 'AUD']);

export async function getCatalog(): Promise<AdhocCatalog> {
  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: KEY }));
    const tools = Item?.tools as AdhocTool[] | undefined;
    // An empty array is a real state — someone deleted every tool — and must
    // not silently resurrect the seed. Only a missing record falls back.
    if (!Array.isArray(tools)) return { tools: DEFAULT_CATALOG, updatedAt: null, updatedBy: null };
    return {
      tools,
      updatedAt: (Item?.updatedAt as string) ?? null,
      updatedBy: (Item?.updatedBy as string) ?? null,
    };
  } catch (err) {
    // The form is a convenience; a read failure must not stop someone
    // recording what they pay.
    console.error('Adhoc catalogue unreadable — falling back to the seed', err);
    return { tools: DEFAULT_CATALOG, updatedAt: null, updatedBy: null };
  }
}

/** Cleans one submitted catalogue, or returns a message naming what is wrong. */
export function validateCatalog(input: unknown): AdhocTool[] | string {
  if (!Array.isArray(input)) return 'Expected a list of tools.';
  if (input.length > MAX_TOOLS) return `At most ${MAX_TOOLS} tools.`;

  const tools: AdhocTool[] = [];
  const seenKeys = new Set<string>();

  for (const raw of input as Array<Record<string, unknown>>) {
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label) return 'Every tool needs a name.';
    if (label.length > MAX_NAME) return `"${label.slice(0, 20)}…" is too long a name.`;

    // Derived from the label when absent, so the BMS form need not expose it —
    // but an existing key is kept, so renaming "Claude" to "Claude AI" does not
    // orphan the plans customers have already chosen.
    const key = (typeof raw.key === 'string' && raw.key.trim())
      ? raw.key.trim().toLowerCase()
      : label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!key) return `"${label}" does not make a usable id.`;
    if (seenKeys.has(key)) return `Two tools are both called "${label}".`;
    seenKeys.add(key);

    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : [];

    const rawPlans = Array.isArray(raw.plans) ? raw.plans : [];
    if (rawPlans.length > MAX_PLANS_PER_TOOL) return `${label} has too many plans.`;

    const plans: AdhocPlan[] = [];
    const seenPlans = new Set<string>();
    for (const p of rawPlans as Array<Record<string, unknown>>) {
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name) return `A plan on ${label} has no name.`;
      if (name.length > MAX_NAME) return `A plan name on ${label} is too long.`;
      if (seenPlans.has(name.toLowerCase())) return `${label} lists "${name}" twice.`;
      seenPlans.add(name.toLowerCase());

      // null is meaningful — "negotiated", no single public figure — and is
      // not the same as 0, which is a genuinely free plan. The same is true
      // of a missing annual price: most vendors never publish one.
      const readUsd = (raw: unknown, what: string): number | null | string => {
        if (raw === null || raw === undefined || String(raw).trim() === '') return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return `${label} · ${name}: the ${what} must be a number, and cannot be negative.`;
        if (n > MAX_PRICE) return `${label} · ${name}: that ${what} looks wrong.`;
        return n;
      };

      // Prices in other currencies, as the vendor publishes them. Same rules
      // as the USD figure, applied per entry; an empty box means "not known
      // here" and is dropped rather than stored as zero, which would read as
      // free.
      const readPrices = (raw: unknown, what: string): Record<string, number> | string => {
        const out: Record<string, number> = {};
        const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
        for (const [rawCode, rawValue] of Object.entries(src)) {
          const code = String(rawCode).trim().toUpperCase();
          if (!SUPPORTED_PRICE_CURRENCIES.has(code)) {
            return `${label} · ${name}: ${code || 'that'} is not a currency CloudMeter shows prices in.`;
          }
          if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') continue;
          const n = Number(rawValue);
          if (!Number.isFinite(n) || n < 0) return `${label} · ${name}: the ${code} ${what} must be a number, and cannot be negative.`;
          if (n > MAX_PRICE_LOCAL) return `${label} · ${name}: that ${code} ${what} looks wrong.`;
          out[code] = n;
        }
        return out;
      };

      const usd = readUsd(p.usd, 'price');
      if (typeof usd === 'string') return usd;
      const yearlyUsd = readUsd(p.yearlyUsd, 'yearly price');
      if (typeof yearlyUsd === 'string') return yearlyUsd;

      const prices = readPrices(p.prices, 'price');
      if (typeof prices === 'string') return prices;
      const yearlyPrices = readPrices(p.yearlyPrices, 'yearly price');
      if (typeof yearlyPrices === 'string') return yearlyPrices;

      const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 40) : null;
      plans.push({
        name, usd, cadence: p.cadence === 'yearly' ? 'yearly' : 'monthly', note,
        // Each omitted entirely when empty, so a stored plan looks the same as
        // it did before regional and annual prices existed.
        ...(Object.keys(prices).length ? { prices } : {}),
        ...(yearlyUsd !== null ? { yearlyUsd } : {}),
        ...(Object.keys(yearlyPrices).length ? { yearlyPrices } : {}),
      });
    }

    tools.push({ key, label, aliases, plans });
  }

  return tools.sort((a, b) => a.label.localeCompare(b.label));
}

export async function setCatalog(tools: AdhocTool[], updatedBy: string): Promise<AdhocCatalog> {
  const updatedAt = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { ...KEY, tools, updatedAt, updatedBy },
  }));
  return { tools, updatedAt, updatedBy };
}
