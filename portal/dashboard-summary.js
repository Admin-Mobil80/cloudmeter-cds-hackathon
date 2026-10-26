// CloudMeter — dashboard stat tiles, recent anomalies, cost-by-service, and
// spend-by-provider, all backed by the real GET /dashboard/summary + GET
// /alerts endpoints. (The "Hourly cost trend" chart in app.js stays
// illustrative for now — real time-series ingestion is a later phase.)

// adhoc belongs here as much as any polled provider: it reaches the dashboard
// through the same byProvider roll-up, and without an entry the "Spend by
// provider" card printed the raw key with an uncoloured dot beside it.
const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure', gcp: 'GCP', alibaba: 'Alibaba Cloud', huawei: 'Huawei Cloud', openai: 'OpenAI', whatsapp: 'WhatsApp Business', adhoc: 'Adhoc Spend' };
const PROVIDER_VAR = {
  aws: 'var(--provider-aws)', azure: 'var(--provider-azure)', gcp: 'var(--provider-gcp)',
  alibaba: 'var(--provider-alibaba)', huawei: 'var(--provider-huawei)',
  openai: 'var(--provider-openai)', whatsapp: 'var(--provider-whatsapp)',
  adhoc: 'var(--provider-adhoc)',
};
const SEV_COLOR = { critical: 'var(--status-critical)', serious: 'var(--status-serious)', warning: 'var(--status-warning)', good: 'var(--status-good)' };

/**
 * Rounding to whole dollars turned real sub-dollar costs into "$0", which read
 * as a bug — a row saying "$0, up 3024%" describes nothing. Small amounts keep
 * their cents; large ones stay round, because cents on $2,130 are noise.
 */
/**
 * HTML-escape untrusted text before it goes into innerHTML.
 *
 * Local to this file, matching the convention already used in accounts.js,
 * team.js, alerts.js and pricing.js: these pages load different script sets,
 * so a shared helper would mean loading an extra file everywhere.
 *
 * Account and service names are attacker-controlled — a customer names their
 * own cloud accounts, and service/tag names come from provider APIs — so they
 * are data, never markup.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
  const v = Number(n) || 0;
  // Thresholds are judged on the *converted* amount, not the stored USD one.
  // 0.005 USD is under a cent, but the same figure is ₹0.48 — deciding in USD
  // printed "<$0.01" in the middle of a list of rupee amounts, which is both
  // the wrong symbol and the wrong answer.
  const shown = CM_amount(v);
  const symbol = CM_currencySymbol();
  if (v === 0) return `${symbol}0`;
  if (Math.abs(shown) < 0.01) return `<${symbol}0.01`;
  if (Math.abs(shown) < 10) return CM_money(v, { decimals: 2 });
  return CM_money(v, { decimals: 0 });
}

/**
 * Below this, a percentage change is arithmetic rather than information:
 * Polly moving from a tenth of a cent to five cents is "up 3024%", which is
 * true and useless, and shown in alarm red it pulls the eye away from the
 * services that actually cost something.
 */
const TREND_MATERIALITY = 1;

function pctLabel(pct) {
  if (pct >= 0.1 || pct === 0) return `${pct.toFixed(0)}% of month-to-date spend`;
  return 'under 0.1% of month-to-date spend';
}

/**
 * Splits the month-to-date figure into metered cloud spend and hand-entered
 * subscriptions.
 *
 * They are different kinds of money: one is usage that moves on its own and is
 * worth watching for anomalies, the other is a fixed set of seats somebody
 * decided to buy. Rolled into one number the second quietly inflates the
 * first, and a jump in the total gives no clue which half moved.
 *
 * Derived from byProvider, which the dashboard already loads — no extra call.
 */
function renderSpendSplit(byProvider) {
  const row = document.getElementById('stat-mtd-split-row');
  const el = document.getElementById('stat-mtd-split');
  if (!row || !el) return;

  const rows = byProvider || [];
  const hasAdhoc = rows.some((p) => p.provider === 'adhoc');
  row.hidden = !hasAdhoc;
  if (!hasAdhoc) return;

  const sum = (keep) => rows.filter(keep).reduce((t, p) => t + (p.spend || 0), 0);
  const adhoc = sum((p) => p.provider === 'adhoc');
  const cloud = sum((p) => p.provider !== 'adhoc');
  el.textContent = `Cloud ${fmt(cloud)} · Adhoc ${fmt(adhoc)}`;
}

