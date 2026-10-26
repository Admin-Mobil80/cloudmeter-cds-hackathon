// CloudMeter — the plans each AI tool sells, for the Adhoc Spend form.
//
// An adhoc account is one tool ("Claude"), and each line under it is a plan
// someone is on ("Pro", "Max 5x"). Typing the plan name by hand produced three
// rows all called "Pro" with no way to tell them apart, so the plan is picked
// from a list instead.
//
// ---------------------------------------------------------------------------
// These prices are PUBLIC LIST PRICES and they go stale. They are a starting
// value for the cost field, never an authority: whatever is typed in wins, and
// nothing here is used to compute or correct a stored figure. Negotiated rates,
// annual discounts, local tax and per-seat minimums all make the real number
// differ, which is exactly why the field stays editable and says so.
//
// A tool that isn't listed is not blocked — the form falls back to a plain text
// box, and so does "Other…" on any tool that is listed. Adding a tool here is
// the only change needed to give it a dropdown.
// ---------------------------------------------------------------------------
(function () {
  /**
   * usd: list price, or null where there's no single public figure.
   * cadence: how that price is billed — every entry below is a monthly price,
   *   so they are all 'monthly'. The field exists rather than being assumed
   *   because annual-billed plans are common and the form has to set "Billed"
   *   correctly for them; add one with cadence:'yearly' and its yearly price
   *   and the form follows.
   */
  const CATALOG = {
    claude: {
      label: 'Claude',
      aliases: ['anthropic', 'claude ai', 'claude.ai'],
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'Pro', usd: 20, cadence: 'monthly' },
        { name: 'Max 5x', usd: 100, cadence: 'monthly' },
        { name: 'Max 20x', usd: 200, cadence: 'monthly' },
        { name: 'Team', usd: 30, cadence: 'monthly', note: 'per seat' },
        { name: 'Enterprise', usd: null, cadence: 'monthly', note: 'negotiated' },
      ],
    },
    chatgpt: {
      label: 'ChatGPT',
      aliases: ['openai', 'open ai', 'gpt'],
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'Plus', usd: 20, cadence: 'monthly' },
        { name: 'Pro', usd: 200, cadence: 'monthly' },
        { name: 'Business', usd: 30, cadence: 'monthly', note: 'per seat' },
        { name: 'Enterprise', usd: null, cadence: 'monthly', note: 'negotiated' },
      ],
    },
    copilot: {
      label: 'GitHub Copilot',
      aliases: ['github copilot', 'gh copilot', 'github'],
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'Pro', usd: 10, cadence: 'monthly' },
        { name: 'Pro+', usd: 39, cadence: 'monthly' },
        { name: 'Business', usd: 19, cadence: 'monthly', note: 'per seat' },
        { name: 'Enterprise', usd: 39, cadence: 'monthly', note: 'per seat' },
      ],
    },
    cursor: {
      label: 'Cursor',
      aliases: ['cursor ai', 'cursor.sh'],
      plans: [
        { name: 'Hobby', usd: 0, cadence: 'monthly' },
        { name: 'Pro', usd: 20, cadence: 'monthly' },
        { name: 'Ultra', usd: 200, cadence: 'monthly' },
        { name: 'Teams', usd: 40, cadence: 'monthly', note: 'per seat' },
      ],
    },
    perplexity: {
      label: 'Perplexity',
      aliases: ['perplexity ai'],
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'Pro', usd: 20, cadence: 'monthly' },
        { name: 'Max', usd: 200, cadence: 'monthly' },
        { name: 'Enterprise Pro', usd: 40, cadence: 'monthly', note: 'per seat' },
      ],
    },
    gemini: {
      label: 'Gemini',
      aliases: ['google gemini', 'google one ai', 'bard'],
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'AI Pro', usd: 19.99, cadence: 'monthly' },
        { name: 'AI Ultra', usd: 249.99, cadence: 'monthly' },
      ],
    },
    midjourney: {
      label: 'Midjourney',
      aliases: ['mid journey'],
      plans: [
        { name: 'Basic', usd: 10, cadence: 'monthly' },
        { name: 'Standard', usd: 30, cadence: 'monthly' },
        { name: 'Pro', usd: 60, cadence: 'monthly' },
        { name: 'Mega', usd: 120, cadence: 'monthly' },
      ],
    },
  };

  /** Strips punctuation and filler so "Claude.ai " matches "claude". */
  function normalise(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9+ ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * The catalogue entry for a tool name, or null.
   *
   * Matches the key, the label, any alias, or a name that begins with one —
   * "Claude Pro" as an account name should still find Claude. Deliberately not
   * a fuzzy match: silently offering Cursor's plans to someone who typed
   * something else is worse than offering no plans at all.
   */
  function lookup(toolName) {
    const q = normalise(toolName);
    if (!q) return null;

    for (const [key, entry] of Object.entries(CATALOG)) {
      const names = [key, normalise(entry.label), ...(entry.aliases || []).map(normalise)];
      if (names.includes(q)) return entry;
    }
    for (const [key, entry] of Object.entries(CATALOG)) {
      const names = [key, normalise(entry.label), ...(entry.aliases || []).map(normalise)];
      if (names.some((n) => n && (q.startsWith(`${n} `) || q === n))) return entry;
    }
    return null;
  }

  function plansFor(toolName) {
    const entry = lookup(toolName);
    return entry ? entry.plans : null;
  }

  /** One plan's entry, or null. */
  function planFor(toolName, planName) {
    const plans = plansFor(toolName) || [];
    return plans.find((p) => p.name === planName) || null;
  }

  /** The list price for one plan, or null when there isn't a single figure. */
  function priceFor(toolName, planName) {
    const plan = planFor(toolName, planName);
    return plan && plan.usd !== null && plan.usd !== undefined ? plan.usd : null;
  }

  // ---- what this workspace actually pays ---------------------------------

  /**
   * The workspace's own currency, and the tax added to a vendor's price.
   *
   * Arrives with the catalogue on /providers. Defaults to plain USD and no
   * tax, which is what the form quoted before any of this existed — a failed
   * load should cost a rupee figure, not the whole dropdown.
   */
  let PRICING = { currency: 'USD', symbol: '$', rate: 1, taxPercent: 0, taxLabel: null };

  function pricing() { return PRICING; }

  /**
   * What one plan costs this workspace, or null where there is no figure.
   *
   * Two rules, and the second is the point of all of this:
   *
   *  - The price is the vendor's own published figure in the currency the
   *    workspace buys in — `prices.INR` where BMS has entered one. It is never
   *    the dollar price run through an exchange rate. A vendor charging $20
   *    charges ₹1,999 in India, not ₹1,919, and that figure does not move
   *    every morning.
   *  - With no local price entered, the quote stays in the vendor's USD. An
   *    invented rupee number is worse than an honest dollar one: nobody is
   *    billed it, and it changes daily.
   *
   * Tax follows from which of those two it is, and the difference matters:
   *
   *  - A regional price is the whole price. Anthropic publishes Claude Pro in
   *    India at ₹2,399 with GST already in it, which is what lands on the
   *    card; adding 18% to it again would quote ₹2,831 to someone paying
   *    ₹2,399.
   *  - A USD list price is quoted before tax — $20 is $20 everywhere, and an
   *    Indian customer pays GST on top at checkout — so the tax is added.
   *
   * Either way it is arithmetic on a real published figure, and either way the
   * note beside the box says which of the two it is doing.
   *
   * `usd` is what gets stored, because every roll-up in CloudMeter totals in
   * USD. For a local quote that one number is converted, once, and the rate is
   * saved beside it — which is exactly why the displayed figure comes from
   * `amount` and never from re-converting `usd`.
   */
  function quoteFor(toolName, planName, cadence) {
    return quoteForPlan(planFor(toolName, planName), cadence);
  }

  /**
   * The same quote, for a plan already in hand.
   *
   * `cadence` picks which of the plan's two prices to quote. Asking for a
   * year that the vendor never published a total for returns null rather
   * than twelve times the monthly figure: the form then hands the box back
   * to be typed, which is the truthful outcome.
   */
  function quoteForPlan(plan, cadence) {
    if (!plan) return null;
    const yearly = cadence === 'yearly';

    // A plan from before the two prices existed carries one figure and a
    // cadence saying which it is. Its price is the year's, so it answers the
    // yearly question and has no monthly answer to give — quoting it as a
    // month would divide a year's cost by nothing and report twelve times
    // too much every month.
    const legacyYearly = plan.cadence === 'yearly' && !hasExplicitYearly(plan);
    if (legacyYearly && !yearly) return null;

    const code = PRICING.currency || 'USD';
    const useBase = legacyYearly || !yearly;
    const pricesFor = useBase ? plan.prices : plan.yearlyPrices;
    const usdFor = useBase ? plan.usd : plan.yearlyUsd;
    const local = (pricesFor && typeof pricesFor === 'object') ? pricesFor[code] : undefined;
    const hasLocal = code !== 'USD' && Number.isFinite(Number(local));
    const listed = hasLocal ? Number(local) : usdFor;
    if (listed === null || listed === undefined || !Number.isFinite(Number(listed))) return null;

    const pct = Number(PRICING.taxPercent) || 0;
    const base = Number(listed);
    // The regional price already has the tax in it; the dollar one does not.
    const amount = hasLocal ? base : Math.round(base * (1 + pct / 100) * 100) / 100;
    const rate = Number(PRICING.rate) || 1;

    return {
      currency: hasLocal ? code : 'USD',
      symbol: hasLocal ? (PRICING.symbol || '$') : '$',
      base,
      amount,
      taxPercent: pct,
      taxLabel: pct > 0 ? PRICING.taxLabel : null,
      /** Whether that tax is already inside `amount` or was added to it. */
      taxIncluded: hasLocal && pct > 0,
      // What was asked for, not what the plan's own default says: a plan with
      // both prices is whichever one the Billed selector is on.
      cadence: yearly ? 'yearly' : 'monthly',
      /** Whether a year's price exists at all, so the form can say if not. */
      hasYearly: hasYearlyPrice(plan),
      /** The stored figure. Converted only when the quote is not already USD. */
      usd: hasLocal ? Math.round((amount / (rate || 1)) * 100) / 100 : amount,
      /** Kept with the line so the stored USD can always be traced back. */
      rate: hasLocal ? rate : 1,
      isLocal: hasLocal,
    };
  }

  /**
   * Whether the vendor publishes a price for a year of this plan at all —
   * in any currency. Used to tell "no annual deal exists" apart from "there
   * is one but not in your currency".
   */
  function hasYearlyPrice(plan) {
    if (!plan) return false;
    // A legacy yearly-cadence plan's single price is a year's, so it counts.
    return hasExplicitYearly(plan) || plan.cadence === 'yearly';
  }

  /** A price entered in the per-year columns, as opposed to a legacy one. */
  function hasExplicitYearly(plan) {
    if (!plan) return false;
    if (plan.yearlyUsd !== null && plan.yearlyUsd !== undefined) return true;
    return !!(plan.yearlyPrices && Object.keys(plan.yearlyPrices).length);
  }

  /** Formats a quote the way the picker and the cost note both need it. */
  function quoteText(quote) {
    if (!quote) return '';
    const locale = quote.currency === 'INR' ? 'en-IN' : 'en-US';
    const decimals = quote.amount % 1 === 0 ? 0 : 2;
    return quote.symbol + quote.amount.toLocaleString(locale, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
  }

  /** How that plan's price is billed — 'monthly' unless the entry says otherwise. */
  function cadenceFor(toolName, planName) {
    const plan = planFor(toolName, planName);
    return plan && plan.cadence === 'yearly' ? 'yearly' : 'monthly';
  }

  /** Every tool with a dropdown, for the "we know these" hint. */
  function knownTools() {
    return Object.values(CATALOG).map((e) => e.label).sort();
  }

  /**
   * The same tools, each with the other names BMS knows it by.
   *
   * The aliases have always been here — they are what `lookup` matches a typed
   * name against, and `adopt` carries them over from BMS — but nothing ever
   * showed them. Someone who calls the tool "OpenAI" scans the dropdown, does
   * not find it, picks "Other…" and types OpenAI; the result is a second tool
   * sitting beside ChatGPT with its spend split across both. The alias list
   * exists precisely to stop that, and it could not do its job while it was
   * invisible.
   */
  function toolOptions() {
    return Object.values(CATALOG)
      .map((e) => ({
        label: e.label,
        // Copied, not handed out: the caller must not be able to edit the
        // catalogue by pushing onto what it returns.
        aliases: Array.isArray(e.aliases) ? [...e.aliases] : [],
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  /**
   * Replaces the built-in list with the one BMS maintains.
   *
   * The catalogue arrives on /providers, which the pages needing it already
   * call. The list above stays as the fallback rather than being deleted: a
   * failed or slow load should leave the form with plans, not an empty
   * dropdown, and the prices only ever pre-fill a field.
   */
  function adopt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return false;
    for (const key of Object.keys(CATALOG)) delete CATALOG[key];
    for (const t of tools) {
      if (!t || !t.key || !t.label) continue;
      CATALOG[t.key] = {
        label: t.label,
        aliases: Array.isArray(t.aliases) ? t.aliases : [],
        plans: Array.isArray(t.plans) ? t.plans : [],
      };
    }
    return true;
  }

  /**
   * Loads the catalogue once per page. Callers await this before rendering a
   * plan dropdown; everything keeps working if it rejects.
   */
  let loading = null;
  function ready() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await window.CM_Api.get('/providers');
        adopt(res && res.adhocCatalog);
        adoptPricing(res && res.adhocPricing);
      } catch (err) {
        console.warn('Adhoc catalogue unavailable — using the built-in list', err);
      }
    })();
    return loading;
  }

  /** Takes the currency and tax context from /providers, ignoring junk. */
  function adoptPricing(p) {
    if (!p || typeof p !== 'object') return false;
    PRICING = {
      currency: typeof p.currency === 'string' && p.currency ? p.currency : 'USD',
      symbol: typeof p.symbol === 'string' && p.symbol ? p.symbol : '$',
      rate: Number.isFinite(Number(p.rate)) && Number(p.rate) > 0 ? Number(p.rate) : 1,
      taxPercent: Number.isFinite(Number(p.taxPercent)) ? Number(p.taxPercent) : 0,
      taxLabel: typeof p.taxLabel === 'string' && p.taxLabel ? p.taxLabel : null,
    };
    return true;
  }

  window.CM_AdhocCatalog = {
    plansFor, planFor, priceFor, cadenceFor, knownTools, toolOptions, lookup, ready, adopt,
    pricing, adoptPricing, quoteFor, quoteForPlan, quoteText, hasYearlyPrice,
  };
})();
