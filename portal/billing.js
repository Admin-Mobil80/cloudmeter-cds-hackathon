/**
 * Why the plan prices are in a currency the rest of the portal is not using.
 *
 * The display currency is a preference about how *cloud spend* is shown. The
 * billing currency is a fact about the transaction: regionForTenant reads the
 * billing address, falling back to timezone, and that same region decides the
 * payment gateway and whether GST applies. The two are allowed to differ, and
 * when they do the page has to say so — these are the figures the card is
 * charged, and converting them to the display currency would quote a number
 * nobody is ever billed.
 */
let lastBilling = null;

// /billing and /me race, and the note needs both — the region from one, the
// display currency from the other. Whichever lands second re-renders.
document.addEventListener('cm-me-loaded', () => renderCurrencyNote(lastBilling));

function renderCurrencyNote(billing) {
  const note = document.getElementById('plans-currency-note');
  if (billing) lastBilling = billing;
  if (!note || !lastBilling) return;
  billing = lastBilling;

  const billed = billing.region === 'india' ? 'INR' : 'USD';
  const shown = (window.CM_ME && window.CM_ME.currency && window.CM_ME.currency.code) || billed;
  if (shown === billed) { note.hidden = true; return; }

  const gst = Number(billing.gstPercent) > 0 ? ` with ${Number(billing.gstPercent)}% GST` : '';
  note.textContent = `Plans are billed in ${billed}${gst}, set by your billing region. `
    + `Cloud spend is shown in ${shown} — a display preference that doesn't change what you're charged.`;
  note.hidden = false;
}

// CloudMeter — Billing & Plan. Usage, subscription state, and Stripe checkout.
//
// Every figure and limit comes from GET /billing, which reads the same plan
// catalogue the server enforces against — so the page cannot recommend or
// display a tier on numbers the backend disagrees with.

let BILLING = null;

function money(n) { return CM_money(n, { decimals: 0 }); }

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadBilling() {
  try {
    BILLING = await window.CM_Api.get('/billing');
  } catch (err) {
    console.error('Failed to load billing', err);
    return null;
  }

  // plans.js renders from the public catalogue as soon as the page loads,
  // before this authenticated call returns, so it has to guess the region from
  // the browser timezone. Now that the server has told us where this tenant is
  // actually billed — and therefore whether GST applies — re-render the cards
  // against the real answer.
  if (BILLING.billing && window.CM_renderPlans) {
    window.CM_BILLING_REGION = BILLING.billing.region;
    renderCurrencyNote(BILLING.billing);
    // Hand over this response's own catalogue rather than letting plans.js
    // re-fetch the public one: GET /billing is uncached and already carries
    // each plan's price and spend cap resolved for this tenant, so a change
    // made in BMS shows up immediately instead of after the 5-minute cache.
    window.CM_renderPlans(BILLING.plans);
  }
  return BILLING;
}

function renderUsage() {
  const mtdEl = document.getElementById('billing-mtd');
  const projEl = document.getElementById('billing-projected');
  const recEl = document.getElementById('billing-recommend');
  if (!mtdEl || !BILLING) return;

  const { usage, plans, recommendedPlanId } = BILLING;
  mtdEl.textContent = money(usage.managedSpendUsd);
  projEl.textContent = `${usage.cloudAccounts} connected`;

  if (!recEl) return;
  if (usage.managedSpendUsd <= 0 && usage.cloudAccounts === 0) {
    recEl.textContent = "Connect a cloud account and we'll recommend the plan that fits.";
    return;
  }

  const rec = plans.find(p => p.id === recommendedPlanId);
  if (!rec) return;

  const card = document.querySelector(`.plan-card[data-plan="${rec.id}"]`);
  if (card && !card.querySelector('.ribbon-recommend')) {
    card.classList.add('recommended');
    card.insertAdjacentHTML('afterbegin', '<div class="plan-ribbon ribbon-recommend">Matches your usage</div>');
  }

  recEl.innerHTML = `Across ${usage.cloudAccounts} cloud account${usage.cloudAccounts === 1 ? '' : 's'} `
    + `and ${money(usage.managedSpendUsd)} of monitored spend this month, <strong>${esc(rec.name)}</strong> is the closest fit.`;
}

/**
 * The subscription banner.
 *
 * States worth distinguishing: never subscribed (trial), active, set to cancel
 * at period end, and lapsed. Collapsing them loses exactly the information
 * someone opens this page to find.
 */