/**
 * "4 anomalies" says nothing about whether to care. This breaks that count
 * into what the four actually are, each in its own severity colour.
 *
 * Severities with no alerts are left out rather than shown as zero: a row of
 * zeroes is noise, and "0 critical" reads as reassurance the reader has to
 * stop and parse. Anything the server reports that isn't one of the three
 * known levels is still counted, under its own name — silently dropping an
 * unrecognised severity would make the parts stop adding up to the total.
 */
const SEVERITY_ORDER = ['critical', 'serious', 'warning'];

function anomalyBreakdown(stats) {
  const counts = stats.severityCounts || {};
  if (!stats.activeAnomalies) return 'None active';

  const known = SEVERITY_ORDER.filter((s) => counts[s] > 0);
  const extra = Object.keys(counts).filter((s) => !SEVERITY_ORDER.includes(s) && counts[s] > 0).sort();

  const parts = [...known, ...extra].map((s) => {
    const colour = SEV_COLOR[s] || 'var(--text-secondary)';
    return `<span style="color:${colour}">${counts[s]} ${esc(s)}</span>`;
  });

  // Falls back to the plain total when the server sends no breakdown — an
  // older deploy, or an alert stored without a severity.
  return parts.length ? parts.join(' · ') : `${stats.activeAnomalies} active`;
}

function renderStatTiles(stats) {
  document.getElementById('stat-mtd-spend').textContent = fmt(stats.mtdSpend);
  // Names the window rather than saying "vs last month". The comparison is the
  // same number of elapsed days on both sides — not this part-month against
  // all of the last one — and the label has to say so, or the reader carries
  // on reading it as a whole-month figure.
  const days = stats.comparisonDays;
  const period = days ? `vs same ${days === 1 ? 'day' : `${days} days`} last month` : 'vs last month';
  document.getElementById('stat-mtd-spend-sub').textContent = stats.mtdSpendDeltaPct === null
    ? 'No prior period to compare'
    : `${stats.mtdSpendDeltaPct >= 0 ? '▲' : '▼'} ${Math.abs(stats.mtdSpendDeltaPct).toFixed(1)}% ${period}`;
  document.getElementById('stat-mtd-spend-sub').className = `delta ${stats.mtdSpendDeltaPct > 0 ? 'up-bad' : stats.mtdSpendDeltaPct < 0 ? 'up-good' : 'flat'}`;

  document.getElementById('stat-projected').textContent = fmt(stats.projectedMonthEnd);
  /*
   * Says how many days the projection is actually built from.
   *
   * It read "day 6 of 31" while the figure beside it came from five days —
   * the caption contradicting its own number, because providers report a day
   * late and today has usually not arrived. Naming the reported days instead
   * makes the gap visible rather than hiding it behind the calendar.
   *
   * Falls back to the calendar day on a response from before coveredDays
   * existed, so an older deploy or a cached page reads as it did.
   */
  const covered = typeof stats.coveredDays === 'number' ? stats.coveredDays : stats.dayOfMonth;
  document.getElementById('stat-projected-sub').textContent =
    `on pace, ${covered} of ${stats.daysInMonth} days reported`;

  document.getElementById('stat-anomalies').textContent = stats.activeAnomalies;
  document.getElementById('stat-anomalies-sub').innerHTML = anomalyBreakdown(stats);
  document.getElementById('stat-anomalies-sub').className = `delta ${stats.criticalCount > 0 ? 'up-bad' : 'flat'}`;

  /*
   * What the critical ones are estimated to cost — the money, and only the
   * money.
   *
   * This line named the count as well, from when the line above it read "73
   * active" and this was the only place the critical figure appeared. Once
   * the breakdown started naming every severity the tile said "13 critical"
   * twice, one line under the other, and read as a stutter.
   *
   * Still shown only where something is actually critical: with none there is
   * no impact to estimate, and the line would read "$0 est. impact".
   */
  const impactRow = document.getElementById('stat-anomalies-impact-row');
  const impact = document.getElementById('stat-anomalies-impact');
  if (impactRow && impact) {
    impactRow.hidden = !(stats.criticalCount > 0);
    impact.textContent = `${fmt(stats.criticalImpact)} est. impact from critical`;
    impact.style.color = 'var(--status-critical)';
  }

  document.getElementById('stat-accounts').textContent = stats.connectedAccounts;
  document.getElementById('stat-accounts-sub').textContent = `across ${stats.providerCount} provider${stats.providerCount === 1 ? '' : 's'}`;
}

