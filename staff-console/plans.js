// CloudMeter BMS — what the platform charges, and who processes it.

let SETTING = null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function stamp(el, updatedAt, updatedBy, neverText) {
  if (!updatedAt) { el.textContent = neverText; return; }
  const when = new Date(updatedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  el.textContent = `Set by ${updatedBy || 'unknown'} on ${when}.`;
}

// ---- pricing -----------------------------------------------------------

function renderPricing() {
  const wrap = document.getElementById('pricing-editor');
  wrap.setAttribute('aria-busy', 'false');

  const pricing = SETTING.pricing || {};
  const prices = pricing.prices || {};
  const caps = pricing.caps || {};
  const plans = SETTING.plans || [];
  const range = SETTING.trialDaysRange || { min: 1, max: 14 };

  // Price and cap sit together per region rather than in four separate
  // columns: they are one commercial decision — "this much money buys this
  // much monitored spend" — and splitting them made you read across the table
  // to see the pair.
  wrap.innerHTML = `
    <div class="price-grid">
      <div class="price-head">
        <span>Plan</span>
        <span>India — INR (before GST)</span>
        <span>Outside India — USD</span>
      </div>
      ${plans.map(p => `
        <div class="price-row">
          <span class="price-plan">${esc(p.name)}</span>
          <div class="region-cell">
            <label class="price-field">
              <span class="price-prefix">₹</span>
              <input type="number" min="0" step="1" data-price="${esc(p.id)}" data-cur="inr"
                     aria-label="${esc(p.name)} price in INR">
            </label>
            <label class="price-field cap-field">
              <span class="price-prefix">cap ₹</span>
              <input type="number" min="0" step="1" data-cap="${esc(p.id)}" data-cur="inr"
                     placeholder="unlimited" aria-label="${esc(p.name)} spend cap in INR">
            </label>
          </div>
          <div class="region-cell">
            <label class="price-field">
              <span class="price-prefix">$</span>
              <input type="number" min="0" step="1" data-price="${esc(p.id)}" data-cur="usd"
                     aria-label="${esc(p.name)} price in USD">
            </label>
            <label class="price-field cap-field">
              <span class="price-prefix">cap $</span>
              <input type="number" min="0" step="1" data-cap="${esc(p.id)}" data-cur="usd"
                     placeholder="unlimited" aria-label="${esc(p.name)} spend cap in USD">
            </label>
          </div>
        </div>`).join('')}
    </div>

    <div class="gst-row">
      <label class="price-field gst-field">
        <input type="number" min="0" max="100" step="0.5" id="gst-percent" aria-label="GST percentage">
        <span class="price-suffix">%</span>
      </label>
      <span class="gst-label">GST added to Indian invoices. Not charged anywhere else, whichever gateway is used.</span>
    </div>

    <div class="gst-row">
      <label class="price-field gst-field">
        <input type="number" min="${range.min}" max="${range.max}" step="1" id="trial-days"
               aria-label="Free trial length in days">
        <span class="price-suffix">days</span>
      </label>
      <span class="gst-label">Free trial length, ${range.min}–${range.max} days. Applies to accounts created from now on — nobody already on a trial has their date moved.</span>
    </div>

    <div class="price-preview" id="price-preview"></div>`;

  // Values assigned as properties, not built into the HTML above: an amount
  // typed by staff is data, and interpolating it into an attribute is how one
  // stray quote breaks the field.
  plans.forEach(p => {
    const price = prices[p.id] || {};
    const cap = caps[p.id] || {};
    const set = (sel, v) => { const e = wrap.querySelector(sel); if (e) e.value = v ?? ''; };
    set(`[data-price="${p.id}"][data-cur="inr"]`, price.inr ?? p.defaultInr);
    set(`[data-price="${p.id}"][data-cur="usd"]`, price.usd ?? p.defaultUsd);
    // Blank means unlimited, so null stays blank rather than becoming 0.
    set(`[data-cap="${p.id}"][data-cur="inr"]`, cap.inr === null || cap.inr === undefined ? '' : cap.inr);
    set(`[data-cap="${p.id}"][data-cur="usd"]`, cap.usd === null || cap.usd === undefined ? '' : cap.usd);
  });
  document.getElementById('gst-percent').value = pricing.gstPercent ?? 18;
  document.getElementById('trial-days').value = pricing.trialDays ?? 7;

  wrap.querySelectorAll('input').forEach(i => i.addEventListener('input', renderPreview));
  renderPreview();
  stamp(document.getElementById('pricing-meta'), pricing.updatedAt, pricing.updatedBy,
    'Never changed — using the built-in values.');
}

const money = (v, cur) => (cur === 'INR' ? '₹' : '$')
  + Number(v).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 2 });

