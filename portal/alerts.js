// CloudMeter — alerts list + detail panel, backed by the real Alerts API.

const SEV = {
  critical: { label: 'Critical', color: 'var(--status-critical)', badge: 'badge-critical' },
  serious:  { label: 'Serious',  color: 'var(--status-serious)',  badge: 'badge-serious'  },
  warning:  { label: 'Warning',  color: 'var(--status-warning)',  badge: 'badge-warning'  },
  good:     { label: 'Resolved', color: 'var(--status-good)',     badge: 'badge-good'     },
};

const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure', gcp: 'GCP', alibaba: 'Alibaba Cloud', huawei: 'Huawei Cloud', openai: 'OpenAI', whatsapp: 'WhatsApp Business' };
const PROVIDER_COLOR = {
  AWS: 'var(--provider-aws)', Azure: 'var(--provider-azure)', GCP: 'var(--provider-gcp)',
  'Alibaba Cloud': 'var(--provider-alibaba)', 'Huawei Cloud': 'var(--provider-huawei)',
  OpenAI: 'var(--provider-openai)', 'WhatsApp Business': 'var(--provider-whatsapp)',
};

let ALERTS = [];
let currentFilter = 'all';
let currentProvider = 'all';

/**
 * The alerts the two filters leave standing. One predicate for every caller,
 * so the list, the empty state and the auto-select after a filter change
 * cannot disagree about what is visible.
 */
function visibleAlerts() {
  return ALERTS.filter(a =>
    (currentFilter === 'all' || a.severity === currentFilter)
    && (currentProvider === 'all' || a.provider === currentProvider));
}

/**
 * Fills the provider dropdown from the providers this workspace has
 * connected, plus any that appear in the loaded alerts.
 *
 * Built from the data rather than typed into the HTML, because the typed
 * list stopped at five providers and stayed there while two more were
 * added. Connected providers rather than only those with alerts, so the
 * menu is the same fixed set every visit — a quiet provider is still
 * listed, and choosing it says "no alerts" rather than not being there,
 * which reads as missing. Alerts are unioned in so one raised by an
 * account since removed can still be filtered to.
 *
 * Adhoc Spend is left out: it never raises an alert (nothing polls it), so
 * it would be a permanently empty choice.
 */
