import {
  validateCatalog, DEFAULT_CATALOG, MAX_PRICE, MAX_PRICE_LOCAL,
} from '../functions/shared/adhoc-catalog';

/**
 * Staff type these prices by hand and they reach a customer's cost field as a
 * starting value. Nothing downstream re-checks them, so this is the only place
 * a nonsense figure gets stopped.
 */

const tool = (over: Record<string, unknown> = {}) => ({
  label: 'Claude', aliases: ['anthropic'],
  plans: [{ name: 'Pro', usd: 20, cadence: 'monthly' }],
  ...over,
});

describe('validateCatalog', () => {
  it('accepts a well-formed tool', () => {
    const out = validateCatalog([tool()]);
    expect(Array.isArray(out)).toBe(true);
    expect((out as any)[0]).toMatchObject({ key: 'claude', label: 'Claude' });
  });

  it('derives a key from the label when none is given', () => {
    const out = validateCatalog([tool({ label: 'GitHub Copilot' })]) as any;
    expect(out[0].key).toBe('github-copilot');
  });

  it('keeps an existing key through a rename', () => {
    // Customers' stored plans are matched by the tool, so renaming "Claude" to
    // "Claude AI" must not orphan them.
    const out = validateCatalog([tool({ key: 'claude', label: 'Claude AI' })]) as any;
    expect(out[0]).toMatchObject({ key: 'claude', label: 'Claude AI' });
  });

  it('refuses two tools that would share a key', () => {
    expect(typeof validateCatalog([tool(), tool()])).toBe('string');
  });

  it('refuses a tool with no name', () => {
    expect(typeof validateCatalog([tool({ label: '  ' })])).toBe('string');
  });

  it('refuses a duplicate plan name on one tool', () => {
    const out = validateCatalog([tool({
      plans: [{ name: 'Pro', usd: 20 }, { name: 'pro', usd: 30 }],
    })]);
    expect(typeof out).toBe('string');
  });

  it('keeps a null price distinct from zero', () => {
    // null is "negotiated, no public figure"; 0 is a genuinely free plan.
    // Collapsing them would put 0 in a cost box for an enterprise contract.
    const out = validateCatalog([tool({
      plans: [
        { name: 'Free', usd: 0, cadence: 'monthly' },
        { name: 'Enterprise', usd: null, cadence: 'monthly' },
      ],
    })]) as any;
    expect(out[0].plans[0].usd).toBe(0);
    expect(out[0].plans[1].usd).toBeNull();
  });

  it('treats an empty price box as no price, not as zero', () => {
    const out = validateCatalog([tool({ plans: [{ name: 'Enterprise', usd: '' }] })]) as any;
    expect(out[0].plans[0].usd).toBeNull();
  });

  it('refuses a negative price', () => {
    expect(typeof validateCatalog([tool({ plans: [{ name: 'Pro', usd: -5 }] })])).toBe('string');
  });

  it('refuses a price that is obviously a typo', () => {
    const out = validateCatalog([tool({ plans: [{ name: 'Pro', usd: MAX_PRICE + 1 }] })]);
    expect(typeof out).toBe('string');
  });

  it('defaults an unrecognised cadence to monthly', () => {
    const out = validateCatalog([tool({ plans: [{ name: 'Pro', usd: 20, cadence: 'weekly' }] })]) as any;
    expect(out[0].plans[0].cadence).toBe('monthly');
  });

  it('sorts tools by name so the editor is stable between saves', () => {
    const out = validateCatalog([
      tool({ key: 'z', label: 'Zed' }), tool({ key: 'a', label: 'Alpha' }),
    ]) as any;
    expect(out.map((t: any) => t.label)).toEqual(['Alpha', 'Zed']);
  });

  it('accepts an empty catalogue — deleting every tool is a real choice', () => {
    expect(validateCatalog([])).toEqual([]);
  });

  it('refuses something that is not a list at all', () => {
    expect(typeof validateCatalog({} as unknown)).toBe('string');
    expect(typeof validateCatalog(null)).toBe('string');
  });

  // Regional prices are the vendor's own published figures, typed in by staff.
  // A bad one here would be quoted to a customer as what they pay.
  describe('regional prices', () => {
    const withPrices = (prices: unknown) =>
      validateCatalog([tool({ plans: [{ name: 'Pro', usd: 20, cadence: 'monthly', prices }] })]) as any;

    it('keeps a published local price exactly as entered', () => {
      expect(withPrices({ INR: 1999 })[0].plans[0].prices).toEqual({ INR: 1999 });
    });

    it('uppercases the currency code, so "inr" and "INR" are one entry', () => {
      expect(withPrices({ inr: 1999 })[0].plans[0].prices).toEqual({ INR: 1999 });
    });

    it('drops an empty box rather than storing it as free', () => {
      // 0 would read as a free plan on the customer's form; "not known here"
      // has to leave no entry at all, so the USD price is quoted instead.
      expect(withPrices({ INR: '' })[0].plans[0].prices).toBeUndefined();
    });

    it('omits the field entirely when no local price is given', () => {
      expect(Object.prototype.hasOwnProperty.call(withPrices({})[0].plans[0], 'prices')).toBe(false);
    });

    it('refuses a currency nothing can display', () => {
      expect(typeof withPrices({ JPY: 3000 })).toBe('string');
    });

    it('refuses a negative or unparseable local price', () => {
      expect(typeof withPrices({ INR: -1 })).toBe('string');
      expect(typeof withPrices({ INR: 'lots' })).toBe('string');
    });

    it('refuses a local price past the typo ceiling', () => {
      expect(typeof withPrices({ INR: MAX_PRICE_LOCAL + 1 })).toBe('string');
    });

    it('allows a rupee figure the dollar ceiling would have rejected', () => {
      // ₹200,000 is an ordinary enterprise seat and must survive a limit
      // written for dollars.
      expect(withPrices({ INR: MAX_PRICE * 2 })[0].plans[0].prices).toEqual({ INR: MAX_PRICE * 2 });
    });
  });

  it('round-trips the shipped default without complaint', () => {
    // The seed is what a fresh install serves; if it cannot pass its own
    // validator, nobody could save an unmodified catalogue.
    const out = validateCatalog(DEFAULT_CATALOG);
    expect(Array.isArray(out)).toBe(true);
    expect((out as any).length).toBe(DEFAULT_CATALOG.length);
  });
});