function renderSubscription() {
  const note = document.getElementById('selected-plan-note');
  if (!note || !BILLING) return;

  const { subscription, plans, usage } = BILLING;
  const plan = plans.find(p => p.id === subscription.planId);

  if (BILLING.checkoutAvailable === false) {
    note.classList.add('show');
    note.innerHTML = `<strong>Card payments aren't switched on yet.</strong> `
      + `You have full access in the meantime — nothing is charged, and no card is needed. `
      + `We'll let you know as soon as plans can be started.`;
    return;
  }

  if (!subscription.entitled) {
    const row = document.getElementById('next-payment');
    if (row) row.hidden = true;
    // Still shown when not entitled: an unauthorised mandate is exactly why
    // someone is not entitled, and hiding it would hide the explanation.
    renderPaymentMethod(BILLING.paymentMethod);
    note.classList.add('show');
    note.innerHTML = subscription.planId
      ? `<strong>No active subscription.</strong> Your ${esc(plan ? plan.name : subscription.planId)} plan is no longer active. `
        + `Choose a plan below to restart it.`
      : `<strong>You're on the free trial.</strong> Choose a plan whenever you're ready — `
        + `nothing is charged until you complete checkout.`;
    return;
  }

  const ends = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  renderNextPayment(subscription, plan, ends);
  renderPaymentMethod(BILLING.paymentMethod);

  const overs = [];
  if (usage.overAccounts) overs.push(`${usage.cloudAccounts} cloud accounts`);
  if (usage.overSpend) overs.push(`${money(usage.managedSpendUsd)} of monitored spend`);

  note.classList.add('show');
  note.innerHTML = `<strong>${esc(plan ? plan.name : 'Your plan')} — active.</strong> `
    + (subscription.cancelAtPeriodEnd
      ? `Set to cancel${ends ? ` on ${ends}` : ''}; you keep access until then. `
      : ends ? `Renews on ${ends}. ` : '')
    + (overs.length
      ? `<span class="over-limit">You're above this plan's limits (${overs.join(' and ')}) — consider moving up.</span> `
      : '')
    + (subscription.canManage
      ? `<button class="link-btn-sm" id="manage-billing">Manage billing, invoices and payment method</button>`
      : `Only the account owner or an admin can change the plan.`);

  const manage = document.getElementById('manage-billing');
  if (manage) manage.addEventListener('click', openPortal);
}

/**
 * When the next charge lands, and for how much.
 *
 * The gateway's own checkout cannot show this: no second cycle exists until
 * the customer authorises the mandate, so Razorpay prints "-" there. By the
 * time this page renders, a charge has been taken and `currentPeriodEnd` is a
 * real date rather than a prediction.
 *
 * Formatted in the *billing* currency, never through money() — see the note at
 * the top of this file. These figures are what the card is charged; converting
 * them to the display currency would quote a number nobody is ever billed.
 */
