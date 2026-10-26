// CloudMeter — renders the plan cards from the server's catalogue.
//
// Both the public pricing page and the in-app Billing page use this, so the
// price someone is quoted before signing up is the same one they are charged
// and the same one the limits are enforced at. Hardcoding the cards in two
// HTML files is how those three drift apart.
(function () {
  const grid = document.getElementById('plan-grid');
  if (!grid) return;

  // Billing offers a plan change; the marketing page sends people to sign up.
  const inApp = !!window.CM_Api;
  // Kept in step with the marketing site's copy of this file, which runs on a
  // different origin from the portal and needs portalUrl to link back here.
  // window.CM_CONFIG.portalUrl is undefined in the portal's own config, so
  // this falls back to the plain relative path — and inApp is always true on
  // the portal's own billing page anyway, so the fallback never actually runs.
  const loginUrl = window.CM_CONFIG.portalUrl ? `${window.CM_CONFIG.portalUrl}/login.html` : 'login.html';

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /**
   * Which region's price to quote.
   *
   * The portal sets CM_BILLING_REGION from GET /billing, which resolves it
   * from the tenant's billing address — that is the authority, and it is what
   * checkout will actually charge.
   *
   * The marketing page has no tenant to place, so it falls back to the
   * browser's timezone. That is a guess, and it is the same guess the backend
   * makes for an account with no billing address yet, so the two agree. It
   * only decides which price a signed-out visitor is *shown*; what they are
   * charged is settled server-side once they have an address.
   */
  function region() {
    if (window.CM_BILLING_REGION === 'india' || window.CM_BILLING_REGION === 'global') {
      return window.CM_BILLING_REGION;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' ? 'india' : 'global';
    } catch {
      return 'global';
    }
  }

  const SYMBOL = { INR: '₹', USD: '$' };

  function amount(value, currency) {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    return `${SYMBOL[currency] || ''}${Number(value).toLocaleString(locale, { maximumFractionDigits: 0 })}`;
  }

  /**
   * The headline price, and the tax under it.
   *
   * Indian plans are quoted tax-inclusive, because that is what leaves the
   * customer's account — quoting the pre-GST figure and surprising them at
   * checkout with 18% more is the version of this that generates complaints.
   * The breakdown stays visible underneath so the invoice is never a mystery.
   */
  function priceBlock(plan) {
    const r = region();
    // `plan.price` is set by the signed-in Billing page from GET /billing,
    // which resolves this tenant's region server-side and is not cached. The
    // per-region fields come from the public GET /plans, which is cached for
    // five minutes — fine for a marketing visitor, wrong for someone who just
    // changed a price in BMS and came to check it.
    const p = plan.price || plan[r];

    // A catalogue served by an older API, before per-region pricing existed.
    if (!p) return `<div class="plan-price"><span class="now">$${plan.priceUsd}</span><span class="per">/mo</span></div>`;

    const tax = p.tax > 0
      ? `<div class="plan-tax">incl. ${esc(p.taxLabel)} — ${amount(p.subtotal, p.currency)} + ${amount(p.tax, p.currency)}</div>`
      : '';

    return `<div class="plan-price"><span class="now">${amount(p.total, p.currency)}</span><span class="per">/mo</span></div>${tax}`;
  }

  /**
   * The managed-spend ceiling, in the currency this visitor is priced in.
   *
   * It used to be hardcoded to dollars, which put "for up to $2,500/mo managed
   * cloud spend" directly beneath a price in rupees and left the reader to do
   * the conversion. The ceiling is the thing the tier is actually selling, so
   * it has to be quoted in the same money as the price.
   */
  function capLine(plan) {
    const r = region();
    const cap = plan.cap || (r === 'india' ? plan.indiaCap : plan.globalCap);

    // An older API with no per-region caps — fall back to the flat USD figure.
    if (!cap) {
      return plan.maxManagedSpendUsd === null
        ? 'for <strong>unlimited</strong> managed cloud spend'
        : `for up to <strong>$${plan.maxManagedSpendUsd.toLocaleString('en-US')}</strong>/mo managed cloud spend`;
    }
    if (cap.amount === null) return 'for <strong>unlimited</strong> managed cloud spend';
    return `for up to <strong>${amount(cap.amount, cap.currency)}</strong>/mo managed cloud spend`;
  }

  /**
   * The plan's own bullet list repeats the ceiling, and the server writes those
   * strings in dollars. Rewriting the one that quotes it keeps the card
   * internally consistent instead of showing ₹ above and $ below.
   */
  function featureLine(plan, text) {
    const r = region();
    const cap = plan.cap || (r === 'india' ? plan.indiaCap : plan.globalCap);
    if (!cap || cap.amount === null || cap.currency !== 'INR') return esc(text);
    if (!/^Cumulative billing of \$/.test(text)) return esc(text);
    return esc(`Cumulative billing of ${amount(cap.amount, cap.currency)}`);
  }

  function card(plan) {
    const cta = inApp
      ? `<button class="btn ${plan.featured ? 'btn-primary ' : ''}plan-cta" data-select-plan="${esc(plan.name)}">Choose ${esc(plan.name)}</button>`
      : `<a class="btn ${plan.featured ? 'btn-primary ' : ''}plan-cta" href="${loginUrl}">Start with ${esc(plan.name)}</a>`;

    return `
      <div class="plan-card${plan.featured ? ' featured' : ''}" data-plan="${esc(plan.id)}">
        ${plan.featured ? '<div class="plan-ribbon">Most popular</div>' : ''}
        <div class="plan-name">${esc(plan.name)}</div>
        ${priceBlock(plan)}
        <div class="plan-cap">${capLine(plan)}</div>
        <ul class="plan-features">
          ${plan.features.map(f => `<li>${featureLine(plan, f)}</li>`).join('')}
        </ul>
        ${cta}
      </div>`;
  }

  /**
   * @param supplied the catalogue from GET /billing, when the caller has one.
   *   Passing it skips the public fetch entirely — which is the point: that
   *   response is cached, so a price or cap changed moments ago in BMS would
   *   not appear here for up to five minutes.
   */
  async function render(supplied) {
    try {
      let plans = supplied;
      if (!plans) {
        const res = await fetch(`${window.CM_CONFIG.apiUrl}/plans`);
        if (!res.ok) throw new Error(`GET /plans failed: ${res.status}`);
        ({ plans } = await res.json());
      }
      grid.innerHTML = plans.map(card).join('');
      grid.dispatchEvent(new CustomEvent('cm-plans-rendered', { bubbles: true, detail: { plans } }));
    } catch (err) {
      // Quoting a price we couldn't load is worse than admitting it: a stale
      // hardcoded fallback here is exactly the drift this file exists to stop.
      console.error('Could not load plans', err);
      grid.innerHTML = `<p class="muted" style="padding:20px 0">
        Plan details are temporarily unavailable. Please refresh, or email
        <a href="mailto:hello@cloudmeter.io">hello@cloudmeter.io</a>.</p>`;
    }
  }

  // Exposed so the portal can re-render once GET /billing has resolved the
  // tenant's real region — this file renders immediately from the public
  // catalogue, which lands well before the authenticated call does.
  window.CM_renderPlans = render;

  render();
})();