function renderRecentAnomalies(alerts) {
  const container = document.getElementById('recent-anomalies-list');
  if (!alerts.length) {
    container.innerHTML = `<div class="muted" style="padding:12px 0">No anomalies detected.</div>`;
    return;
  }
  // The headline figure is what was actually spent, not what it might add up
  // to. `impact` is a projection — the day's excess multiplied by the days
  // left in the month — and showing it alone, unlabelled and next to a title
  // like "New spend", read as money already gone. A one-off charge such as a
  // domain registration made that badly wrong: $46 spent once was advertised
  // as $414 because the model assumed it recurred daily.
  //
  // So the observed amount leads, and the projection follows it labelled as
  // one, matching what the alert detail panel already calls "Est. impact".
  container.innerHTML = alerts.map(a => {
    const observed = typeof a.current === 'number' ? a.current : a.impact;
    const projected = a.impact && a.impact !== observed
      ? `<span class="amt-note">+${fmt(a.impact)} projected</span>`
      : '';
    return `
    <div class="alert-mini">
      <span class="stripe" style="background:${SEV_COLOR[a.severity]}"></span>
      <div class="body">
        <div class="title">${esc(a.title)}</div>
        <div class="meta">${esc(PROVIDER_LABEL[a.provider] || a.provider)} · ${esc(a.meta)}</div>
      </div>
      <span class="amt">${a.impact === 0 && !observed
        ? 'No impact'
        : `+${fmt(observed)}${a.unit ? `<span class="amt-unit">${a.unit}</span>` : ''}`}${projected}</span>
    </div>`;
  }).join('');
}

// Every service, kept so "view all" and the drill-down need no second request.
let ALL_SERVICES = [];
const SERVICES_COLLAPSED = 6;

function trendCell(trend, spend) {
  if (spend !== undefined && spend < TREND_MATERIALITY) {
    return `<span class="delta flat" title="Too small for a percentage to mean anything">—</span>`;
  }
  if (trend === null || trend === undefined) {
    return `<span class="delta flat">New</span>`;
  }
  const cls = trend > 0 ? 'up-bad' : trend < 0 ? 'up-good' : 'flat';
  const arrow = trend > 0 ? '▲' : trend < 0 ? '▼' : '▬';
  // Rounded here rather than server-side: the API now returns the real
  // percentage, and a raw 8.212765957446808 in a table cell helps nobody.
  return `<span class="delta ${cls}">${arrow} ${Math.abs(trend).toFixed(1)}%</span>`;
}

function serviceRow(s) {
  return `
    <tr class="svc-row" data-service="${encodeURIComponent(s.name)}" tabindex="0" role="button"
        aria-label="Show which accounts ${esc(s.name)} costs fall in">
      <td><div class="svc-cell">
        <span class="svc-ic" style="background:${PROVIDER_VAR[s.provider]}">${esc(s.name.slice(0, 2).toUpperCase())}</span>
        <div><div class="svc-name">${esc(s.name)}</div>
        <div class="svc-sub">${pctLabel(s.pct)}</div></div>
      </div></td>
      <td class="num">${fmt(s.spend)}</td>
      <td class="num">${trendCell(s.trend, s.spend)}</td>
      <td class="num">${s.accountCount}<span class="row-chevron">›</span></td>
    </tr>`;
}