/**
 * Shows what an Indian customer is actually billed, and what they get for it.
 *
 * The INR field is the pre-tax price, which is not the number that leaves the
 * customer's account — without this, whoever sets 2000 has to do the GST
 * arithmetic in their head to know they have priced the plan at 2360.
 */
function renderPreview() {
  const el = document.getElementById('price-preview');
  if (!el) return;
  const gst = Number(document.getElementById('gst-percent')?.value) || 0;
  const val = sel => document.querySelector(sel)?.value;

  const rows = (SETTING.plans || []).map(p => {
    const inr = Number(val(`[data-price="${p.id}"][data-cur="inr"]`)) || 0;
    const usd = Number(val(`[data-price="${p.id}"][data-cur="usd"]`)) || 0;
    const capInrRaw = val(`[data-cap="${p.id}"][data-cur="inr"]`);
    const capUsdRaw = val(`[data-cap="${p.id}"][data-cur="usd"]`);
    const tax = Math.round(inr * gst) / 100;

    // Mirrors capFor() on the server: with no rupee cap set, India is quoted
    // the dollar one, and saying so here stops that looking like a bug.
    const capIndia = capInrRaw !== '' && capInrRaw != null
      ? money(capInrRaw, 'INR')
      : (capUsdRaw !== '' && capUsdRaw != null ? `${money(capUsdRaw, 'USD')} (USD — no INR cap set)` : 'unlimited');
    const capGlobal = capUsdRaw !== '' && capUsdRaw != null ? money(capUsdRaw, 'USD') : 'unlimited';

    return `<div class="preview-row">
      <span class="preview-plan">${esc(p.name)}</span>
      <span>India: <strong>${money(inr + tax, 'INR')}</strong>
        <span class="muted">(${money(inr, 'INR')} + ${money(tax, 'INR')} GST) · up to ${capIndia}/mo</span></span>
      <span>Outside India: <strong>${money(usd, 'USD')}</strong>
        <span class="muted">(no tax) · up to ${capGlobal}/mo</span></span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="preview-title">What customers are charged, and what it covers</div>${rows}`;
}

async function savePricing() {
  const err = document.getElementById('pricing-error');
  const confirm = document.getElementById('pricing-confirm');
  const btn = document.getElementById('pricing-save');
  err.classList.remove('show');

  const prices = {};
  const caps = {};
  const capValue = (sel) => {
    const raw = document.querySelector(sel)?.value;
    // Blank is unlimited, and null is how the API spells it.
    return raw === '' || raw == null ? null : Number(raw);
  };
  for (const p of SETTING.plans || []) {
    prices[p.id] = {
      inr: Number(document.querySelector(`[data-price="${p.id}"][data-cur="inr"]`)?.value),
      usd: Number(document.querySelector(`[data-price="${p.id}"][data-cur="usd"]`)?.value),
    };
    caps[p.id] = {
      inr: capValue(`[data-cap="${p.id}"][data-cur="inr"]`),
      usd: capValue(`[data-cap="${p.id}"][data-cur="usd"]`),
    };
  }
  const gstPercent = Number(document.getElementById('gst-percent')?.value);
  const trialDays = Number(document.getElementById('trial-days')?.value);

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    SETTING = { ...SETTING, ...(await window.CM_Api.put('/bms/settings/payments', { prices, caps, gstPercent, trialDays })) };
    renderPricing();
    confirm.classList.add('show');
    clearTimeout(confirm._t);
    confirm._t = setTimeout(() => confirm.classList.remove('show'), 2200);
  } catch (e) {
    err.textContent = e.message || 'Could not save pricing.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save pricing';
  }
}

// ---- gateway -----------------------------------------------------------

/*
 * What a gateway's badge says, in one of three states.
 *
 * It used to say "live" for anything holding credentials, which put a green
 * "live" on Razorpay while Stripe — also green, also live — was the one
 * actually charging. Two gateways cannot both be taking a region's money, so
 * the screen read as a contradiction, and the only way to tell which was real
 * was the radio button.
 *
 * "In use" is now the region's chosen gateway and nothing else. "Ready" is
 * configured but not selected, which is a real and useful state: it is what
 * you can switch to without pasting a key first. Razorpay is Ready under
 * Outside India and In use under India, which is exactly the truth.
 */
function badge(option, chosenKey, id) {
  const attr = id ? ` id="${id}"` : '';
  if (!option.live) return `<span class="g-tag"${attr}>not configured</span>`;
  return option.key === chosenKey
    ? `<span class="g-tag is-live"${attr}>in use</span>`
    : `<span class="g-tag is-ready"${attr}>ready</span>`;
}

function renderGateway() {
  const wrap = document.getElementById('gateway-options');
  wrap.setAttribute('aria-busy', 'false');

  wrap.innerHTML = (SETTING.options || []).map(o => `
    <label class="gateway-option${o.key === SETTING.globalGateway ? ' is-current' : ''}">
      <input type="radio" name="gateway" value="${esc(o.key)}"
             ${o.key === SETTING.globalGateway ? 'checked' : ''}>
      <span class="g-body">
        <span class="g-name">
          ${esc(o.label)}
          ${badge(o, SETTING.globalGateway)}
        </span>
        <span class="g-note">${esc(o.note)}</span>
      </span>
    </label>`).join('');

  // India's card is fixed to Razorpay and has no radio, but its badge answers
  // the same question, so it reads from the same place rather than from markup.
  const indiaTag = document.getElementById('india-gateway-tag');
  if (indiaTag) {
    const india = (SETTING.options || []).find(o => o.key === SETTING.indiaGateway);
    indiaTag.outerHTML = india
      ? badge(india, SETTING.indiaGateway, 'india-gateway-tag')
      : '<span id="india-gateway-tag"></span>';
  }

  wrap.querySelectorAll('input[name="gateway"]').forEach(input => {
    input.addEventListener('change', () => saveGateway(input.value));
  });
  stamp(document.getElementById('gateway-meta'), SETTING.updatedAt, SETTING.updatedBy,
    'Never changed — using the default.');
}

async function saveGateway(gateway) {
  const err = document.getElementById('gateway-error');
  const confirm = document.getElementById('gateway-confirm');
  err.classList.remove('show');

  // Money routing is worth one deliberate pause; a radio button is otherwise
  // a single stray click away from sending every new checkout elsewhere.
  const option = (SETTING.options || []).find(o => o.key === gateway);
  if (!window.confirm(
    `Send new checkouts from customers outside India through ${option ? option.label : gateway}?`
    + '\n\nIndian customers stay on Razorpay either way.'
    + (option && !option.live ? '\n\nThis gateway is not configured — checkout will fail until it is.' : '')
  )) {
    renderGateway();
    return;
  }

  try {
    SETTING = { ...SETTING, ...(await window.CM_Api.put('/bms/settings/payments', { globalGateway: gateway })) };
    renderGateway();
    confirm.classList.add('show');
    clearTimeout(confirm._t);
    confirm._t = setTimeout(() => confirm.classList.remove('show'), 2200);
  } catch (e) {
    err.textContent = e.message || 'Could not change the gateway.';
    err.classList.add('show');
    renderGateway();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    SETTING = await window.CM_Api.get('/bms/settings/payments');
  } catch (e) {
    document.getElementById('gateway-options').innerHTML =
      `<p class="muted" style="margin:0">Couldn't load payment settings — ${esc(e.message || '')}</p>`;
    document.getElementById('pricing-editor').innerHTML = '';
    return;
  }
  renderPricing();
  renderGateway();
  document.getElementById('pricing-save').addEventListener('click', savePricing);
});
