// CloudMeter — cross-provider price comparison.
//
// Open to every role: choosing a provider is a developer's question, and a
// Member who can't see Billing still needs to know what an instance costs
// before launching one.

let CATALOG = null;
let categories = {};
let currentCategory = 'all';
let currentProvider = 'all';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const PROVIDER_NAME = {
  aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud',
  alibaba: 'Alibaba Cloud', huawei: 'Huawei Cloud', openai: 'OpenAI',
  whatsapp: 'WhatsApp Business',
};

function providerColor(key) {
  return `var(--provider-${key === 'openai' ? 'openai' : key})`;
}

/**
 * Prices here span five orders of magnitude — $15 per million tokens down to
 * $0.0000025 per GB-second — so a fixed number of decimals is either useless
 * or unreadable. Significant figures keep every row legible.
 */
function money(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

/** How much more than the cheapest option, as a plain multiplier. */
function relative(price, cheapest) {
  if (!cheapest || price === cheapest) return '';
  const times = price / cheapest;
  if (times < 1.005) return '';
  return `${times.toFixed(times < 10 ? 2 : 1)}×`;
}

function renderProviderPicker() {
  const select = document.getElementById('pricing-provider');
  const present = [...new Set(CATALOG.workloads.flatMap(w => w.entries.map(e => e.provider)))];

  select.innerHTML = '<option value="all">Compare all providers</option>'
    + present.map(k => `<option value="${esc(k)}">${esc(PROVIDER_NAME[k] || k)}</option>`).join('');
  select.value = currentProvider;

  select.addEventListener('change', () => {
    currentProvider = select.value;
    renderList();
  });
}

/**
 * Everything one provider charges, in one table.
 *
 * The comparison view answers "who is cheapest for X"; this answers "what does
 * AWS cost me", which is the other half of why someone opens a pricing page.
 * Each row still carries how it ranks against the other providers, so picking
 * a single provider doesn't hide the thing the page exists to show.
 */
function renderProviderView(providerKey, term) {
  const rows = CATALOG.workloads
    .filter(w => currentCategory === 'all' || w.category === currentCategory)
    .map((w) => {
      const entry = w.entries.find(e => e.provider === providerKey);
      if (!entry) return null;
      const cheapest = Math.min(...w.entries.map(e => e.price));
      return { w, entry, cheapest, rivals: w.entries.length };
    })
    .filter(Boolean)
    .filter(({ w, entry }) => !term
      || w.name.toLowerCase().includes(term)
      || (categories[w.category] || '').toLowerCase().includes(term)
      || entry.sku.toLowerCase().includes(term));

  if (rows.length === 0) return null;

  const wins = rows.filter(r => r.entry.price === r.cheapest).length;

  return `
    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <h2>${esc(PROVIDER_NAME[providerKey] || providerKey)} — all services</h2>
          <p>Cheapest of the providers compared on ${wins} of ${rows.length} workloads.
             Each row shows how this provider ranks against the others.</p>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        <div class="price-table">
          ${rows.map(({ w, entry, cheapest }) => `
            <div class="price-row${entry.price === cheapest ? ' is-cheapest' : ''}">
              <span class="p-provider" style="font-weight:650">${esc(w.name)}</span>
              <span class="p-sku">
                ${esc(entry.sku)}
                <span class="d">${esc(w.unit)}${entry.detail ? ' · ' + esc(entry.detail) : ''}</span>
              </span>
              <span class="p-price">${money(entry.price)}</span>
              <span class="p-rel">${entry.price === cheapest
                ? '<span class="cheapest-tag">cheapest</span>'
                : esc(relative(entry.price, cheapest))}</span>
              <span class="p-source">${sourceTag(entry)}</span>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderCategories() {
  const wrap = document.getElementById('pricing-categories');
  const present = [...new Set(CATALOG.workloads.map(w => w.category))];
  const tabs = [['all', 'All']].concat(present.map(c => [c, categories[c] || c]));

  wrap.innerHTML = tabs.map(([key, label]) =>
    `<button data-cat="${esc(key)}" class="${key === currentCategory ? 'active' : ''}">${esc(label)}</button>`
  ).join('');

  wrap.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentCategory = btn.dataset.cat;
      renderCategories();
      renderList();
    });
  });
}

/** Does this row match what was typed — by provider name, key, or SKU? */
function entryMatches(entry, term) {
  return entry.sku.toLowerCase().includes(term)
    || entry.provider.includes(term)
    || (PROVIDER_NAME[entry.provider] || '').toLowerCase().includes(term);
}

/**
 * What a search term selects.
 *
 * Two different intents share one box, and they need different answers:
 * naming a workload ("storage") means "compare everyone on this", so the whole
 * card stays; naming a provider or SKU ("azure", "m5.xlarge") means "show me
 * this one", so the card narrows to the matching rows. Without the second
 * case, typing a provider that appears in every workload — AWS and Azure both
 * do — changed nothing on screen and the box looked broken.
 */