function renderTopServices(services, all) {
  const body = document.getElementById('top-services-body');
  ALL_SERVICES = all ?? services;

  if (!ALL_SERVICES.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Connect a cloud account to see cost by service.</td></tr>`;
    return;
  }

  renderServiceRows(false);
}

function renderServiceRows(expanded) {
  const body = document.getElementById('top-services-body');
  const shown = expanded ? ALL_SERVICES : ALL_SERVICES.slice(0, SERVICES_COLLAPSED);
  const hiddenCount = ALL_SERVICES.length - shown.length;

  body.innerHTML = shown.map(serviceRow).join('')
    + (hiddenCount > 0 ? `
      <tr><td colspan="4" style="text-align:center;padding:11px">
        <button class="show-more-btn" id="show-all-services">View all ${ALL_SERVICES.length} services ↓</button>
      </td></tr>` : '');

  document.getElementById('show-all-services')?.addEventListener('click', () => renderServiceRows(true));
  body.querySelectorAll('.svc-row').forEach(row => {
    const open = () => openServiceModal(decodeURIComponent(row.dataset.service));
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

/**
 * Shows what a total is made of.
 *
 * Shared by the service and region cards: both answer "this number is big —
 * where does it come from?", and two implementations of the same panel would
 * drift apart the moment either changed.
 */
function openBreakdownModal({ title, subtitle, colour, rows, total }) {
  document.getElementById('svc-modal-dot').style.background = colour ?? 'var(--brand)';
  document.getElementById('svc-modal-title').textContent = title;
  document.getElementById('svc-modal-sub').textContent = subtitle;

  document.getElementById('svc-modal-list').innerHTML = rows.map((r) => {
    const share = total > 0 ? (r.spend / total) * 100 : 0;
    const bar = `<div class="provider-bar-track"><div class="provider-bar-fill" style="width:${share}%;background:${colour}"></div></div>`;
    const amount = `<div class="provider-amt">${fmt(r.spend)}<span class="pct">${share.toFixed(0)}%</span>${r.accountId ? '<span class="row-chevron">›</span>' : ''}</div>`;
    const body = `<span class="provider-dot" style="background:${colour}"></span>
        <div><div class="provider-name">${esc(r.label)}</div>${r.meta ? `<div class="provider-meta">${esc(r.meta)}</div>` : ''}</div>
        ${amount}${bar}`;
    // Only account rows lead somewhere; a location has no page of its own.
    return r.accountId
      ? `<a class="provider-row clickable" href="account-detail.html?id=${encodeURIComponent(r.accountId)}">${body}</a>`
      : `<div class="provider-row">${body}</div>`;
  }).join('');

  document.getElementById('svc-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

// A service's cost is usually spread across many accounts; this says which,
// which is the question the aggregate immediately provokes.
function openServiceModal(name) {
  const s = ALL_SERVICES.find(x => x.name === name);
  if (!s) return;
  openBreakdownModal({
    title: s.name,
    subtitle: `${fmt(s.spend)} month to date · `
      + `${s.pct >= 0.1 ? s.pct.toFixed(0) + '%' : 'under 0.1%'} of all spend · `
      + `${s.accountCount} account${s.accountCount === 1 ? '' : 's'}`,
    colour: PROVIDER_VAR[s.provider] ?? 'var(--brand)',
    rows: s.accounts.map(a => ({ label: a.accountName, spend: a.spend, accountId: a.accountId })),
    total: s.spend,
  });
}

function closeServiceModal() {
  document.getElementById('svc-overlay')?.classList.remove('show');
  document.body.style.overflow = '';
}

// Hidden entirely until something has actually synced — an "updated N ago"
// badge with no data behind it is worse than no badge.
function renderFreshness(lastSyncAt) {
  const wrap = document.getElementById('freshness-indicator');
  const text = document.getElementById('freshness-text');
  if (!wrap || !text) return;

  if (!lastSyncAt) {
    wrap.style.display = 'none';
    return;
  }

  const mins = Math.max(0, Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 60000));
  let label;
  if (mins < 1) label = 'Updated just now';
  else if (mins < 60) label = `Updated ${mins} min ago`;
  else {
    const hours = Math.round(mins / 60);
    label = hours < 24 ? `Updated ${hours} hr ago` : `Updated ${Math.round(hours / 24)} d ago`;
  }
  text.textContent = label;
  wrap.style.display = '';
}

/**
 * The subtitle describes what is actually on screen, rather than the product
 * in general.
 *
 * It used to be fixed text reading "across 5 providers — normalized to USD",
 * which was wrong twice over for most tenants: it named however many providers
 * CloudMeter supports rather than the number this account has connected, and
 * it claimed USD on a tenant reading its spend in rupees. USD is how the
 * ledger is stored, which is an implementation detail — the reader cares which
 * currency the figures in front of them are in.
 */
function renderSubtitle(byProvider) {
  const el = document.getElementById('dashboard-sub');
  if (!el) return;

  const count = (byProvider || []).length;
  const code = (window.CM_ME && window.CM_ME.currency && window.CM_ME.currency.code) || 'USD';

  if (!count) {
    el.textContent = 'Unified ledger — connect an account to get started';
    return;
  }
  el.textContent = `Unified ledger across ${count} provider${count === 1 ? '' : 's'} — shown in ${code}`;
}

function renderByProvider(byProvider) {
  const container = document.getElementById('spend-by-provider-list');
  if (!byProvider.length) {
    container.innerHTML = `<div class="muted" style="padding:12px 0">No accounts connected yet.</div>`;
    return;
  }
  container.innerHTML = byProvider.map(p => `
    <a class="provider-row" href="accounts.html#${p.provider}">
      <span class="provider-dot" style="background:${PROVIDER_VAR[p.provider]}"></span>
      <div><div class="provider-name">${PROVIDER_LABEL[p.provider] || p.provider}</div><div class="provider-meta">${p.accountCount} account${p.accountCount === 1 ? '' : 's'} →</div></div>
      <div class="provider-amt">${fmt(p.spend)}<span class="pct">${p.pct.toFixed(0)}%</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${p.pct}%;background:${PROVIDER_VAR[p.provider]}"></div></div>
    </a>`).join('');
}

// Monthly trend arrives with the summary; daily is a separate call so the
// dashboard isn't paying for 90 days of rows on every load.
let monthlyTrend = null;

function renderDailyStats(daily) {
  const wrap = document.getElementById('trend-daily-stats');
  if (!wrap) return;
  wrap.style.display = '';

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  set('trend-yesterday', daily.latestComplete !== null ? fmt(daily.latestComplete) : '—');
  set('trend-daily-avg', daily.completeDays ? fmt(daily.average) : '—');
  set('trend-today', daily.partialToday !== null ? `${fmt(daily.partialToday)}*` : '—');

  const deltaEl = document.getElementById('trend-yesterday-delta');
  if (deltaEl) {
    const d = daily.latestCompleteDeltaPct;
    if (d === null || d === undefined) {
      deltaEl.textContent = 'Not enough history';
      deltaEl.className = 'delta flat';
    } else {
      deltaEl.textContent = `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`;
      deltaEl.className = `delta ${d > 0 ? 'up-bad' : d < 0 ? 'up-good' : 'flat'}`;
    }
  }
}

// Bumped on every switch. A slow 30D response landing after the user has moved
// on to 90D must not paint over the newer view, so each render checks that its
// request is still the current one.
let trendRequestId = 0;

// Tenant-wide spend per data-centre location. Rows stay per provider rather
// than merged on the region code: AWS's ap-south-1 and Alibaba's ap-south-1
// are different companies' data centres, so adding them would be nonsense.
let ALL_REGIONS = [];

function renderRegionCard(res) {
  ALL_REGIONS = res.regions ?? [];
  const list = document.getElementById('region-list');
  const sub = document.getElementById('region-sub');
  if (!list) return;
  list.removeAttribute('aria-busy');

  if (!res.available || !res.regions.length) {
    list.innerHTML = `<div class="muted" style="padding:20px 0;text-align:center">
        No location breakdown yet — it appears once your providers report
        region-level cost.
      </div>`;
    return;
  }

  const { rows, rolled } = rollUpRegions(res.regions);
  if (sub) {
    sub.textContent = `${res.regions.length} location${res.regions.length === 1 ? '' : 's'} `
      + `across ${fmt(res.total)} of month-to-date spend`;
  }

  list.innerHTML = rows.map((r, i) => {
    const unplaced = r.name === 'NoRegion' || r.name === 'global';
    const color = unplaced ? 'var(--text-muted)' : PROVIDER_VAR[r.providers[0]] ?? 'var(--brand)';
    const provider = PROVIDER_LABEL[r.providers[0]] ?? r.providers[0];
    const meta = unplaced
      ? `${provider} · support, tax and other charges with no location`
      : `${provider} · ${r.accountCount} account${r.accountCount === 1 ? '' : 's'}`;
    return `
    <div class="provider-row clickable" data-region="${encodeURIComponent(r.name)}" data-provider="${r.providers[0]}"
         tabindex="0" role="button" aria-label="Show which accounts run in ${r.displayName}">
      <span class="provider-dot" style="background:${color}"></span>
      <div>
        <div class="provider-name">${r.displayName}</div>
        <div class="provider-meta">${meta}</div>
      </div>
      <div class="provider-amt">${fmt(r.spend)}<span class="pct">${r.pct.toFixed(0)}%</span><span class="row-chevron">›</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${r.pct}%;background:${color}"></div></div>
    </div>`;
  }).join('') + (rolled ? rolledRegionRow(rolled, res.total) : '');

  list.querySelectorAll('[data-region]').forEach(row => {
    const open = () => openRegionModal(decodeURIComponent(row.dataset.region), row.dataset.provider);
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
  list.querySelector('[data-rolled-regions]')?.addEventListener('click', openRolledRegionsModal);
}

// Which accounts actually run in a location — the same question the service
// card's drill-down answers, so it uses the same panel.
function openRegionModal(name, provider) {
  const r = ALL_REGIONS.find(x => x.name === name && x.providers[0] === provider);
  if (!r) return;
  const unplaced = r.name === 'NoRegion' || r.name === 'global';
  openBreakdownModal({
    title: r.displayName,
    subtitle: `${fmt(r.spend)} month to date · ${r.pct.toFixed(0)}% of all spend · `
      + `${r.accountCount} account${r.accountCount === 1 ? '' : 's'}`,
    colour: unplaced ? 'var(--text-muted)' : (PROVIDER_VAR[r.providers[0]] ?? 'var(--brand)'),
    rows: r.accounts.map(a => ({ label: a.accountName, spend: a.spend, accountId: a.accountId })),
    total: r.spend,
  });
}

// The rolled-up row is a total too, so it opens into the locations it hides
// rather than being a dead end.
function openRolledRegionsModal() {
  const rest = ALL_REGIONS.slice(8);
  if (!rest.length) return;
  const total = rest.reduce((sum, r) => sum + r.spend, 0);
  openBreakdownModal({
    title: `${rest.length} other locations`,
    subtitle: `${fmt(total)} month to date, combined`,
    colour: 'var(--gridline)',
    rows: rest.map(r => ({
      label: r.displayName,
      meta: `${r.accountCount} account${r.accountCount === 1 ? '' : 's'}`,
      spend: r.spend,
    })),
    total,
  });
}

// A provider can report a couple of dozen locations, most carrying fractions of
// a cent from an idle resource. Listing them all buries the ones that matter,
// but dropping them hides real money — so everything below the cut collapses
// into one honest "other locations" row.
function rollUpRegions(regions, maxRows = 8) {
  if (regions.length <= maxRows) return { rows: regions, rolled: null };
  const rest = regions.slice(maxRows);
  return {
    rows: regions.slice(0, maxRows),
    rolled: { count: rest.length, spend: rest.reduce((sum, r) => sum + r.spend, 0) },
  };
}

function rolledRegionRow(rolled, total) {
  const pct = total > 0 ? (rolled.spend / total) * 100 : 0;
  return `
    <div class="provider-row clickable" data-rolled-regions tabindex="0" role="button"
         aria-label="Show the remaining locations">
      <span class="provider-dot" style="background:var(--gridline)"></span>
      <div>
        <div class="provider-name">${rolled.count} other locations</div>
        <div class="provider-meta">Combined — everything below the top 8 by spend</div>
      </div>
      <div class="provider-amt">${fmt(rolled.spend)}<span class="pct">${pct.toFixed(0)}%</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:var(--gridline)"></div></div>
    </div>`;
}

async function loadAndRenderRegions() {
  try {
    renderRegionCard(await window.CM_Api.get('/dashboard/regions'));
  } catch (err) {
    console.error('Failed to load region breakdown', err);
    window.CM_renderLoadError(err, 'region-list');
  }
}

async function showGranularity(btn) {
  const sub = document.getElementById('trend-sub');
  const dailyStats = document.getElementById('trend-daily-stats');
  const requestId = ++trendRequestId;
  const isCurrent = () => requestId === trendRequestId;

  if (btn.dataset.gran === 'monthly') {
    if (dailyStats) dailyStats.style.display = 'none';
    if (sub) sub.textContent = 'Monthly spend across your connected accounts';
    renderTrendChart(monthlyTrend);
    return;
  }

  const days = btn.dataset.days ?? '30';
  if (sub) sub.textContent = `Daily spend across your connected accounts — last ${days} days`;
  // Hidden while loading: leaving the previous window's numbers on screen next
  // to a spinner reads as if they belong to the range being loaded.
  if (dailyStats) dailyStats.style.display = 'none';
  renderTrendLoading(`Loading the last ${days} days…`);

  const fetchDaily = () => window.CM_Api.get(`/dashboard/daily?days=${encodeURIComponent(days)}`);

  try {
    let daily = await fetchDaily();
    if (!isCurrent()) return;

    // Accounts connected before daily ingestion existed have no daily rows.
    // Refreshing them backfills it — the refresh endpoint fetches missing daily
    // data even while the monthly pull is still inside its throttle window —
    // so try that once rather than showing an empty chart to someone who does
    // have connected accounts.
    if (!daily.available) {
      renderTrendLoading('Fetching daily cost data from your providers…');
      const backfilled = await backfillDailyData();
      if (!isCurrent()) return;
      if (backfilled) daily = await fetchDaily();
      if (!isCurrent()) return;
    }

    if (!daily.available) {
      renderTrendChart(null, 'No daily cost data reported for your accounts yet.');
      return;
    }
    renderTrendChart(daily);
    renderDailyStats(daily);
  } catch (err) {
    if (!isCurrent()) return;
    console.error('Failed to load daily trend', err);
    renderTrendChart(null, "Couldn't load the daily cost trend. Try reloading the page.");
  }
}

// Refreshes every live account so any missing daily data gets fetched. Runs at
// most once per page load: the flag stops the three granularity buttons from
// each kicking off their own round of provider calls.
let dailyBackfillTried = false;
async function backfillDailyData() {
  if (dailyBackfillTried) return false;
  dailyBackfillTried = true;
  try {
    const accounts = await loadAllAccounts();
    const live = accounts.filter(a => a.dataSource === 'live');
    if (!live.length) return false;
    await Promise.all(live.map(a => refreshAccount(a.id).catch(err => {
      console.warn(`Refresh failed for ${a.name}`, err);
    })));
    return true;
  } catch (err) {
    console.error('Daily backfill failed', err);
    return false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('stat-mtd-spend')) return;

  let summary;
  try {
    // The display currency rides on /me, and every figure below is formatted
    // through CM_money. Fetching both at once and rendering on whichever
    // returns first is what made this page fall back to dollars for a tenant
    // set to local currency.
    const [s] = await Promise.all([
      window.CM_Api.get('/dashboard/summary'),
      window.CM_MeReady,
    ]);
    summary = s;
  } catch (err) {
    window.CM_renderLoadError(err, 'trend-chart', 'recent-anomalies-list',
      'top-services-body', 'spend-by-provider-list');
    return;
  }
  monthlyTrend = summary.trend;
  renderSubtitle(summary.byProvider);
  renderStatTiles(summary.statTiles);
  renderSpendSplit(summary.byProvider);
  renderRecentAnomalies(summary.recentAlerts);
  renderTopServices(summary.topServices, summary.services);
  renderByProvider(summary.byProvider);
  renderFreshness(summary.lastSyncAt);
  // Deliberately not awaited alongside the summary: it fans out a read per
  // account, and the tiles shouldn't wait on it.
  loadAndRenderRegions();

  const svcOverlay = document.getElementById('svc-overlay');
  document.getElementById('svc-modal-close')?.addEventListener('click', closeServiceModal);
  svcOverlay?.addEventListener('click', e => { if (e.target === svcOverlay) closeServiceModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && svcOverlay?.classList.contains('show')) closeServiceModal();
  });

  const toggle = document.getElementById('trend-granularity');
  if (toggle) {
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showGranularity(btn);
      });
    });
    // Daily 30D is the default view — it's the granularity that surfaces a
    // cost spike while there's still time to act on it.
    await showGranularity(toggle.querySelector('button.active'));
  } else {
    renderTrendChart(monthlyTrend);
  }
});