function billingAmount(value, currency) {
  const symbol = { INR: '₹', USD: '$' }[currency] || '';
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${Number(value).toLocaleString(locale, { maximumFractionDigits: 0 })}`;
}

/*
 * Which card is paying, or plainly that none is.
 *
 * Read live from the gateway rather than from our own record, because our
 * record cannot tell an authorised subscription from an abandoned one. A
 * production workspace sat with an unauthorised Razorpay mandate — no
 * customer, no card, no possibility of charging — for a month while this page
 * showed it as being on a paid plan.
 *
 * `unknown` is deliberately not treated as "no card": the gateway was
 * unreachable, and telling a paying customer their payment method is missing
 * would be worse than saying nothing.
 */
function renderPaymentMethod(pm) {
  const row = document.getElementById('payment-method');
  const value = document.getElementById('payment-method-value');
  const note = document.getElementById('payment-method-note');
  if (!row || !value || !note) return;

  if (!pm || pm.state === 'unknown') { row.hidden = true; return; }

  const when = pm.nextChargeAt
    ? new Date(pm.nextChargeAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  if (pm.state === 'active' && pm.label) {
    value.textContent = pm.label;
    note.textContent = [
      pm.expiry ? `Expires ${pm.expiry}` : null,
      when ? `Renews ${when}` : null,
    ].filter(Boolean).join(' · ');
  } else if (pm.state === 'awaiting_authorisation') {
    // The Mobil80 case. Checkout was started and never completed, so the
    // subscription exists, cannot charge, and will not renew.
    value.textContent = 'Not authorised';
    note.textContent = 'Checkout was started but never completed, so nothing will be '
      + 'charged and this plan will not renew. Choose a plan below to finish it.';
  } else if (pm.state === 'none') {
    // A plan entered by hand in BMS. Genuinely fine — somebody is paying by
    // invoice or it is a courtesy — but it must not look like a live mandate.
    value.textContent = 'None on file';
    note.textContent = 'This plan was set up manually and has no card attached, '
      + 'so it will not renew automatically.';
  } else if (pm.state === 'inactive') {
    value.textContent = pm.label || 'No longer active';
    note.textContent = 'The subscription with this payment method has ended.';
  } else {
    row.hidden = true;
    return;
  }

  row.hidden = false;
}

function renderNextPayment(subscription, plan, ends) {
  const row = document.getElementById('next-payment');
  const value = document.getElementById('next-payment-value');
  const note = document.getElementById('next-payment-note');
  if (!row || !value || !note) return;

  // Nothing recurs on a cancelled subscription; the plan note above already
  // says when access stops, and repeating it as a "next payment" would be
  // straightforwardly wrong. No date means the subscription is undateable —
  // a known state on the server — and inventing "a month from now" would put
  // a figure on screen nobody is going to be charged.
  if (!ends || subscription.cancelAtPeriodEnd) { row.hidden = true; return; }

  // `total` is what the gateway actually charged, tax included — the figure on
  // the invoice, and the only one guaranteed to match. The plan price is the
  // fallback for a subscription recorded before those amounts were stored; it
  // is also tax-inclusive, so it differs only if the price has since changed.
  const charged = typeof subscription.total === 'number' ? subscription.total : null;
  const currency = subscription.currency || (plan && plan.price.currency) || null;

  let amount = null;
  if (charged !== null && currency) amount = billingAmount(charged, currency);
  else if (plan && plan.price) amount = billingAmount(plan.price.total, plan.price.currency);

  value.textContent = amount ? `${amount} on ${ends}` : ends;
  note.textContent = charged !== null
    ? 'Charged automatically to your saved payment method.'
    : 'Based on your current plan price.';
  row.hidden = false;
}

async function openPortal() {
  const btn = document.getElementById('manage-billing');
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const { url } = await window.CM_Api.post('/billing/portal-session');
    window.location.href = url;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Manage billing, invoices and payment method';
    window.alert(err.message || 'Could not open the billing portal.');
  }
}

/**
 * Marks the plan in force and points each button at Stripe Checkout.
 *
 * Wired on cm-plans-rendered because the cards arrive from GET /plans; binding
 * on DOMContentLoaded would find an empty grid.
 */
function wirePlanSelection() {
  const current = BILLING && BILLING.subscription.entitled ? BILLING.subscription.planId : null;
  const canManage = !BILLING || BILLING.subscription.canManage;
  // Until Stripe is configured no button can work, so they say so instead of
  // failing on click. Left enabled before /billing answers, then corrected.
  const checkoutReady = !BILLING || BILLING.checkoutAvailable !== false;

  document.querySelectorAll('.plan-card').forEach((card) => {
    const btn = card.querySelector('[data-select-plan]');
    if (!btn) return;

    // The listener is attached once; the label and disabled state are applied
    // every time. /plans and /billing resolve independently, so this runs once
    // with no subscription known and again once it is — and the second pass is
    // the one that marks the current plan. A single "already wired" guard
    // skipped that pass entirely.
    if (!btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        if (!btn.disabled) startCheckout(card.dataset.plan, btn);
      });
    }

    const name = card.querySelector('.plan-name').textContent;
    card.classList.toggle('is-selected', card.dataset.plan === current);

    if (card.dataset.plan === current) {
      btn.textContent = '✓ Current plan';
      btn.disabled = true;
      btn.title = '';
    } else if (!checkoutReady) {
      btn.textContent = 'Coming soon';
      btn.disabled = true;
      btn.title = 'Card payments are being switched on. Nothing can be charged yet.';
    } else if (!canManage) {
      btn.textContent = `Choose ${name}`;
      btn.disabled = true;
      btn.title = 'Only the account owner or an admin can change the plan.';
    } else {
      btn.textContent = current ? `Switch to ${name}` : `Choose ${name}`;
      btn.disabled = false;
      btn.title = '';
    }
  });
}

async function startCheckout(planId, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening secure checkout…';
  try {
    const { url } = await window.CM_Api.post('/billing/checkout-session', { planId });
    // Card details are entered on Stripe's own page — CloudMeter never sees a
    // card number, which is the whole reason for redirecting rather than
    // collecting anything here.
    window.location.href = url;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    const note = document.getElementById('selected-plan-note');
    note.classList.add('show');
    note.innerHTML = `<strong>Checkout couldn't start.</strong> ${esc(err.message || 'Please try again.')}`;
    // The note sits below the plan grid, so a failure can land off-screen and
    // read as the button having done nothing at all.
    note.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Stripe redirects back here after checkout. The subscription itself is
 * recorded by the webhook, which may land a moment later — so this reports
 * what happened and re-reads state rather than asserting success on its own.
 */
function reportCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('checkout');
  if (!outcome) return;

  const note = document.getElementById('selected-plan-note');
  note.classList.add('show');
  note.innerHTML = outcome === 'success'
    ? `<strong>Payment received — thank you.</strong> Your plan is being activated; this page will update in a moment.`
    : `<strong>Checkout cancelled.</strong> Nothing was charged.`;

  window.history.replaceState({}, '', window.location.pathname);

  if (outcome === 'success') {
    setTimeout(async () => {
      if (await loadBilling()) { renderSubscription(); renderUsage(); wirePlanSelection(); }
    }, 4000);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Spend-against-plan is rendered through CM_money; /me carries the currency.
  await window.CM_MeReady;
  await loadBilling();
  renderUsage();
  renderSubscription();
  wirePlanSelection();
  reportCheckoutReturn();
});

// Cards render asynchronously; decorate them whenever they arrive.
document.addEventListener('cm-plans-rendered', () => {
  renderUsage();
  wirePlanSelection();
});