function selectRows(workload, term) {
  if (!term) return { entries: workload.entries, narrowed: false };

  const nameHit = workload.name.toLowerCase().includes(term)
    || (categories[workload.category] || '').toLowerCase().includes(term)
    || workload.unit.toLowerCase().includes(term);
  if (nameHit) return { entries: workload.entries, narrowed: false };

  const hits = workload.entries.filter(e => entryMatches(e, term));
  return { entries: hits, narrowed: hits.length > 0 && hits.length < workload.entries.length };
}

function renderList() {
  const list = document.getElementById('pricing-list');
  const term = (document.getElementById('pricing-filter').value || '').trim().toLowerCase();

  const visible = CATALOG.workloads
    .filter(w => currentCategory === 'all' || w.category === currentCategory)
    .map(w => ({ workload: w, ...selectRows(w, term) }))
    .filter(v => v.entries.length > 0);

  list.setAttribute('aria-busy', 'false');

  if (currentProvider !== 'all') {
    const html = renderProviderView(currentProvider, term);
    list.innerHTML = html || '<div class="card"><div class="card-body"><p class="muted" style="margin:0">'
      + 'Nothing matches that for this provider.</p></div></div>';
    return;
  }

  if (visible.length === 0) {
    list.innerHTML = '<div class="card"><div class="card-body"><p class="muted" style="margin:0">'
      + 'Nothing matches that. Try a provider name, or a SKU like "m5.xlarge".</p></div></div>';
    return;
  }

  list.innerHTML = visible.map(({ workload: w, entries, narrowed }) => {
    // Ranking is always computed against every provider, never the filtered
    // subset — otherwise narrowing to one provider would crown it "cheapest"
    // and the page would be confidently wrong about the thing it exists for.
    const ranked = [...w.entries].sort((a, b) => a.price - b.price);
    const cheapest = ranked.length ? ranked[0].price : 0;
    const rows = ranked.filter(e => entries.includes(e));

    return `
    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <h2>${esc(w.name)}</h2>
          <p>${esc(w.basis)}</p>
        </div>
        <span class="badge">${esc(w.unit)}</span>
      </div>
      <div class="card-body" style="padding:0">
        ${w.region ? `<div class="provider-meta" style="padding:8px 18px 0">Region: ${esc(w.region)}</div>` : ''}
        ${narrowed ? `<div class="provider-meta" style="padding:8px 18px 0">Showing ${rows.length} of ${w.entries.length} providers — clear the filter to compare all.</div>` : ''}
        <div class="price-table">
          ${rows.map(e => `
            <div class="price-row${e.price === cheapest ? ' is-cheapest' : ''}">
              <span class="p-provider">
                <span class="sq" style="background:${providerColor(e.provider)}"></span>
                ${esc(PROVIDER_NAME[e.provider] || e.provider)}
              </span>
              <span class="p-sku">
                ${esc(e.sku)}
                ${e.detail ? `<span class="d">${esc(e.detail)}</span>` : ''}
              </span>
              <span class="p-price">${money(e.price)}</span>
              <span class="p-rel">${e.price === cheapest ? '<span class="cheapest-tag">cheapest</span>' : esc(relative(e.price, cheapest))}</span>
              <span class="p-source">${sourceTag(e)}</span>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
  }).join('');
}

/**
 * Live and curated figures are never blurred together: a remembered list
 * price presented like a fetched one is the failure mode that matters here,
 * because people make provider decisions on this page.
 */
function sourceTag(entry) {
  if (entry.source === 'live') {
    return `<span class="src-live" title="Fetched from the provider's pricing API on ${esc(entry.asOf)}">live</span>`;
  }
  const label = `<span class="src-curated" title="Published list price recorded on ${esc(entry.asOf)} — verify before relying on it">list · ${esc(entry.asOf)}</span>`;
  return entry.sourceUrl
    ? `<a href="${esc(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
}

function renderMeta() {
  const live = CATALOG.workloads.reduce((n, w) => n + w.entries.filter(e => e.source === 'live').length, 0);
  const total = CATALOG.workloads.reduce((n, w) => n + w.entries.length, 0);
  const when = new Date(CATALOG.refreshedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  document.getElementById('pricing-meta').innerHTML =
    `<strong>${live} of ${total}</strong> prices fetched live from AWS and Azure pricing APIs, refreshed ${esc(when)}. `
    + `The rest are published list prices recorded by hand — each one links to the provider's own pricing page, `
    + `and shows the date it was checked. Prices exclude tax, committed-use and volume discounts, `
    + `and any negotiated rate on your account.`;
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    CATALOG = await window.CM_Api.get('/pricing');
    categories = CATALOG.categories || {};
  } catch (err) {
    document.getElementById('pricing-list').innerHTML =
      `<div class="card"><div class="card-body"><p class="muted" style="margin:0">`
      + `Couldn't load pricing — ${esc(err.message || '')}</p></div></div>`;
    document.getElementById('pricing-meta').textContent = '';
    return;
  }

  renderMeta();
  renderProviderPicker();
  renderCategories();
  renderList();

  document.getElementById('pricing-filter').addEventListener('input', renderList);
});