function renderProviderOptions(connected = []) {
  const select = document.getElementById('provider-filter');
  if (!select) return;

  const keys = new Set([
    ...connected.filter(k => k && k !== 'adhoc'),
    ...ALERTS.map(a => a.provider).filter(Boolean),
  ]);
  const present = [...keys]
    .map(key => ({ key, label: PROVIDER_LABEL[key] || key }))
    .sort((x, y) => x.label.localeCompare(y.label));

  // Keep the current choice if its provider is still here; otherwise fall
  // back to all rather than leaving the select pointing at a vanished option.
  if (currentProvider !== 'all' && !present.some(p => p.key === currentProvider)) currentProvider = 'all';

  select.innerHTML = `<option value="all">All providers</option>`
    + present.map(p => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('');
  select.value = currentProvider;
}
let selectedId = null;

function fmtMoney(n) { return CM_money(n); }

/**
 * Attribute-safe escape. Local to this file: `esc` is defined separately in
 * accounts.js, team.js and pricing.js, and none of them is loaded here.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function channelIcon(kind) {
  if (kind === 'slack') return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 8h18M8 4v16"/></svg>`;
  if (kind === 'whatsapp') return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.5 8.5 0 1 1-4.08-7.26L21 3l-1.02 3.78A8.46 8.46 0 0 1 21 11.5Z"/></svg>`;
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>`;
}
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Email' };

/**
 * The money figure for an alert, and how to label it.
 *
 * Three cases, and they say different things:
 *   - a one-off charge, which was never projected — report what was charged;
 *   - a projection with days of evidence behind it — report the corrected
 *     forecast, not the one made on day one;
 *   - a projection still on its first day — the original stands, because
 *     nothing has arrived to revise it with.
 */
function impactFigure(a) {
  const act = a.actuals || {};
  if (a.impact === null || a.impact === undefined) {
    return { label: 'Charged', value: a.current, note: 'one-off — not projected' };
  }
  if (act.daysObserved > 0 && typeof act.projected === 'number') {
    return {
      label: 'Est. impact',
      value: act.projected,
      note: `revised from ${act.daysObserved} day${act.daysObserved === 1 ? '' : 's'} since`,
    };
  }
  return { label: 'Est. impact', value: a.impact, note: '' };
}

function providerLabel(a) { return PROVIDER_LABEL[a.provider] || a.provider; }

// "Mobil80 OpenAI · Rehearse RevenueCat" — the project beside the account,
// matching the email and WhatsApp wording for the same alert. It is the first
// thing anyone asks about an OpenAI spike, and the account alone can't say.
// Absent on providers without projects and on alerts raised before this existed.
function whereLabel(a) {
  return a.project && a.project.label ? `${a.accountName} · ${a.project.label}` : a.accountName;
}

/** Severities that get their own filter tab; anything else only lands in "All". */
const COUNTED_SEVERITIES = new Set(['critical', 'serious', 'warning']);

/**
 * An alert has three states, and only the first is "unread":
 *
 *   unseen   — nobody's opened it on this account
 *   updated  — you read it, and the sweep has since revised the numbers
 *   read     — you read it and nothing has changed
 *
 * `updated` exists because a recurring problem used to come back fully unread
 * every time it was re-detected, for everyone, however many times they had
 * already looked at it. It still asks for attention; it just no longer
 * pretends to be new. Older alerts carry neither flag and fall through to the
 * original two states.
 */
/*
 * How long ago the detector last saw this, when that is no longer today.
 *
 * An alert lives while its problem keeps recurring and is deleted seven days
 * after it stops (the table's TTL on expiresAt). That is a good lifecycle and
 * an invisible one: thirteen criticals worth $6,843 sat on a production
 * dashboard looking live, when the spend behind them had ended days earlier
 * and they were about to expire on their own. Nobody could tell without
 * querying the database.
 *
 * Only rendered once a day has passed. A live alert should look ordinary —
 * marking every row "seen today" would add noise to the ones that matter and
 * dilute the marker on the ones that do not.
 */
function quietFor(a) {
  if (!a.lastSeenAt) return null;
  const seen = new Date(a.lastSeenAt);
  if (Number.isNaN(seen.getTime())) return null;

  // Whole days between calendar dates, not elapsed hours: an alert last seen
  // late yesterday is "1 day", not "quiet 0d" because 18 hours have passed.
  const startOfDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.floor((startOfDay(new Date()) - startOfDay(seen)) / 86400000);
  if (days < 1) return null;

  return {
    days,
    label: `Quiet ${days}d`,
    title: `Last seen ${seen.toISOString().slice(0, 10)} — this stopped recurring, `
      + 'and clears on its own seven days after it was last seen.',
  };
}

function isUnseen(a) { return !a.read && !a.updated; }

/**
 * Point the sidebar badge at this page's own data.
 *
 * auth-guard seeds the badge from /me at page load and nothing refreshes it,
 * so on every other page it is a snapshot of whenever that tab was opened.
 * It used to go stale on its own as well, because re-detecting a recurring
 * anomaly cleared `readBy` for everyone; that read state is now carried into
 * `seenBefore` and surfaces as "updated" instead.
 *
 * This page has just fetched every alert with a per-caller `read` flag, which
 * is the authoritative answer, so it overwrites the snapshot rather than
 * nudging it. Recomputing from ALERTS also means the badge cannot drift out of
 * step with the filter tabs — both now count the same array.
 */
function syncAlertBadge() {
  // Never opened. An alert marked `updated` was read and has since been
  // revised — it is flagged in the list, but it does not push the badge back
  // up, which is what made the count climb on its own overnight.
  const unread = ALERTS.filter(a => isUnseen(a)).length;
  document.querySelectorAll('[data-alert-count]').forEach(el => {
    el.textContent = unread;
    // Hidden at zero rather than showing "0", matching auth-guard.
    el.hidden = unread === 0;
  });
}

/**
 * Puts the real count on each filter tab.
 *
 * These were static text in the markup — "All (4)" while six alerts sat below
 * it — so the numbers described a mockup rather than the account.
 *
 * The number shown is *unread*, matching the sidebar badge — an inbox's
 * "Inbox (3)". Whether a tab is selectable still keys off the total, so a
 * severity whose alerts have all been read drops to (0) but stays clickable
 * rather than becoming a dead tab hiding rows the list would happily show.
 */
function renderUpdatedNote() {
  const el = document.getElementById('updated-note');
  if (!el) return;
  const n = ALERTS.filter(a => a.updated).length;
  el.textContent = n === 1 ? '1 updated since you read it' : `${n} updated since you read them`;
  el.hidden = n === 0;
}

function renderFilterCounts() {
  const total = { all: ALERTS.length, critical: 0, serious: 0, warning: 0 };
  const unread = { all: 0, critical: 0, serious: 0, warning: 0 };

  ALERTS.forEach(a => {
    const counted = COUNTED_SEVERITIES.has(a.severity);
    if (counted) total[a.severity] += 1;
    if (!isUnseen(a)) return;
    unread.all += 1;
    if (counted) unread[a.severity] += 1;
  });

  renderUpdatedNote();

  document.querySelectorAll('#severity-filter button').forEach(btn => {
    const sev = btn.dataset.sev;
    const label = sev === 'all' ? 'All' : sev.charAt(0).toUpperCase() + sev.slice(1);
    btn.textContent = `${label} (${unread[sev] ?? 0})`;
    // A severity with no alerts at all can still be selected, but saying so
    // beats letting someone click into a blank list.
    btn.disabled = sev !== 'all' && (total[sev] ?? 0) === 0;
    btn.style.opacity = btn.disabled ? '0.45' : '';
  });
}

function renderList() {
  const list = document.getElementById('alert-list');
  const visible = visibleAlerts();

  if (visible.length === 0) {
    const narrowed = currentFilter !== 'all' || currentProvider !== 'all';
    list.innerHTML = `<div class="muted" style="padding:24px;text-align:center">No alerts${narrowed ? ' match these filters' : ' yet'}.</div>`;
    return;
  }

  list.innerHTML = visible.map(a => {
    const sev = SEV[a.severity];
    return `
    <div class="alert-card ${a.id === selectedId ? 'selected' : ''} ${isUnseen(a) ? 'unread' : ''} ${a.updated ? 'updated' : ''}" data-id="${a.id}">
      <span class="stripe" style="background:${sev.color}"></span>
      <div class="inner">
        <div class="top-row">
          <span class="sev-slot">
            <!-- Rendered read or unread, hidden rather than dropped. Removing
                 the dot on click gave the row 13px more space, which let the
                 provider tag un-wrap and changed the card's height — so every
                 card below it jumped the moment you opened one. -->
            <span class="unread-dot" title="Unread"${isUnseen(a) ? '' : ' aria-hidden="true"'}></span>
            <span class="badge ${sev.badge}">${sev.label}</span>
            ${a.updated ? '<span class="badge badge-updated" title="You have read this alert; the figures have changed since">Updated</span>' : ''}
            ${quietFor(a) ? `<span class="badge badge-quiet" title="${esc(quietFor(a).title)}">${esc(quietFor(a).label)}</span>` : ''}
          </span>
          <span class="provider-tag" title="${esc(providerLabel(a))} · ${esc(whereLabel(a))}"><span class="sq" style="background:${PROVIDER_COLOR[providerLabel(a)]}"></span><span class="pt-text">${esc(providerLabel(a))} · ${esc(whereLabel(a))}</span></span>
        </div>
        <div class="card-title">${esc(a.title)}</div>
        <div class="top-row">
          <span class="card-meta">${esc(a.meta)}</span>
          <span class="card-impact ${impactFigure(a).value ? '' : 'neutral'}">${
            impactFigure(a).value ? '+' + fmtMoney(impactFigure(a).value) : 'No cost impact'
          }</span>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.alert-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedId = card.dataset.id;
      renderList();
      renderDetail();
      markRead(selectedId);
    });
  });
}

/**
 * Inbox-style: opening an alert clears it from the unread count, for
 * whoever opens it — read state lives on the alert, not per person. Only
 * fires once per alert per page load; the sidebar badge (last fetched on
 * page load) is decremented locally so it doesn't look stale while this
 * page stays open.
 */
async function markRead(id) {
  const alert = ALERTS.find(a => a.id === id);
  if (!alert || alert.read) return;
  alert.read = true;
  // Opening it clears the "updated" flag too — you have now seen the new
  // figures, which is exactly what the flag was asking for.
  alert.updated = false;
  renderList();
  renderFilterCounts();
  syncAlertBadge();
  try {
    await window.CM_Api.post(`/alerts/${encodeURIComponent(id)}/read`);
  } catch (err) {
    console.error('Failed to mark alert read', err);
  }
}

function miniChart(alert) {
  const vals = alert.spark;
  const W = 460, H = 120, pad = 8;
  const max = Math.max(...vals, alert.baseline) * 1.15 || 1;
  const x = i => pad + (i / (vals.length - 1)) * (W - pad * 2);
  const y = v => H - pad - (v / max) * (H - pad * 2);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const baselineY = y(alert.baseline);
  const color = PROVIDER_COLOR[providerLabel(alert)];
  const peakIdx = vals.indexOf(Math.max(...vals));

  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="120" role="img" aria-label="Baseline versus actual for ${esc(alert.title)}">
    <line x1="${pad}" y1="${baselineY}" x2="${W - pad}" y2="${baselineY}" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="4,3"/>
    <text x="${W - pad}" y="${baselineY - 6}" text-anchor="end" font-size="10.5" fill="var(--text-muted)">baseline ${alert.baseline}${alert.unit}</text>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(peakIdx)}" cy="${y(vals[peakIdx])}" r="4" fill="${color}" stroke="var(--surface-1)" stroke-width="2"/>
    <text x="${x(peakIdx)}" y="${y(vals[peakIdx]) - 10}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text-primary)">${vals[peakIdx]}${alert.unit}</text>
  </svg>`;
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  const alert = ALERTS.find(a => a.id === selectedId);
  if (!alert) {
    panel.innerHTML = `<div class="muted" style="padding:24px;text-align:center">Select an alert to see details.</div>`;
    return;
  }

  const sev = SEV[alert.severity];
  const delta = alert.baseline > 0 ? Math.round(((alert.current - alert.baseline) / alert.baseline) * 100) : null;

  panel.innerHTML = `
    <div class="detail-head">
      <div>
        <span class="badge ${sev.badge}">${sev.label}</span>
        <div class="detail-title">${esc(alert.title)}</div>
        <div class="detail-meta-row">
          <span><span class="sq" style="background:${PROVIDER_COLOR[providerLabel(alert)]};display:inline-block"></span>${esc(providerLabel(alert))}</span>
          <span>·</span>
          <a href="account-detail.html?id=${encodeURIComponent(alert.accountId)}" class="link-btn" style="font-size:12.5px">${esc(alert.accountName)}</a>
          ${alert.project && alert.project.label ? `<span>·</span><span title="${esc(Math.round(alert.project.share * 100))}% of this service's spend that day">${esc(alert.project.label)}</span>` : ''}
          <span>·</span>
          <span>${esc(alert.meta)}</span>
        </div>
      </div>
    </div>

    <div class="impact-strip">
      <div class="impact-cell">
        <div class="l">${impactFigure(alert).label}</div>
        <div class="v">${fmtMoney(impactFigure(alert).value || 0)}</div>
        ${impactFigure(alert).note ? `<div class="impact-note">${impactFigure(alert).note}</div>` : ''}
      </div>
      ${alert.actuals && alert.actuals.accrued
        ? `<div class="impact-cell"><div class="l">Actually spent since</div><div class="v">${fmtMoney(alert.actuals.accrued)}</div></div>`
        : ''}
      <div class="impact-cell"><div class="l">Baseline</div><div class="v">${fmtMoney(alert.baseline)}${alert.unit}</div></div>
      <div class="impact-cell"><div class="l">Current</div><div class="v">${fmtMoney(alert.current)}${alert.unit}${delta !== null ? ` <span class="delta ${delta > 0 ? 'up-bad' : 'flat'}" style="font-size:11px">${delta > 0 ? '▲' : ''}${delta}%</span>` : ''}</div></div>
    </div>

    <div class="detail-section">
      <h3>Metric vs baseline</h3>
      ${miniChart(alert)}
    </div>

    <div class="detail-section">
      <h3>Likely root cause</h3>
      <p>${esc(alert.rootCause)}</p>
    </div>

    <div class="detail-section">
      <h3>Suggested action</h3>
      <p class="muted">${esc(alert.action)}</p>
    </div>

    <div class="detail-section">
      <h3>Notified via</h3>
      <div class="chip-row">
        ${['whatsapp', 'email'].map(c => `<span class="chip ${alert.channels.includes(c) ? 'on' : ''}">${channelIcon(c)} ${CHANNEL_LABEL[c]}</span>`).join('')}
      </div>
      <p class="muted" style="margin-top:8px; font-size:12px;">${esc(alert.recipients)}</p>
    </div>

  `;
}

/** Re-renders after either filter moves, keeping a visible alert selected. */
function afterFilterChange() {
  const visible = visibleAlerts();
  if (!visible.find(a => a.id === selectedId) && visible.length) {
    selectedId = visible[0].id;
    markRead(selectedId);
  }
  renderList();
  renderDetail();
}

function applyFilter(sev) {
  currentFilter = sev;
  afterFilterChange();
}

function applyProviderFilter(provider) {
  currentProvider = provider;
  afterFilterChange();
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Alert impact figures go through CM_money, which reads the display
    // currency off /me — so wait for it rather than racing it.
    await window.CM_MeReady;
    // Accounts are fetched only to name the providers in the filter. If that
    // call fails the page still works — the menu just falls back to whatever
    // providers the alerts themselves carry. Alerts failing is the real error.
    const [{ alerts }, connected] = await Promise.all([
      window.CM_Api.get('/alerts'),
      window.CM_Api.get('/accounts')
        .then(res => ((res && res.accounts) || []).map(a => a.provider))
        .catch(() => []),
    ]);
    ALERTS = alerts;
    // The top alert is *shown*, not opened. Marking it read here counted as
    // reading something nobody clicked: the badge dropped by one during the
    // navigation, so the count on the page you arrived from never matched the
    // count you landed on. Reading is what the click handler is for.
    selectedId = ALERTS[0]?.id ?? null;
    syncAlertBadge();
    renderFilterCounts();
    renderProviderOptions(connected);
    renderList();
    renderDetail();
  } catch (err) {
    window.CM_renderLoadError(err, 'alert-list', 'detail-panel');
    return;
  }

  document.querySelectorAll('#severity-filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#severity-filter button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilter(btn.dataset.sev);
    });
  });

  const providerSelect = document.getElementById('provider-filter');
  if (providerSelect) {
    providerSelect.addEventListener('change', () => applyProviderFilter(providerSelect.value));
  }
});
