// CloudMeter — Cloud Account drill-down: cost by service, cost by tag.
// Data comes from the real Cost API; this file is rendering logic only.

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#008300'];

/**
 * Providers that report no region, so the "Cost by region" card is left off.
 *
 * Not every provider without regions — Azure and Huawei report none either,
 * and still show the card's empty state. Narrowed to the three asked for
 * rather than widened on my own; the others are a separate decision.
 */
const REGIONLESS_PROVIDERS = new Set(['openai', 'whatsapp', 'gcp']);

/**
 * What one row of the cost breakdown is called, for the provider being shown.
 *
 * "Service" is CloudMeter's own word — it holds EC2 for AWS and Blob Storage
 * for Azure — but an OpenAI reader has never seen it. There the rows are
 * models, so the page says so.
 *
 * (OpenAI's own term for the exact row is "line item": a model paired with
 * the side of the exchange billed, as in "gpt-4o, input". "Model" is the
 * plainer word and the one asked for; the distinction only matters when
 * counting, which is why nothing here counts.)
 */
function unitWord(provider) {
  return provider === 'openai'
    ? { one: 'model', many: 'models', One: 'Model', Many: 'Models' }
    : { one: 'service', many: 'services', One: 'Service', Many: 'Services' };
}

/**
 * The model behind an OpenAI line item.
 *
 * A line item is a model plus how it was billed, and one model produces
 * several: "gpt-5.6-sol" arrives as input, output, cached input and cache
 * writes. Counting rows therefore counts billing dimensions, not models,
 * and calling that "4 models" overstates the estimate by four times.
 *
 * Three shapes in the real data:
 *   gpt-5.6-sol, input                    -> gpt-5.6-sol
 *   gpt-realtime-2.1 audio, output        -> gpt-realtime-2.1
 *   whisper                               -> whisper
 *
 * Everything before the first comma, then a trailing modality word removed.
 * Only those three words, so "dall-e 3, hd, 1024x1792, 1792x1024" keeps its
 * "3" and stays one model, and "web search tool calls" — a billable thing
 * that is not a model at all — is left whole rather than mangled.
 */
const MODALITY_WORDS = new Set(['audio', 'text', 'image']);

function modelOf(lineItem) {
  const head = String(lineItem || '').split(',')[0].trim();
  const parts = head.split(' ');
  if (parts.length > 1 && MODALITY_WORDS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ') || head;
}

/** "1 model · 3 line items" — what the rows beneath actually are. */
function modelCountLabel(models) {
  const items = models.length;
  const distinct = new Set(models.map((m) => modelOf(m.name))).size;
  return `${distinct} model${distinct === 1 ? '' : 's'} · ${items} line item${items === 1 ? '' : 's'}`;
}

/** Retitles everything that says "service" on an OpenAI account page. */
function applyUnitWording(provider) {
  const w = unitWord(provider);
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('stat-top-service-label', `Top ${w.one}`);
  set('compare-card-title', `What changed, by ${w.one}`);
  set('compare-col-service', w.One);
  return w;
}

function fmt(n) { return CM_money(n, { decimals: 0 }); }

let currentAccount = null;
let currentTagDim = null; // resolved from whatever tag keys the account has
// True when this account's spend is attributed by project rather than by tag
// (OpenAI). Set by applyTagCardWording; read by both tag-card renderers.
let currentProjectAttributed = false;
let currentServiceRows = [];
// How many complete days the per-service comparison covers, from /cost/services.
let currentComparisonDays = null;

function renderMonthlyStats(months) {
  const current = months[5].spend, prevMonth = months[4].spend, sixAgo = months[0].spend;
  const momPct = prevMonth > 0 ? ((current - prevMonth) / prevMonth) * 100 : 0;
  const sixMoPct = sixAgo > 0 ? ((current - sixAgo) / sixAgo) * 100 : 0;
  const avg = months.reduce((s, m) => s + m.spend, 0) / months.length;

  const momEl = document.getElementById('mom-delta');
  momEl.textContent = `${momPct >= 0 ? '▲' : '▼'} ${Math.abs(momPct).toFixed(1)}%`;
  momEl.className = `delta ${momPct >= 0 ? 'up-bad' : 'up-good'}`;

  const sixEl = document.getElementById('six-mo-delta');
  sixEl.textContent = `${sixMoPct >= 0 ? '▲' : '▼'} ${Math.abs(sixMoPct).toFixed(1)}%`;
  sixEl.className = `delta ${sixMoPct >= 0 ? 'up-bad' : 'up-good'}`;

  document.getElementById('six-mo-avg').textContent = fmt(avg);
}

function renderMonthlyChart(months, containerId) {
  const W = 640, H = 230, padL = 54, padR = 14, padT = 26, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...months.map(m => m.spend)) * 1.2;
  const slot = plotW / months.length;
  const barW = Math.min(46, slot * 0.5);

  let gridlines = '', axisLabels = '', bars = '', labels = '', hitAreas = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxV / ticks) * t;
    const y = padT + plotH - (v / maxV) * plotH;
    gridlines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e1e0d9" stroke-width="1"/>`;
    axisLabels += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="#898781">${CM_money(v, { decimals: 0 })}</text>`;
  }

  months.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    // A month with no data is not a month with no spend. The project×model
    // history only reaches back to the day the split was first stored, so
    // earlier months are drawn as a marker, not a bar at zero claiming the
    // project used nothing. `hasData` is only ever sent on that history;
    // every other chart leaves it undefined and draws as before.
    if (m.hasData === false) {
      labels += `<text x="${cx.toFixed(1)}" y="${(padT + plotH - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="#b5b3ac">no data</text>`;
      labels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="#b5b3ac">${m.label}</text>`;
      return;
    }
    const h = (m.spend / maxV) * plotH;
    const y = padT + plotH - h;
    const color = m.isCurrent ? '#2a78d6' : '#9ec5f4';
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}"/>`;
    labels += `<text x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0b0b0b">${fmt(m.spend)}</text>`;
    labels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" font-weight="${m.isCurrent ? '700' : '600'}" fill="${m.isCurrent ? '#0b0b0b' : '#898781'}">${m.label}${m.isProjected ? ' (proj.)' : ''}</text>`;
    hitAreas += `<rect data-i="${i}" x="${(cx - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>`;
  });

  const container = document.getElementById(containerId);
  const tooltipId = `${containerId}-tooltip`;
  container.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="230" role="img" aria-label="6-month cost comparison">
    ${gridlines}${axisLabels}${bars}${labels}${hitAreas}
  </svg>
  <div id="${tooltipId}" class="month-tooltip" style="opacity:0"></div>`;

  const tooltip = document.getElementById(tooltipId);
  container.querySelectorAll('rect[data-i]').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const i = +rect.getAttribute('data-i');
      const m = months[i];
      const prev = i > 0 ? months[i - 1] : null;
      const deltaLine = prev && prev.spend > 0 ? `<div style="color:#c7cedb;margin-top:2px">${m.spend >= prev.spend ? '▲' : '▼'} ${Math.abs(((m.spend - prev.spend) / prev.spend) * 100).toFixed(1)}% vs ${prev.label}</div>` : '';
      tooltip.innerHTML = `<strong>${m.label}${m.isProjected ? ' (projected)' : ''}</strong><div>${fmt(m.spend)}</div>${deltaLine}`;
      tooltip.style.opacity = '1';
      tooltip.style.left = `${Math.min(75, Math.max(0, (i / (months.length - 1)) * 100 - 10))}%`;
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
  });
}

// Daily bars: complete days solid, today hollow/outlined since the provider
// hasn't finished reporting it. Denser than the monthly chart, so labels are
// thinned rather than drawn for every bar.
function renderDailyChart(series, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!series.length) {
    container.innerHTML = `<div class="muted" style="padding:24px 0;text-align:center">No daily data for this window.</div>`;
    return;
  }

  const W = 640, H = 230, padL = 54, padR = 14, padT = 26, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...series.map(d => d.spend), 0) * 1.2 || 1;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(24, slot * 0.62));

  let gridlines = '', axisLabels = '', bars = '', labels = '', hitAreas = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxV / ticks) * t;
    const y = padT + plotH - (v / maxV) * plotH;
    gridlines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e1e0d9" stroke-width="1"/>`;
    axisLabels += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="#898781">${CM_money(v, { decimals: 0 })}</text>`;
  }

  // Aim for ~8 x-axis labels regardless of window length.
  const labelStep = Math.max(1, Math.ceil(series.length / 8));

  series.forEach((d, i) => {
    const cx = padL + slot * i + slot / 2;
    const h = (d.spend / maxV) * plotH;
    const y = padT + plotH - h;
    if (d.partial) {
      bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="none" stroke="#2a78d6" stroke-width="1.5" stroke-dasharray="3,2"/>`;
    } else {
      bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#2a78d6"/>`;
    }
    if (i % labelStep === 0 || i === series.length - 1) {
      labels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#898781">${d.label}</text>`;
    }
    hitAreas += `<rect data-i="${i}" x="${(cx - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>`;
  });

  const tooltipId = `${containerId}-tooltip`;
  container.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="230" role="img" aria-label="Daily spend">
    ${gridlines}${axisLabels}${bars}${labels}${hitAreas}
  </svg>
  <div id="${tooltipId}" class="month-tooltip" style="opacity:0"></div>`;

  const tooltip = document.getElementById(tooltipId);
  container.querySelectorAll('rect[data-i]').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const i = +rect.getAttribute('data-i');
      const d = series[i];
      const prev = i > 0 ? series[i - 1] : null;
      const deltaLine = prev && prev.spend > 0 && !d.partial
        ? `<div style="color:#c7cedb;margin-top:2px">${d.spend >= prev.spend ? '▲' : '▼'} ${Math.abs(((d.spend - prev.spend) / prev.spend) * 100).toFixed(1)}% vs ${prev.label}</div>`
        : '';
      const note = d.partial ? `<div style="color:#c7cedb;margin-top:2px">Still reporting</div>` : '';
      tooltip.innerHTML = `<strong>${d.label}</strong><div>${fmt(d.spend)}</div>${deltaLine}${note}${tooltipServices(d)}`;
      tooltip.style.opacity = '1';
      tooltip.style.left = `${Math.min(75, Math.max(0, (i / Math.max(1, series.length - 1)) * 100 - 10))}%`;
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
    rect.style.cursor = 'pointer';
    rect.addEventListener('click', () => {
      selectDay(series, +rect.getAttribute('data-i'));
    });
  });

  // A day may already be chosen when the window length changes; keep it if
  // that date is still on screen, rather than silently closing the panel.
  reselectDay(series);
}

/**
 * The few biggest services, inside the hover tooltip.
 *
 * Capped well below what the API sends. The tooltip floats over the chart and
 * cannot scroll, so a dozen rows would cover the bars it is describing — the
 * full list lives in the panel below, which has room for it.
 */
const TOOLTIP_SERVICES = 5;

function tooltipServices(d) {
  const services = Array.isArray(d.services) ? d.services : [];
  if (!services.length) return '';

  const shown = services.slice(0, TOOLTIP_SERVICES);
  const rest = services.length - shown.length;
  const rows = shown.map(s => `
    <tr>
      <td style="padding:1px 10px 1px 0;color:#c7cedb">${escTag(s.name)}</td>
      <td style="padding:1px 0;text-align:right">${CM_money(s.spend)}</td>
    </tr>`).join('');

  return `
    <table style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.18);padding-top:4px;border-collapse:collapse;font-size:11.5px">
      ${rows}
    </table>
    ${rest > 0 ? `<div style="color:#c7cedb;margin-top:3px;font-size:11px">+${rest} more — click for all</div>` : ''}`;
}

/*
 * Which day the panel below is showing.
 *
 * Held as a date rather than an index: changing the window from 30 days to 90
 * renumbers every bar, and an index would quietly point at a different day.
 */
let selectedDayKey = null;

function reselectDay(series) {
  if (!selectedDayKey) return;
  const i = series.findIndex(d => d.dayKey === selectedDayKey);
  if (i === -1) {
    // That date is outside the new window. Closing is honest; leaving a panel
    // headed with a date that is no longer on the chart is not.
    clearDaySelection();
    return;
  }
  selectDay(series, i);
}

function selectDay(series, i) {
  const panel = document.getElementById('day-detail');
  const d = series[i];
  if (!panel || !d) return;

  selectedDayKey = d.dayKey;
  const prev = i > 0 ? series[i - 1] : null;
  const services = Array.isArray(d.services) ? d.services : [];

  highlightBar(i);

  const dayDelta = prev && prev.spend > 0 && !d.partial
    ? `<span class="delta ${d.spend >= prev.spend ? 'up-bad' : 'up-good'}">${d.spend >= prev.spend ? '▲' : '▼'} ${Math.abs(((d.spend - prev.spend) / prev.spend) * 100).toFixed(1)}%</span> <span class="muted">vs ${escTag(prev.label)}</span>`
    : '';

  const rows = services.length
    ? services.map(s => `
      <tr>
        <td>${escTag(s.name)}</td>
        <td class="num">${CM_money(s.spend)}</td>
        <td class="num muted">${s.pct < 0.1 && s.pct > 0 ? '&lt;0.1' : s.pct.toFixed(1)}%</td>
        <td class="num">${dayTrend(s.trend)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="muted" style="padding:12px 0">No service breakdown stored for this day.</td></tr>`;

  panel.hidden = false;
  panel.innerHTML = `
    <div class="day-detail-head">
      <div>
        <strong>${escTag(d.label)}</strong>
        ${d.partial ? '<span class="badge badge-warning">still reporting</span>' : ''}
        <div class="muted">${dayDelta}</div>
      </div>
      <div class="day-detail-right">
        <div class="day-detail-total">${CM_money(d.spend)}</div>
        <button type="button" class="day-detail-close" id="day-detail-close" aria-label="Close">✕</button>
      </div>
    </div>
    <table class="day-detail-table">
      <thead>
        <tr><th>Service</th><th class="num">Spend</th><th class="num">Share</th><th class="num">vs prior day</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  const close = document.getElementById('day-detail-close');
  if (close) close.addEventListener('click', clearDaySelection);
}

/**
 * Dims every bar but one, or restores them all when nothing is chosen.
 *
 * Opacity rather than colour: the bars already distinguish complete days from
 * a partial one by fill, and repainting would lose that.
 */
function highlightBar(i) {
  document.querySelectorAll('#daily-chart svg rect[data-i]').forEach(hit => {
    const idx = +hit.getAttribute('data-i');
    const bar = hit.parentNode.querySelectorAll('rect:not([data-i])')[idx];
    if (!bar) return;
    bar.setAttribute('fill-opacity', i === null || idx === i ? '1' : '0.45');
  });
}

/**
 * Puts the panel away and gives the chart back.
 *
 * The panel is tall, and someone who opened it to answer one question should
 * not have to scroll past it for the rest of the session — nor reload to be
 * rid of it. Forgetting the date as well as hiding the panel matters: kept,
 * it would reopen by itself the next time the window length changed.
 */
function clearDaySelection() {
  selectedDayKey = null;
  const panel = document.getElementById('day-detail');
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  highlightBar(null);
}

/**
 * A service's day-on-day move.
 *
 * Null means the provider did not supply one — Azure and GCP breakdowns have
 * no trend, and the folded "Other" line deliberately has none. A dash says
 * "not known", which is different from a flat zero and must not read as one.
 */
function dayTrend(trend) {
  if (trend === null || trend === undefined || trend === 0) {
    return '<span class="delta flat">—</span>';
  }
  const up = trend > 0;
  // Four-figure percentages are real here — a $2.76 service became $297.78 on
  // one AL STARK day — but the exact digits past a point are noise.
  const mag = Math.abs(trend);
  const shown = mag >= 1000 ? `${Math.round(mag / 100) * 100}` : mag.toFixed(0);
  return `<span class="delta ${up ? 'up-bad' : 'up-good'}">${up ? '▲' : '▼'} ${shown}%</span>`;
}

async function loadAndRenderDaily(days) {
  const res = await window.CM_Api.get(
    `/accounts/${encodeURIComponent(currentAccount.id)}/cost/daily?days=${encodeURIComponent(days)}`
  );

  const section = document.getElementById('daily-section');
  if (!res.available) {
    // Daily data is fetched when an account is connected and backfilled on
    // first view, so reaching here means the provider returned nothing for
    // this window — not that we simply haven't asked yet.
    document.getElementById('daily-chart').innerHTML =
      `<div class="muted" style="padding:24px 0;text-align:center">No daily cost data reported for this account.</div>`;
    ['daily-yesterday', 'daily-avg', 'daily-total', 'daily-today'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
    return;
  }
  if (section) section.style.display = '';

  const complete = res.series.filter(d => !d.partial);
  const yesterday = complete.length ? complete[complete.length - 1].spend : null;

  document.getElementById('daily-yesterday').textContent = yesterday !== null ? fmt(yesterday) : '—';
  document.getElementById('daily-avg').textContent = res.completeDays ? fmt(res.average) : '—';
  document.getElementById('daily-total').textContent = fmt(res.total);
  // A bare dash reads as "zero spend" or a broken tile. Providers publish the
  // current day hours late, and CloudMeter only re-pulls at the monitoring
  // frequency, so having nothing for today yet is normal and worth saying.
  const todayEl = document.getElementById('daily-today');
  if (res.partialToday !== null) {
    todayEl.textContent = `${fmt(res.partialToday)}*`;
    todayEl.title = "Today is still in progress, and your provider reports it hours behind.";
    todayEl.classList.remove('is-pending');
  } else {
    todayEl.textContent = 'Not in yet';
    todayEl.title = 'Your cloud provider has not published any of today\'s cost yet. '
      + 'It arrives a few hours behind, and CloudMeter picks it up at your monitoring frequency.';
    todayEl.classList.add('is-pending');
  }
  document.getElementById('daily-sub').textContent =
    `Day-by-day cost for this account — last ${res.days} days`;

  renderDailyChart(res.series, 'daily-chart');
}


// Long breakdowns get truncated to the rows that matter (everything here is
// sorted by spend) with the rest one click away, rather than making the page
// taller than anyone reads.
const LIST_ROWS_BEFORE_TRUNCATE = 6;

function withShowMore(containerId, rowsHtml, total, noun) {
  if (total <= LIST_ROWS_BEFORE_TRUNCATE) return rowsHtml.join('');
  const shown = rowsHtml.slice(0, LIST_ROWS_BEFORE_TRUNCATE).join('');
  const rest = rowsHtml.slice(LIST_ROWS_BEFORE_TRUNCATE).join('');
  return `${shown}
    <div data-rest="${containerId}" hidden>${rest}</div>
    <div class="show-more-row">
      <button class="show-more-btn" data-reveal="${containerId}">Show all ${total} ${noun} ↓</button>
    </div>`;
}

// Delegated once at document level, so every list gets this without each
// renderer having to remember to wire it up.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  const rest = document.querySelector(`[data-rest="${btn.dataset.reveal}"]`);
  if (rest) rest.hidden = false;
  btn.closest('.show-more-row')?.remove();
});

/**
 * The per-service change line.
 *
 * `trend` is now the change across matching windows — the elapsed days of this
 * month against the same days of last — and it is null for a service with no
 * measured history on the other side.
 *
 * Null has to be handled explicitly: `null >= 0` is true in JS, so the old
 * expression rendered a brand-new service as "▲ 0% vs last month", which reads
 * as "unchanged" about something that did not exist a month ago.
 */
function serviceTrendText(trend) {
  if (trend === null || trend === undefined) return 'No spend in the same period last month';
  const days = currentComparisonDays;
  const period = days ? `vs same ${days === 1 ? 'day' : `${days} days`} last month` : 'vs last month';
  return `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}% ${period}`;
}

function renderServiceCard(rows) {
  currentServiceRows = rows;
  const serviceRows = rows.map((s, i) => `
    <div class="provider-row clickable" data-service-i="${i}" tabindex="0" role="button" aria-label="View 6-month trend for ${escTag(s.name)}">
      <span class="provider-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <div><div class="provider-name">${escTag(s.name)}</div><div class="provider-meta">${serviceTrendText(s.trend)}</div></div>
      <div class="provider-amt">${fmt(s.spend)}<span class="pct">${s.pct.toFixed(0)}%</span><span class="row-chevron">›</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${s.pct}%;background:${PALETTE[i % PALETTE.length]}"></div></div>
    </div>`);
  document.getElementById('service-list').innerHTML =
    withShowMore('service-list', serviceRows, rows.length, 'services');

  const top = rows[0];
  if (top) {
    document.getElementById('stat-top-service').textContent = top.name;
    document.getElementById('stat-top-service-sub').textContent = `${fmt(top.spend)} · ${top.pct.toFixed(0)}% of spend`;
  } else {
    // With nothing charged this month there is no largest line. Writing the
    // dash is what clears the loading skeleton: leaving the branch empty left
    // the placeholder bars on screen for good, reading as a tile still
    // fetching rather than one with a real, settled answer of "none".
    document.getElementById('stat-top-service').textContent = '—';
    document.getElementById('stat-top-service-sub').textContent = 'Nothing charged this month';
  }

  document.querySelectorAll('#service-list [data-service-i]').forEach(row => {
    const open = () => openServiceModal(+row.dataset.serviceI);
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

async function openServiceModal(i) {
  const s = currentServiceRows[i];
  const color = PALETTE[i % PALETTE.length];
  document.getElementById('service-modal-dot').style.background = color;
  document.getElementById('service-modal-title').textContent = s.name;

  const pct = (s.spend / currentAccount.spend) * 100;
  document.getElementById('service-modal-sub').textContent =
    `${fmt(s.spend)} this month · ${pct.toFixed(0)}% of ${currentAccount.name}'s spend`;

  const { months } = await window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/history?service=${encodeURIComponent(s.name)}`);
  renderMonthlyChart(months, 'service-monthly-chart');

  const momPct = months[4].spend > 0 ? ((months[5].spend - months[4].spend) / months[4].spend) * 100 : 0;
  const momEl = document.getElementById('service-modal-mom');
  momEl.textContent = `${momPct >= 0 ? '▲' : '▼'} ${Math.abs(momPct).toFixed(1)}% vs last month`;
  momEl.className = `delta ${momPct >= 0 ? 'up-bad' : 'up-good'}`;

  document.getElementById('service-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

/**
 * The six-month chart behind one model row in Cost by model — that project's
 * spend on that model, not the account's. Reuses the service modal's shell.
 *
 * The history reaches back only to the day the project split was first
 * stored, so the chart may open with its first months marked "no data". That
 * is said in the subtitle rather than left to be inferred from the gaps.
 */
async function openProjectModelModal(project, model, color, comparison = { trend: null, days: null }) {
  document.getElementById('service-modal-dot').style.background = color;
  document.getElementById('service-modal-title').textContent = model;
  document.getElementById('service-modal-sub').textContent = `${project} · loading…`;
  document.getElementById('service-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';

  const qs = `?service=${encodeURIComponent(model)}&project=${encodeURIComponent(project)}`;
  const { months } = await window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/history${qs}`);
  renderMonthlyChart(months, 'service-monthly-chart');

  const withData = months.filter((m) => m.hasData !== false);
  const firstLabel = withData.length ? withData[0].label : null;
  const partial = withData.length < months.length;
  document.getElementById('service-modal-sub').textContent = partial
    ? `${project} · project detail recorded from ${firstLabel}; earlier months have no data`
    : `${project} · last ${months.length} months`;

  // The same figure as the row that opened this, not one recomputed from the
  // bars. The bars compare a projected September to all of August; the row
  // compares the first 21 days of each. Both are fair questions, but a reader
  // who saw ▲ 50% on the row and ▲ 29% here read it as a bug — so the modal
  // shows the row's number, worded the same way, and the two cannot differ.
  const momEl = document.getElementById('service-modal-mom');
  const { trend, days } = comparison;
  if (!days) {
    // The 1st of the month: no window to compare over yet.
    momEl.textContent = 'No comparison yet this month';
    momEl.className = 'delta flat';
  } else if (trend === null || trend === undefined) {
    momEl.textContent = `New this month — no spend in the same ${days} days last month`;
    momEl.className = 'delta flat';
  } else {
    momEl.textContent = `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}% vs same ${days === 1 ? 'day' : `${days} days`} last month`;
    momEl.className = `delta ${trend >= 0 ? 'up-bad' : 'up-good'}`;
  }
}

function closeServiceModal() {
  document.getElementById('service-overlay').classList.remove('show');
  document.body.style.overflow = '';
}



// Per-service change between two equal-length windows. Rows come back ordered
// by current spend, so the table reads like every other cost list in the app;
// the change column carries the "what's spiking" signal. That column leads with
// the amount — a 400% jump on $2 matters less than 12% on $3,000.
function renderCompareCard(res, days) {
  const body = document.getElementById('compare-body');
  const sub = document.getElementById('compare-sub');
  const note = document.getElementById('compare-note');
  if (!body) return;
  body.removeAttribute('aria-busy');

  if (!res.available || !res.rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">
        Not enough daily history yet to compare two ${days}-day windows.
      </td></tr>`;
    if (note) note.style.display = 'none';
    return;
  }

  if (sub) {
    // "Complete" is where today's absence is explained, once, for the whole
    // card — rather than repeated under a column too narrow to hold it.
    sub.textContent = `Last ${res.currentDays} complete days vs the `
      + `${res.previousDays} before them — today is excluded, highest cost first`;
  }

  setWindowHints(res);

  // An account younger than both windows would otherwise show every service
  // "up", purely because the earlier window is shorter.
  if (note) {
    if (!res.comparable) {
      note.textContent = `Only ${res.previousDays} days of earlier history are available, `
        + `so the previous column covers a shorter period than the current one.`;
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  }

  const totalLine = res.totalDeltaPct === null
    ? ''
    : `<tr style="font-weight:700;background:var(--surface-2)">
         <td>All ${unitWord(currentAccount.provider).many}</td>
         <td class="num">${fmt(res.currentTotal)}</td>
         <td class="num">${fmt(res.previousTotal)}</td>
         <td class="num">${lastMonthCell(res.lastMonthTotal)}</td>
         <td class="num">${changeCell({ delta: res.totalDelta, deltaPct: res.totalDeltaPct, isNew: false, stopped: false })}</td>
       </tr>`;

  // A busy account can report 30+ services, most of them costing pennies. The
  // list is ordered by spend, so the ones worth seeing are already at the top —
  // the rest stay one click away instead of running off the page.
  const MAX_ROWS = 10;
  const rowHtml = res.rows.map(r => `
    <tr>
      <td>${escTag(r.name)}</td>
      <td class="num">${fmt(r.current)}</td>
      <td class="num">${fmt(r.previous)}</td>
      <td class="num">${lastMonthCell(r.lastMonth)}</td>
      <td class="num">${changeCell(r)}</td>
    </tr>`);

  const extra = res.rows.length > MAX_ROWS
    ? rowHtml.slice(MAX_ROWS).map(h => h.replace('<tr>', '<tr class="compare-extra" hidden>')).join('')
      + `<tr class="compare-more-row"><td colspan="5" style="text-align:center;padding:11px">
           <button class="show-more-btn" data-compare-more>Show all ${res.rows.length} ${unitWord(currentAccount.provider).many} ↓</button>
         </td></tr>`
    : '';

  body.innerHTML = totalLine + rowHtml.slice(0, MAX_ROWS).join('') + extra;

  body.querySelector('[data-compare-more]')?.addEventListener('click', () => {
    body.querySelectorAll('.compare-extra').forEach(tr => { tr.hidden = false; });
    body.querySelector('.compare-more-row')?.remove();
  });
}

/**
 * Puts the real dates behind the two column headings.
 *
 * "Current" and "Previous" mean nothing on their own — the commonest question
 * about this table is which days each column actually covers, and the answer
 * was only in the subtitle as a count. The API already returns both ranges;
 * nothing read them.
 *
 * Also says that today is left out. A reader comparing these figures against
 * their provider's console would otherwise find them short by a day's spend
 * and have no way to know why.
 */
function setWindowHints(res) {
  const windows = [
    ['compare-window-current', res.currentRange, res.currentDays],
    ['compare-window-previous', res.previousRange, res.previousDays],
    ['compare-window-lastmonth', res.lastMonthRange, res.lastMonthDays],
  ];

  windows.forEach(([id, range, dayCount]) => {
    const el = document.getElementById(id);
    if (!el) return;
    /*
     * Written under the heading rather than hidden behind a hover.
     *
     * "Current" and "Previous" mean nothing on their own, and the dates are
     * the first thing anyone wants from this table — a reader should not have
     * to discover that the words are hoverable. Blank rather than stale when
     * a window has no data, so it cannot keep showing the last account's
     * dates.
     */
    el.textContent = range
      ? `${rangeLabel(range)} · ${dayCount} ${dayCount === 1 ? 'day' : 'days'}`
      : '';
  });
}

/** "6–12 Oct", or "28 Sep–4 Oct" when the window straddles two months. */
function rangeLabel(range) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  const fromTxt = from.toLocaleDateString('en-GB', opts);
  const toTxt = to.toLocaleDateString('en-GB', opts);
  if (fromTxt === toTxt) return fromTxt;
  // Same month: say the month once — "6–12 Oct" rather than "6 Oct–12 Oct".
  return from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear()
    ? `${from.getUTCDate()}–${toTxt}`
    : `${fromTxt}–${toTxt}`;
}

/**
 * The same stretch of days a month earlier.
 *
 * Null means those days are not in stored history, which is different from
 * having cost nothing — an account younger than two months would otherwise
 * show every service at zero back then and look as though everything is new.
 */
function lastMonthCell(value) {
  if (value === null || value === undefined) return '<span class="muted">—</span>';
  return fmt(value);
}

function changeCell(r) {
  if (r.isNew) return `<span class="delta up-bad">New · +${fmt(r.delta)}</span>`;
  if (r.stopped) return `<span class="delta up-good">Stopped · ${fmt(r.delta)}</span>`;
  /*
   * Rounds to nothing either way — calling that a rise or a fall is noise.
   *
   * Tested on the converted amount, because that is what the reader sees. The
   * deltas arrive in USD and the columns beside this one are in the account's
   * own currency, so rounding the raw figure declared "No change" against two
   * visibly different amounts: a rupee account showed WAF at ₹358 against
   * ₹382 — a ₹24 gap, about $0.27 — and called it unchanged. Anything the
   * money formatter would render as zero is genuinely nothing; anything it
   * would render as a number is worth naming.
   */
  if (Math.round(CM_amount(r.delta)) === 0) return `<span class="delta flat">No change</span>`;

  const up = r.delta > 0;
  const pct = r.deltaPct === null ? '' : ` (${up ? '+' : ''}${r.deltaPct.toFixed(0)}%)`;
  return `<span class="delta ${up ? 'up-bad' : 'up-good'}">${up ? '▲' : '▼'} `
    + `${up ? '+' : '−'}${fmt(Math.abs(r.delta))}${pct}</span>`;
}

async function loadAndRenderCompare(days) {
  const body = document.getElementById('compare-body');
  if (body) {
    body.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">
        Comparing the last ${days} days…
      </td></tr>`;
  }
  try {
    const res = await window.CM_Api.get(
      `/accounts/${encodeURIComponent(currentAccount.id)}/cost/compare?days=${encodeURIComponent(days)}`
    );
    renderCompareCard(res, days);
  } catch (err) {
    console.error('Failed to load service comparison', err);
    renderCompareCard({ available: false, rows: [] }, days);
  }
}

// A provider can report a couple of dozen locations, most carrying fractions of
// a cent from an idle resource. Listing them all buries the ones that matter,
// but dropping them hides real money — so everything below the cut collapses
// into one honest "other locations" row.
function rollUpRegions(regions, maxRows = 8) {
  if (regions.length <= maxRows) return { rows: regions, rolled: null };
  const rows = regions.slice(0, maxRows);
  const rest = regions.slice(maxRows);
  return {
    rows,
    rolled: {
      count: rest.length,
      spend: rest.reduce((sum, r) => sum + r.spend, 0),
    },
  };
}

// Region spend is a flat share-of-total list rather than a map: a map implies
// a precision the billing data doesn't have (a region is a group of data
// centres, not a point), and the question being answered is "how much is each
// location costing me", which a ranked list answers directly.
function renderRegionCard(res) {
  const list = document.getElementById('region-list');
  const sub = document.getElementById('region-sub');
  if (!list) return;
  list.removeAttribute('aria-busy');

  if (!res.available || !res.regions.length) {
    list.innerHTML = `<div class="muted" style="padding:20px 0;text-align:center">
        No location breakdown available for this account's provider.
      </div>`;
    return;
  }

  const total = res.regions.reduce((sum, r) => sum + r.spend, 0);
  const { rows, rolled } = rollUpRegions(res.regions);
  if (sub) {
    sub.textContent = `${res.regions.length} location${res.regions.length === 1 ? '' : 's'} `
      + `carrying this account's month-to-date spend`;
  }

  list.innerHTML = rows.map((r, i) => {
    // Share of the regions total, not of the account's stored spend: those can
    // differ slightly (credits, refunds), and bars that don't add to 100% look
    // broken.
    const pct = total > 0 ? (r.spend / total) * 100 : 0;
    const unplaced = r.name === 'NoRegion' || r.name === 'global';
    const color = unplaced ? 'var(--text-muted)' : PALETTE[i % PALETTE.length];
    return `
    <div class="provider-row">
      <span class="provider-dot" style="background:${color}"></span>
      <div>
        <div class="provider-name">${r.displayName}</div>
        ${unplaced ? '<div class="provider-meta">Support, tax and other charges with no location</div>' : ''}
      </div>
      <div class="provider-amt">${fmt(r.spend)}<span class="pct">${pct.toFixed(0)}%</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }).join('') + (rolled ? rolledRegionRow(rolled, total) : '');
}

function rolledRegionRow(rolled, total) {
  const pct = total > 0 ? (rolled.spend / total) * 100 : 0;
  return `
    <div class="provider-row">
      <span class="provider-dot" style="background:var(--gridline)"></span>
      <div>
        <div class="provider-name">${rolled.count} other locations</div>
        <div class="provider-meta">Combined — everything below the top 8 by spend</div>
      </div>
      <div class="provider-amt">${fmt(rolled.spend)}<span class="pct">${pct.toFixed(0)}%</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:var(--gridline)"></div></div>
    </div>`;
}

async function loadAndRenderRegionCard() {
  try {
    const res = await window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/regions`);
    renderRegionCard(res);
  } catch (err) {
    console.error('Failed to load region breakdown', err);
    renderRegionCard({ available: false, regions: [] });
  }
}

function renderTagCard(rows) {
  const tagRows = rows.map((t, i) => {
    const pct = (t.spend / currentAccount.spend) * 100;
    const color = t.untagged ? 'var(--status-warning)' : PALETTE[i % PALETTE.length];
    return `
    <div class="provider-row">
      <span class="provider-dot" style="background:${color}"></span>
      <div><div class="provider-name">${t.label}</div>${t.untagged ? '<div class="provider-meta">Not allocated to any tag value</div>' : ''}</div>
      <div class="provider-amt">${fmt(t.spend)}<span class="pct">${pct.toFixed(0)}%</span></div>
      <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  });
  document.getElementById('tag-list').innerHTML =
    withShowMore('tag-list', tagRows, rows.length, 'values');

  const untagged = rows.find(r => r.untagged);
  if (untagged) {
    const untaggedPct = (untagged.spend / currentAccount.spend) * 100;
    document.getElementById('stat-untagged').textContent = fmt(untagged.spend);
    document.getElementById('stat-untagged-sub').textContent = (currentProjectAttributed
      ? `${untaggedPct.toFixed(0)}% of spend isn't billed to a project`
      : `${untaggedPct.toFixed(0)}% of spend has no ${currentTagDim} tag`);
  }
}

function titleiseTagKey(key) {
  return key.replace(/[-_:]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Charges that land in "untagged" because nothing could ever tag them.
 *
 * Tax is levied on the account, not on any resource; a domain registration has
 * no resource either. Both therefore carry no tag key and fall into the
 * residual by arithmetic, not by anyone's mistake — and on a well-tagged
 * account they dominate it. Acme reads "37% carries none of these tags", of
 * which more than half is these two, so the headline invites a tagging sweep
 * that cannot possibly move it.
 *
 * Deliberately the same two names as FIXED_CHARGE_SERVICES in the backend's
 * anomaly.ts, for the same underlying reason: they are billing events rather
 * than usage. Kept as a literal rather than imported because this file ships
 * as a plain script, so the two lists are duplicated by construction — extend
 * both together.
 */
const UNTAGGABLE_SERVICES = new Set(['Tax', 'Amazon Registrar']);

// "Tax", "Tax and Amazon Registrar" — the note naming them reads as a sentence,
// and two is the common case, so a bare comma-join would look truncated.
function listAnd(names) {
  if (names.length <= 1) return escTag(names[0] || '');
  return `${names.slice(0, -1).map(escTag).join(', ')} and ${escTag(names[names.length - 1])}`;
}

/**
 * OpenAI attributes spend to projects, not to tags, so on those accounts the
 * card is titled for what it actually shows.
 *
 * Both conditions are required, deliberately. Gating on the dimension name
 * alone would retitle any account that happens to have a tag key called
 * "Project" — prod already has two AWS accounts carrying
 * "iamPrincipal/Project Name", one rename away from matching. Gating on the
 * provider alone would retitle a seeded OpenAI account, whose demo data has
 * environment/team/cost-center keys and no projects at all.
 */
function isProjectAttributed(res) {
  return currentAccount
    && currentAccount.provider === 'openai'
    && Array.isArray(res && res.availableDims)
    && res.availableDims.includes('Project');
}

/** Titles the tag card for whichever of the two it is showing. */
function applyTagCardWording(res) {
  const project = isProjectAttributed(res);
  currentProjectAttributed = project;
  const title = document.getElementById('tag-card-title');
  const sub = document.getElementById('tag-card-sub');
  if (title) title.textContent = project ? 'Cost by project' : 'Cost by tag';
  if (sub) {
    sub.textContent = project
      ? 'Group spend by the OpenAI project it was billed to'
      : 'Group spend by how resources are tagged';
  }
  return project;
}

// Slide navigation for the tag card.
//
// Slides are all rendered and toggled with [hidden] rather than built on demand:
// the whole breakdown is already in memory, so there is nothing to fetch when
// moving between keys, and the browser keeps each slide's layout stable.
function wireTagSlider(slides) {
  const root = document.getElementById('tag-list');
  const nodes = root.querySelectorAll('.tag-slide');
  if (nodes.length < 2) return;

  const prev = root.querySelector('[data-tag-nav="prev"]');
  const next = root.querySelector('[data-tag-nav="next"]');
  const count = root.querySelector('[data-tag-nav="count"]');
  let index = 0;

  function show(i) {
    // Clamped rather than wrapped: with the ends disabled, wrapping would jump
    // the card from the first key to Untagged with no cue that it had.
    index = Math.max(0, Math.min(i, nodes.length - 1));
    nodes.forEach((n, j) => { n.hidden = j !== index; });
    count.textContent = `${slides[index].title} — ${index + 1} of ${nodes.length}`;
    prev.disabled = index === 0;
    next.disabled = index === nodes.length - 1;
  }

  prev.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));

  // Arrow keys work once a nav button has focus, so the card is reachable
  // without a mouse but never swallows arrow keys from the rest of the page.
  root.addEventListener('keydown', (e) => {
    if (!e.target.closest('[data-tag-nav]')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
  });

  show(0);
}

function escTag(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Every tag key at once, each with its values nested beneath it.
//
// The per-key view this replaces showed one key at a time, and because each key
// partitions the whole account its "Untagged" row was whatever that one key
// didn't cover — 66% under one key, 98% under the next. Both were arithmetically
// right and the pair was unreadable. One cross-tag Untagged answers the question
// people actually ask: how much carries none of these tags.
function renderGroupedTagCard(res) {
  const total = Number(res.totalSpend) || 0;
  const pctOf = (n) => (total > 0 ? (n / total) * 100 : 0);

  // Same card, named for what the provider actually attributes spend by. Only
  // the words change — every figure below is computed identically.
  const LABELS = currentProjectAttributed
    ? {
      untaggedTitle: 'No project',
      untaggedMeta: 'Not billed to any project',
      untaggedStat: (p) => `${p}% of spend isn't billed to a project`,
      withoutKey: (amt) => `${amt} without a project`,
    }
    : {
      untaggedTitle: 'Untagged / Shared',
      untaggedMeta: 'Carries none of the tag keys in this account',
      untaggedStat: (p) => `${p}% of spend carries none of these tags`,
      withoutKey: (amt) => `${amt} without this tag`,
    };

  // One tag key per slide. Stacking every key and its values made a card tall
  // enough that comparing the first key against the last meant scrolling past
  // everything in between; a slide holds one key whole, at a readable size.
  const slides = res.groups.map((g, i) => {
    const color = PALETTE[i % PALETTE.length];
    const pct = pctOf(g.tagged);
    // Per-key untagged sits in the sub-label because it stays meaningful when
    // the keys overlap — "$X has no team tag" is answerable whether or not a
    // resource also carries an environment tag, unlike the cross-tag figure.
    const perKey = Number(g.untaggedForKey) || 0;
    const meta = `${g.values.length} value${g.values.length === 1 ? '' : 's'}`
      + (perKey > 0.005 ? ` &middot; ${LABELS.withoutKey(fmt(perKey))}` : '');

    const rows = g.values.map((v) => {
      const vPct = pctOf(v.spend);
      return `
      <div class="provider-row" style="padding-left:22px">
        <span class="provider-dot" style="background:${color};opacity:.45"></span>
        <div><div class="provider-name" style="font-weight:400">${escTag(v.label)}</div></div>
        <div class="provider-amt">${fmt(v.spend)}<span class="pct">${vPct.toFixed(0)}%</span></div>
        <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${vPct}%;background:${color};opacity:.45"></div></div>
      </div>`;
    }).join('');

    return {
      title: titleiseTagKey(g.tagKey),
      html: `
      <div class="provider-row">
        <span class="provider-dot" style="background:${color}"></span>
        <div>
          <div class="provider-name">${escTag(titleiseTagKey(g.tagKey))}</div>
          <div class="provider-meta">${meta}</div>
        </div>
        <div class="provider-amt">${fmt(g.tagged)}<span class="pct">${pct.toFixed(0)}%</span></div>
        <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>${rows}`,
    };
  });

  /*
   * The residual, less the charges that could never have carried a tag.
   *
   * Tax is levied on the account and a domain registration has no resource, so
   * both fall into "total minus tagged" by arithmetic rather than by anyone's
   * mistake. Counting them made the headline a target nobody could hit: Acme
   * read 37% untagged when half of that was tax, and the tagging sweep it
   * invited could not have moved a rupee of it.
   *
   * They are excluded rather than merely labelled because the figure exists to
   * be acted on. Nothing is lost by it — every one of those charges is already
   * a line in Cost by service, where it reads as what it is.
   *
   * Only excludable once the per-service breakdown has synced. Without it the
   * residual is an undifferentiated lump, and the old whole-residual figure is
   * the honest answer: better an overstatement that says where it came from
   * than a reduction resting on services nobody has listed.
   */
  const shared = Number(res.untaggedShared) || 0;
  const untaggedServices = Array.isArray(res.untaggedServices) ? res.untaggedServices : null;
  const listed = (untaggedServices || []).filter((u) => Number(u.spend) > 0.005);
  const untaggable = listed.filter((u) => UNTAGGABLE_SERVICES.has(u.name));
  const taggable = listed.filter((u) => !UNTAGGABLE_SERVICES.has(u.name));
  const sum = (arr) => arr.reduce((t, u) => t + (Number(u.spend) || 0), 0);

  const splitKnown = untaggedServices !== null;
  const untaggableSpend = splitKnown ? sum(untaggable) : 0;
  // Clamped because the two figures come from separate Cost Explorer queries:
  // a boundary-straddling refresh could momentarily make the parts exceed the
  // whole, and a negative "untagged" would be worse than a zero.
  const net = Math.max(0, shared - untaggableSpend);

  if (net > 0.005 || untaggableSpend > 0.005) {
    const pct = pctOf(net);

    // Shares are of the untagged figure above them, so the list adds to 100%
    // rather than silently switching denominator between a row and its header.
    const detail = (splitKnown ? taggable : []).map((u) => {
      const uPct = net > 0 ? (Number(u.spend) / net) * 100 : 0;
      return `
      <div class="provider-row">
        <span class="provider-dot" style="background:var(--status-warning);opacity:.45"></span>
        <div><div class="provider-name" style="font-weight:400">${escTag(u.name)}</div></div>
        <div class="provider-amt">${fmt(u.spend)}<span class="pct">${uPct.toFixed(0)}%</span></div>
        <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${uPct}%;background:var(--status-warning);opacity:.45"></div></div>
      </div>`;
    }).join('');

    /*
     * What was taken out, named and totalled.
     *
     * Silently shrinking the figure would leave it irreconcilable with the
     * account total — tagged plus untagged would no longer account for the
     * bill, and the gap would look like a bug. The note closes that.
     */
    const excluded = untaggableSpend > 0.005
      ? `<div class="provider-meta" style="padding:12px 0 0;flex:none">
           Excludes ${fmt(untaggableSpend)} of ${listAnd(untaggable.map((u) => u.name))}
           — charged on the account, not on any resource, so no tag can reach them.
           They appear under Cost by service.
         </div>`
      : '';

    // Absent means the account has not been refreshed since this existed —
    // not that the remainder is empty. Saying so beats an unexplained gap
    // where a list should be.
    const pending = !splitKnown
      ? `<div class="provider-meta" style="padding:10px 0 0;flex:none">
           The breakdown arrives with this account's next refresh, and any tax
           in it will be excluded from the figure above.
         </div>`
      : '';

    slides.push({
      title: LABELS.untaggedTitle,
      html: `
      <div class="provider-row">
        <span class="provider-dot" style="background:var(--status-warning)"></span>
        <div>
          <div class="provider-name">${LABELS.untaggedTitle}</div>
          <div class="provider-meta">${LABELS.untaggedMeta}</div>
        </div>
        <div class="provider-amt">${fmt(net)}<span class="pct">${pct.toFixed(0)}%</span></div>
        <div class="provider-bar-track"><div class="provider-bar-fill" style="width:${pct}%;background:var(--status-warning)"></div></div>
      </div>${detail}${excluded}${pending}`,
    });
  }

  // A resource carrying two tag keys is counted under both, so the tagged sum
  // can exceed the account total. Saying so beats showing a silently clamped
  // Untagged of zero and letting the numbers look wrong for no stated reason.
  const overlapNote = res.overlap
    ? `<div class="provider-meta" style="padding:12px 0 0;flex:none">
        Tag totals exceed the account total because some resources carry more
        than one tag key and are counted under each.
      </div>`
    : '';

  // The nav is pointless with a single slide, and its absence is also what the
  // keyboard handler below keys off.
  const nav = slides.length > 1 ? `
    <div class="tag-nav">
      <div class="seg-control">
        <button type="button" data-tag-nav="prev" aria-label="Previous tag">&lsaquo;</button>
        <button type="button" data-tag-nav="next" aria-label="Next tag">&rsaquo;</button>
      </div>
      <span class="tag-nav-count" data-tag-nav="count"></span>
    </div>` : '';

  document.getElementById('tag-list').innerHTML = `
    <div class="tag-slides">
      ${slides.map((s, i) => `<div class="tag-slide" data-slide="${i}"${i ? ' hidden' : ''}>${s.html}</div>`).join('')}
    </div>${nav}${overlapNote}`;

  wireTagSlider(slides);

  // With overlapping keys the cross-tag figure isn't derivable — every resource
  // may carry all three of environment/team/cost-center, so total minus tagged
  // goes negative and clamps to zero. Reporting "$0.00 untagged" there would
  // state something false; the tile says so instead.
  if (res.overlap) {
    document.getElementById('stat-untagged').textContent = '—';
    document.getElementById('stat-untagged-sub').textContent =
      'Tag keys overlap — see per-tag figures';
    return;
  }
  // The tile and the card's untagged slide report the same figure, so the
  // exclusion is applied once, above, and simply read here.
  document.getElementById('stat-untagged').textContent = fmt(net);
  // The amount and the reasoning live on the card's untagged slide, which has
  // the room for them; the tile only needs to say the figure is net of tax, so
  // nobody reconciles it against a bill that includes it.
  document.getElementById('stat-untagged-sub').textContent = untaggableSpend > 0.005
    ? `${LABELS.untaggedStat(pctOf(net).toFixed(0))} — tax not included`
    : LABELS.untaggedStat(pctOf(net).toFixed(0));
}

// Tag dimensions come from whatever cost-allocation tag keys the account
// actually has, so the switcher is built from the API response rather than
// the fixed three the prototype hardcoded.
function renderTagDimSwitch(availableDims) {
  const wrap = document.getElementById('tag-dim-switch');
  if (!availableDims.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  wrap.innerHTML = availableDims.map(d =>
    `<button data-dim="${d}" class="${d === currentTagDim ? 'active' : ''}">${titleiseTagKey(d)}</button>`
  ).join('');

  wrap.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      wrap.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTagDim = btn.dataset.dim;
      await loadAndRenderTagCard();
    });
  });
}

/**
 * "Cost by model": which models each project spent on this month.
 *
 * Rides on the same /cost/tags response as the Projects card, so it costs no
 * extra request. The card stays hidden unless the API sends a split — only
 * OpenAI has a project dimension, and even there a month with no split
 * (every project call failed) draws no card rather than an empty one.
 *
 * Each project is a native <details>, collapsed, so the page reads as a list
 * of projects with totals and opens into models on demand. The busiest
 * project can carry forty models; forty rows apiece, open by default, would
 * bury the rest of the page.
 */
function renderByModelCard(byModel) {
  const section = document.getElementById('by-model-section');
  const list = document.getElementById('by-model-list');
  const note = document.getElementById('by-model-note');
  if (!section || !list || !note) return;

  if (!byModel || !Array.isArray(byModel.projects) || byModel.projects.length === 0) {
    section.hidden = true;
    // Nothing to replace them with this month — give the service and project
    // cards back rather than leave the page without a breakdown.
    const breakdown = document.getElementById('breakdown-section');
    if (breakdown && currentAccount && currentAccount.provider === 'openai') breakdown.style.display = '';
    return;
  }

  // "vs same 21 days last month", or nothing on the 1st when there is no
  // window yet. Same wording the service card used, so a reader who knew
  // that card reads this one the same way.
  const days = byModel.comparison ? byModel.comparison.days : null;
  const period = days ? `vs same ${days === 1 ? 'day' : `${days} days`} last month` : 'vs last month';
  const trendHtml = (t) => {
    if (!days) return '';
    if (t === null || t === undefined) return `<span class="by-model-trend flat">new this month</span>`;
    return `<span class="by-model-trend ${t >= 0 ? 'up' : 'down'}" title="${period}">${t >= 0 ? '▲' : '▼'} ${Math.abs(t).toFixed(1)}%</span>`;
  };

  const total = byModel.projects.reduce((s, p) => s + p.spend, 0);
  list.innerHTML = byModel.projects.map((p, i) => `
    <details class="by-model-project"${i === 0 ? ' open' : ''}>
      <summary class="by-model-summary">
        <span class="sq" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="by-model-name">${escTag(p.label)}</span>
        <span class="by-model-meta">${modelCountLabel(p.models)}</span>
        ${trendHtml(p.trend)}
        <span class="by-model-amt">${fmt(p.spend)}<span class="pct">${total > 0 ? Math.round((p.spend / total) * 100) : 0}%</span></span>
      </summary>
      <div class="by-model-rows">
        ${p.models.map((m) => `
        <div class="by-model-row clickable" role="button" tabindex="0"
             data-project="${escTag(p.label)}" data-model="${escTag(m.name)}" data-color="${PALETTE[i % PALETTE.length]}"
             data-trend="${m.trend === null || m.trend === undefined ? '' : m.trend}" data-days="${days || ''}"
             aria-label="View 6-month trend for ${escTag(m.name)} on ${escTag(p.label)}">
          <span class="by-model-model">${escTag(m.name)}</span>
          <span class="by-model-track"><span class="by-model-fill" style="width:${p.spend > 0 ? (m.spend / p.spend) * 100 : 0}%;background:${PALETTE[i % PALETTE.length]}"></span></span>
          ${trendHtml(m.trend)}
          <span class="by-model-model-amt">${fmt(m.spend)}<span class="row-chevron">›</span></span>
        </div>`).join('')}
      </div>
    </details>`).join('');

  list.querySelectorAll('.by-model-row[data-model]').forEach((row) => {
    const open = () => openProjectModelModal(row.dataset.project, row.dataset.model, row.dataset.color, {
      trend: row.dataset.trend === '' ? null : Number(row.dataset.trend),
      days: row.dataset.days ? Number(row.dataset.days) : null,
    });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  // A day that had spend but no project split is absent from these sums, so
  // the figures can run short of the account total. Only such days count: a
  // day with no spend has nothing to split, and the first version reported
  // those as gaps too — "20 of 22 days" on a month where the two missing days
  // had cost nothing.
  const short = byModel.daysUnsplit > 0;
  note.hidden = !short;
  note.textContent = short
    ? `${byModel.daysUnsplit} of ${byModel.daysWithSpend} days with spend this month have no project breakdown, so these figures run a little short of the account total.`
    : '';

  section.hidden = false;
}

async function loadAndRenderTagCard() {
  const qs = currentTagDim ? `?dim=${encodeURIComponent(currentTagDim)}` : '';
  const res = await window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/tags${qs}`);
  currentTagDim = res.dim;
  applyTagCardWording(res);
  renderByModelCard(res.byModel);

  if (!res.dim) {
    renderTagDimSwitch([]);
    document.getElementById('tag-list').innerHTML =
      `<div class="muted" style="padding:12px 0">No cost-allocation tags are activated on this account yet.</div>`;
    document.getElementById('stat-untagged').textContent = '—';
    document.getElementById('stat-untagged-sub').textContent = 'No tag data available';
    return;
  }

  // The grouped view supersedes the per-key switcher, so the switcher is hidden
  // rather than removed: if grouping can't be assembled we fall back to it
  // instead of leaving an empty card.
  if (Array.isArray(res.groups) && res.groups.length) {
    renderTagDimSwitch([]);
    renderGroupedTagCard(res);
    return;
  }

  // The API serves one key per call. Rather than wait on a backend release to
  // group them, fetch the remaining keys and assemble it here — every key's
  // rows already cover the whole account, so the totals needed are all present.
  try {
    const grouped = await buildGroupedFromDims(res);
    if (grouped && grouped.groups.length) {
      renderTagDimSwitch([]);
      renderGroupedTagCard(grouped);
      return;
    }
  } catch (err) {
    console.error('Could not assemble grouped tag view, showing per-key view', err);
  }

  renderTagDimSwitch(res.availableDims ?? []);
  renderTagCard(res.tags);
}

// Builds the same shape the API's `groups` field will carry, from one response
// per tag key.
//
// totalSpend is taken as the largest key total rather than summed: each key
// partitions the entire account (its tagged values plus its own untagged
// remainder), so any one key already totals the account, and summing them would
// multiply it by the number of keys.
async function buildGroupedFromDims(firstRes) {
  const dims = firstRes.availableDims ?? [];
  if (!dims.length) return null;

  const byDim = { [firstRes.dim]: firstRes.tags ?? [] };
  const missing = dims.filter((d) => d !== firstRes.dim);
  const fetched = await Promise.all(missing.map((d) =>
    window.CM_Api
      .get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/tags?dim=${encodeURIComponent(d)}`)
      // One key failing shouldn't cost the whole card — it just isn't grouped in.
      .then((r) => ({ dim: d, tags: r.tags ?? [] }))
      .catch(() => ({ dim: d, tags: [] }))
  ));
  fetched.forEach((r) => { byDim[r.dim] = r.tags; });

  const groups = [];
  let totalSpend = 0;

  dims.forEach((dim) => {
    const rows = byDim[dim] ?? [];
    const values = rows
      .filter((t) => !t.untagged && Number(t.spend) > 0)
      .map((t) => ({ label: t.label, spend: Number(t.spend) }))
      .sort((a, b) => b.spend - a.spend);
    const untaggedForKey = rows
      .filter((t) => t.untagged)
      .reduce((sum, t) => sum + Number(t.spend), 0);
    const tagged = values.reduce((sum, v) => sum + v.spend, 0);

    totalSpend = Math.max(totalSpend, tagged + untaggedForKey);
    if (values.length) groups.push({ tagKey: dim, tagged, untaggedForKey, values });
  });

  groups.sort((a, b) => b.tagged - a.tagged);
  const totalTagged = groups.reduce((sum, g) => sum + g.tagged, 0);

  return {
    groups,
    totalSpend,
    totalTagged,
    untaggedShared: Math.max(0, totalSpend - totalTagged),
    // Keys overlap when a resource carries more than one of them, so the tagged
    // sum overshoots the account and the cross-tag remainder is not derivable.
    overlap: totalTagged > totalSpend + 0.01,
  };
}


// ---- Owner / contact -------------------------------------------------------
// Free text, optional, and deliberately not derived from the provider: an AWS
// root email is only visible to org members and is a phishing target anyway.

function escOwner(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Mirrors canManageAccount() on the server: Owners and Admins, on any account.
// The server enforces it; this just avoids offering an edit that would 403.
function canEditOwner() {
  const me = window.CM_ME;
  if (!me || !currentAccount) return false;
  return me.role === 'owner' || me.role === 'admin';
}

// Mirrors canRefreshAccount(): Owners and Admins anywhere, plus whoever the
// account is assigned to — including a Member, who can pull their own.
function canRefresh() {
  const me = window.CM_ME;
  if (!me || !currentAccount) return false;
  if (me.role === 'owner' || me.role === 'admin') return true;
  return !!currentAccount.createdBy && currentAccount.createdBy === me.userId;
}

const SEP = '<span class="acc-meta-sep">·</span>';

/**
 * Adhoc accounts carry neither line in the header.
 *
 * The subscriptions inside already name who each one is for, which is the
 * question "Owner" was answering; and "Managed by … Reassign" belongs to an
 * account somebody connected with credentials, which this is not. Guarded here
 * rather than at the call sites because both functions are also re-run after a
 * rename, a reassignment and an owner edit.
 */
function adhocHeaderLinesHidden() {
  return currentAccount && currentAccount.provider === 'adhoc';
}

function renderOwnerLine() {
  const line = document.getElementById('acc-owner-slot');
  if (!line || !currentAccount) return;
  if (adhocHeaderLinesHidden()) { line.innerHTML = ''; return; }

  const owner = currentAccount.owner;
  const editable = canEditOwner();

  // Nothing set and nothing the viewer can do about it — stay out of the way.
  // An empty slot contributes no separator either, so the line stays clean.
  if (!owner && !editable) { line.innerHTML = ''; return; }

  line.innerHTML = SEP + (owner
    ? `<span class="acc-owner-label">Owner</span> <span class="acc-owner-value">${escOwner(owner)}</span>`
      + (editable ? `<button type="button" class="link-btn-sm" id="acc-owner-edit">Change</button>` : '')
    : `<button type="button" class="link-btn-sm" id="acc-owner-edit">+ Add owner</button>`);

  const btn = document.getElementById('acc-owner-edit');
  if (btn) btn.addEventListener('click', startOwnerEdit);
}

function startOwnerEdit() {
  const line = document.getElementById('acc-owner-slot');
  line.innerHTML = SEP + `
    <span class="acc-owner-edit">
      <input class="field-input field-input-sm" id="acc-owner-input" maxlength="120"
             placeholder="e.g. Platform team, or jane@acme.com">
      <button type="button" class="btn btn-sm btn-primary" id="acc-owner-save">Save</button>
      <button type="button" class="link-btn-sm" id="acc-owner-cancel">Cancel</button>
    </span>
    <span class="acc-owner-error" id="acc-owner-error" hidden></span>`;

  const input = document.getElementById('acc-owner-input');
  input.value = currentAccount.owner || '';
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveOwner();
    if (e.key === 'Escape') renderOwnerLine();
  });
  document.getElementById('acc-owner-save').addEventListener('click', saveOwner);
  document.getElementById('acc-owner-cancel').addEventListener('click', renderOwnerLine);
}

async function saveOwner() {
  const input = document.getElementById('acc-owner-input');
  const save = document.getElementById('acc-owner-save');
  const error = document.getElementById('acc-owner-error');
  const value = input.value.trim();

  // Saving the same thing back is a no-op, including "blank stays blank".
  if (value === (currentAccount.owner || '')) { renderOwnerLine(); return; }

  save.disabled = true;
  save.textContent = 'Saving…';
  error.hidden = true;
  try {
    const res = await updateAccountOwner(currentAccount.id, value);
    currentAccount.owner = res.owner || '';
    renderOwnerLine();
  } catch (err) {
    save.disabled = false;
    save.textContent = 'Save';
    error.textContent = err.message || "Couldn't save that — try again.";
    error.hidden = false;
  }
}


// ---- Managed by (reassignment) ---------------------------------------------
// createdBy starts as whoever connected the account and doubles as "who may
// manage it". People leave, so it has to be reassignable — otherwise an
// account whose only non-Owner manager has gone is stranded on the Owner.

// Owners and Admins only. A Member who holds an account is answerable for its
// spend, not for choosing who is answerable next — so the control isn't shown
// to them at all. Mirrors canReassign() on the server, which enforces it.
function canReassign() {
  const me = window.CM_ME;
  if (!me || !currentAccount) return false;
  return me.role === 'owner' || me.role === 'admin';
}

function renderManagedLine() {
  const line = document.getElementById('acc-managed-slot');
  if (!line || !currentAccount) return;
  if (adhocHeaderLinesHidden()) { line.innerHTML = ''; return; }

  const email = currentAccount.createdByEmail;
  const editable = canReassign();
  if (!email && !editable) { line.innerHTML = ''; return; }

  // Once an account has been handed over, createdBy is an assignment rather
  // than a record of who connected it — so say who did, instead of quietly
  // overwriting the fact.
  const connected = currentAccount.connectedByEmail;
  const provenance = connected && connected !== email
    ? ` <span class="acc-owner-label" title="Who originally connected this account">(connected by ${escOwner(connected)})</span>`
    : '';

  // Someone assigned an account then left. The name is still the truth about
  // who it was handed to, so keep it — but stop implying they can act on it.
  const departed = email && currentAccount.managerActive === false
    ? ` <span class="acc-stale-manager">no longer on the team</span>`
    : '';

  line.innerHTML = SEP + (email
    ? `<span class="acc-owner-label">Managed by</span> <span class="acc-owner-value">${escOwner(email)}</span>${departed}${provenance}`
    : `<span class="acc-owner-label">Managed by</span> <span class="acc-owner-value acc-unassigned">Unassigned</span>`)
    + (editable ? ` <button type="button" class="link-btn-sm" id="acc-managed-edit">${email && !departed ? 'Reassign' : 'Assign'}</button>` : '');

  const btn = document.getElementById('acc-managed-edit');
  if (btn) btn.addEventListener('click', startReassign);
}

async function startReassign() {
  const line = document.getElementById('acc-managed-slot');
  const restore = line.innerHTML;
  line.innerHTML = SEP + `<span class="acc-owner-label">Loading teammates…</span>`;

  let team;
  try {
    team = await fetchTeam();
  } catch (err) {
    line.innerHTML = SEP + `<span class="acc-owner-error">Couldn't load your team — ${escOwner(err.message || 'try again')}.</span>`;
    return;
  }
  line.innerHTML = restore;
  renderManagedLine();

  // Anyone who has joined can hold an account. A Member assigned one is
  // granted access to it automatically, so the choice can't strand it.
  // Pending invitees have no identity yet, so they're still excluded.
  const eligible = team.filter(m => !m.pendingInvite);
  if (eligible.length <= 1) {
    showRefreshNote('No one else has joined yet — invite a teammate first.', false);
    return;
  }

  openReassignDialog(eligible);
}

/**
 * A dialog rather than an inline control: the header is one compact line, and a
 * dropdown plus two buttons crammed into it competed for space with the account
 * name and wrapped unpredictably at narrower widths.
 */
function openReassignDialog(eligible) {
  const options = eligible.map(m => {
    const roleLabel = m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member';
    const selected = m.id === currentAccount.createdBy ? ' selected' : '';
    return `<option value="${escOwner(m.id)}"${selected}>${escOwner(m.name || m.email)} — ${roleLabel}${m.isYou ? ' (you)' : ''}</option>`;
  }).join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Who manages ${escOwner(currentAccount.name)}?</h2>
    <p class="modal-sub">The manager is answerable for this account's spend. They can open it,
      force a cost refresh, and act on its alerts. A Member picked here is given access to it automatically.</p>
    <label class="field-label" for="reassign-to">Managed by</label>
    <select class="field-input" id="reassign-to">${options}</select>
    <p class="field-error" id="reassign-error"></p>
    <div class="modal-actions">
      <button class="btn" data-reassign-cancel>Cancel</button>
      <button class="btn btn-primary" data-reassign-save>Save</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-reassign-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-reassign-save]').addEventListener('click', () => saveReassign(dlg, close));
}

async function saveReassign(dlg, close) {
  const select = dlg.querySelector('#reassign-to');
  const save = dlg.querySelector('[data-reassign-save]');
  const error = dlg.querySelector('#reassign-error');
  const targetId = select.value;

  if (targetId === currentAccount.createdBy) { close(); return; }

  save.disabled = true;
  save.textContent = 'Saving…';
  error.classList.remove('show');
  try {
    const res = await reassignAccount(currentAccount.id, targetId);
    currentAccount.createdBy = res.createdBy;
    currentAccount.createdByEmail = res.createdByEmail;
    currentAccount.connectedByEmail = res.connectedByEmail;
    // The server only accepts a current teammate, so the new manager is active
    // by definition — clear any stale flag from the person they replaced.
    currentAccount.managerActive = true;
    close();
    renderManagedLine();
    // Handing an account to someone else can give away your own right to
    // refresh it, so the controls have to be re-derived.
    renderOwnerLine();
    setupRefreshButton();
  } catch (err) {
    save.disabled = false;
    save.textContent = 'Save';
    error.textContent = err.message || "Couldn't save that — try again.";
    error.classList.add('show');
  }
}

// ---- Per-account notifications ---------------------------------------------
// A Member has no organisation-wide Notifications page — nothing on it is
// theirs to set — so what this account tells them is chosen here, per account.
// Owners and Admins keep the single org-wide page and don't see this.

function setupAccountNotifications() {
  const section = document.getElementById('acct-notify-section');
  const me = window.CM_ME;
  if (!section || !me || !currentAccount) return;

  /*
   * Nothing is ever sent about an adhoc account, so there is nothing to switch.
   *
   * Both notifications are built only from accounts that are polled: anomaly
   * detection skips anything that is not `dataSource: 'live'`, and the digest
   * filters to the same set. An adhoc account is typed in by hand and never
   * polled, so neither can fire for it — and two switches that change nothing
   * are worse than no card, because the reader has no way to tell.
   */
  section.hidden = me.role !== 'member' || currentAccount.provider === 'adhoc';
  if (section.hidden) return;

  document.getElementById('acct-notify-name').textContent = currentAccount.name;

  const prefs = currentAccount.notifications || {};
  const anomaly = document.getElementById('acct-notify-anomaly');
  const digest = document.getElementById('acct-notify-digest');
  // Absent means on: being given an account should tell you about it without
  // having to enable anything first.
  anomaly.checked = prefs.anomaly !== false;
  digest.checked = prefs.digest !== false;

  if (section.dataset.wired) return;
  section.dataset.wired = '1';
  anomaly.addEventListener('change', () => saveAccountNotifications('anomaly', anomaly));
  digest.addEventListener('change', () => saveAccountNotifications('digest', digest));
}

// ---- Forced refresh --------------------------------------------------------
// Scheduled syncs cover the normal case; this is for when someone has just
// changed something in their cloud account and wants to see it now rather than
// waiting for the next sweep.

// Every pull is a metered Cost Explorer call, and the provider republishes its
// own figures only a few times a day — so below this the button would spend
// money to redisplay the numbers already on screen. The server enforces the
// same floor; this copy exists to disable the control rather than let someone
// click into a refusal.
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

let refreshTimer = null;

function msUntilRefreshable() {
  const last = new Date(currentAccount.sync).getTime();
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + REFRESH_COOLDOWN_MS - Date.now());
}

function setupRefreshButton() {
  const btn = document.getElementById('acc-refresh-btn');
  if (!btn || !currentAccount) return;

  // Nothing to pull for sample data, and forcing a pull spends the tenant's
  // metered API budget. The server enforces it; this avoids a certain 403.
  btn.hidden = currentAccount.dataSource !== 'live' || !canRefresh();
  if (btn.hidden) return;

  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', doForcedRefresh);
  }
  applyRefreshCooldown();
}

// Re-enables itself the moment the window passes, so someone who leaves the
// page open doesn't have to reload to get the button back.
function applyRefreshCooldown() {
  const btn = document.getElementById('acc-refresh-btn');
  const label = document.getElementById('acc-refresh-label');
  if (!btn || !label || btn.hidden || btn.classList.contains('is-busy')) return;

  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  const waitMs = msUntilRefreshable();
  if (waitMs <= 0) {
    btn.disabled = false;
    btn.title = 'Pull the latest cost data from your cloud provider now';
    label.textContent = 'Refresh now';
    return;
  }

  const mins = Math.ceil(waitMs / 60000);
  btn.disabled = true;
  btn.title = `Cost data was just pulled. Each pull is a billed provider API call, so refreshing is limited to once every ${REFRESH_COOLDOWN_MS / 60000} minutes.`;
  label.textContent = `Refresh in ${mins} min`;

  // Tick just past the next whole minute so the countdown never reads stale.
  refreshTimer = setTimeout(applyRefreshCooldown, Math.min(waitMs, 60000 - (Date.now() % 60000)) + 1000);
}

function showRefreshNote(text, isError) {
  const note = document.getElementById('acc-refresh-note');
  if (!note) return;
  note.hidden = false;
  note.textContent = text;
  note.classList.toggle('is-error', !!isError);
}

async function doForcedRefresh() {
  const btn = document.getElementById('acc-refresh-btn');
  const label = document.getElementById('acc-refresh-label');
  if (btn.disabled) return;

  btn.disabled = true;
  btn.classList.add('is-busy');
  label.textContent = 'Refreshing…';
  showRefreshNote('Pulling from your cloud provider…', false);

  try {
    const res = await refreshAccount(currentAccount.id, { force: true });
    if (res.refreshed) {
      // Every panel on this page derives from the same stored snapshot, so
      // re-reading them piecemeal risks a half-updated page.
      window.location.reload();
      return;
    }

    // Not an error: the provider publishes cost data only a few times a day,
    // so an honest "nothing new yet" beats a spinner that changes nothing.
    if (res.sync) currentAccount.sync = res.sync;
    showRefreshNote(refreshBlockedMessage(res), false);
  } catch (err) {
    showRefreshNote(err.message || "Couldn't refresh — try again.", true);
  } finally {
    btn.classList.remove('is-busy');
    applyRefreshCooldown();
  }
}

function refreshBlockedMessage(res) {
  if (res.nextEligibleAt) {
    const waitMs = new Date(res.nextEligibleAt).getTime() - Date.now();
    if (waitMs > 0) {
      const mins = Math.ceil(waitMs / 60000);
      return `Already up to date — next refresh in ${mins} min${mins === 1 ? '' : 's'}.`;
    }
  }
  return res.reason || 'Already up to date.';
}

// /me may resolve after the account does, or before it.
// Idempotent: whichever of /me and /accounts/{id} lands second calls this, and
// on a rename it runs again — so the listener is bound once and the visibility
// re-derived every time.
let renameBound = false;
function setupRename() {
  const btn = document.getElementById('acc-name-edit');
  if (!btn || !currentAccount) return;

  btn.hidden = !CM_canRenameAccount();
  if (renameBound) return;
  renameBound = true;

  btn.addEventListener('click', () => {
    CM_openRenameAccount(currentAccount, (name) => {
      document.getElementById('acc-name').textContent = name;
      document.title = `CloudMeter — ${name}`;
      // Both carry the account name in their copy.
      renderManagedLine();
      setupAccountNotifications();
    });
  });
}

document.addEventListener('cm-me-loaded', () => {
  setupRename();
  renderOwnerLine();
  renderManagedLine();
  setupRefreshButton();
  setupAccountNotifications();
});

/**
 * Strips the cards an adhoc account has no data for.
 *
 * A hand-entered subscription has no tags, no regions, and no daily figures —
 * only monthly snapshots are written for it. Left in place these cards render
 * as permanently empty, which reads as a broken page rather than a deliberate
 * one. The monthly chart stays: it is the one view of these figures the
 * Subscriptions card doesn't already give.
 *
 * Cost by service goes too, which is a different reason. It isn't empty — each
 * subscription is stored as a service, so it renders fine — it's that the
 * Subscriptions card above it already lists the same names at the same costs,
 * and a second copy in a different order only invites the reader to work out
 * why the two disagree. It stays for polled providers, where a service really
 * is a different thing from an account.
 */
/**
 * Month-end at the rate this account has actually been spending.
 *
 * Divided by the days the figure covers, not by today's date. `spend` only
 * contains days the provider has reported, and they report a day behind — so
 * every morning today sat in the divisor having contributed nothing, and the
 * projection read low by a day's worth. ACME on 6 October: $53.48 across
 * five reported days shown as $276 rather than $332, because it was divided
 * by six.
 *
 * The page cannot work the divisor out for itself — it is handed one total
 * with no notion of how many days made it — so the server sends `coveredDays`.
 * Anything missing or unusable falls back to the calendar day, which is what
 * this did for every response until now.
 */
function projectedMonthEnd(spend, coveredDays, dayOfMonth, daysInMonth) {
  const covered = Number.isFinite(coveredDays) && coveredDays > 0 ? coveredDays : dayOfMonth;
  if (!(covered > 0)) return spend;
  return (spend / covered) * daysInMonth;
}

function applyAdhocLayout() {
  ['breakdown-section', 'region-section', 'compare-section', 'daily-section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  /*
   * A Member sees their own subscriptions here and nothing else.
   *
   * Everything above and below the list is built from the account's stored
   * totals, which are the whole workspace's — the same six-month snapshots the
   * roll-up reads. Showing a Member one line and a chart of the team's spend
   * would be worse than showing them no chart: the two would disagree and the
   * bigger number would look like theirs.
   *
   * Recomputing those figures per viewer was the alternative. It was not worth
   * it for a card that would say "you pay $20" in three different ways.
   */
  if ((window.CM_ME || {}).role === 'member') {
    ['stat-grid-section', 'monthly-section'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    return;
  }

  // "Untagged spend" is a question about cloud resources, not about whether
  // someone typed a tag on a ChatGPT seat.
  //
  // "Projected month-end" goes for a different reason: a subscription charges
  // in full on its renewal date, so the projection equals the figure in the
  // tile beside it. Two tiles showing the same number invite the reader to
  // look for the difference between them.
  ['stat-untagged', 'stat-projected'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.closest('.stat-tile')) el.closest('.stat-tile').style.display = 'none';
  });

  // Nothing is projected on an adhoc account: a subscription charges in full on
  // its renewal date, so the month's figure is already complete and scaling it
  // up would invent spend nobody is billed for.
  const monthlySub = document.getElementById('monthly-sub');
  if (monthlySub) {
    monthlySub.textContent = 'Monthly spend for this account — what was charged in each month';
  }

  // "Month to date" describes a figure still accruing, which is what a cloud
  // bill does. These charges are already complete for the month, so the tile
  // says what it is holding. Adhoc only — a connected account really is a
  // running total.
  const spendTile = document.getElementById('stat-spend');
  const spendLabel = spendTile && spendTile.closest('.stat-tile')
    && spendTile.closest('.stat-tile').querySelector('.label');
  if (spendLabel) spendLabel.textContent = 'Current month spend';

  // No sub-line under it. The one that was here claimed subscriptions charge
  // the same every month, which an annual plan landing in its renewal month
  // alone plainly does not.
  const spendSub = document.getElementById('stat-spend-sub');
  if (spendSub) {
    spendSub.textContent = '';
    if (spendSub.closest('.row')) spendSub.closest('.row').style.display = 'none';
  }

  // The tile still holds the right figure — the dearest line — but "Top
  // service" was borrowing the vocabulary of the card just removed, and
  // nothing on this page calls these things services any more.
  const topTile = document.getElementById('stat-top-service');
  const topLabel = topTile && topTile.closest('.stat-tile')
    && topTile.closest('.stat-tile').querySelector('.label');
  if (topLabel) topLabel.textContent = 'Largest subscription';
}

/**
 * Re-reads everything a subscription edit just moved.
 *
 * Adding or removing a line rewrites six months of snapshots server-side, so
 * the stat tiles, the service breakdown and the monthly chart are all stale the
 * moment a write succeeds. Re-fetching is cheaper than a page reload and keeps
 * the card the reader is looking at exactly where it is.
 */
async function onAdhocChanged() {
  try {
    currentAccount = await findAccountById(currentAccount.id);
    document.getElementById('stat-spend').textContent = fmt(currentAccount.spend);

    // A Member has none of these cards, and the routes behind them are closed
    // to them. The subscriptions card has already repainted itself from its
    // own response, which is the only thing they can see change.
    if ((window.CM_ME || {}).role === 'member') return;

    const [svc, { months }] = await Promise.all([
      window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/services`),
      window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/history`),
    ]);
    const services = svc.services;
    currentComparisonDays = svc.comparisonDays ?? null;
    renderServiceCard(services);
    renderMonthlyStats(months);
    renderMonthlyChart(months, 'monthly-chart');
  } catch (e) {
    // The write itself succeeded — the card already shows the new list. Only
    // the surrounding figures are behind, and saying so is better than an
    // error that implies the edit was lost.
    console.error('Could not refresh totals after a subscription change', e);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Every cost tile on this page is formatted through CM_money.
  await window.CM_MeReady;
  const accountId = new URLSearchParams(window.location.search).get('id');
  if (!accountId) {
    window.location.replace('accounts.html');
    return;
  }

  try {
    currentAccount = await findAccountById(accountId);
  } catch (e) {
    window.location.replace('accounts.html');
    return;
  }

  const meta = PROVIDER_META[currentAccount.provider];
  const badge = document.getElementById('acc-provider-badge');
  badge.textContent = meta.badge;
  badge.style.background = meta.color;
  document.getElementById('acc-name').textContent = currentAccount.name;
  document.getElementById('acc-meta-static').textContent = `${meta.fullName} · ${currentAccount.externalId}`;
  setupRename();
  renderOwnerLine();
  renderManagedLine();
  setupRefreshButton();
  setupAccountNotifications();
  document.title = `CloudMeter — ${currentAccount.name}`;

  const isLive = currentAccount.dataSource === 'live';
  // Adhoc accounts hold hand-entered subscriptions rather than anything
  // fetched, so several cards on this page have no data behind them — see
  // applyAdhocLayout().
  const isAdhoc = currentAccount.provider === 'adhoc';

  // Live accounts re-pull Cost Explorer on view (the API itself rate-limits
  // how often that actually hits AWS), then we re-read the fresh account row.
  if (isLive) {
    try {
      const res = await refreshAccount(currentAccount.id);
      if (res.refreshed) currentAccount = await findAccountById(accountId);
      // That page-view pull resets the clock the manual button is gated on.
      applyRefreshCooldown();
    } catch (e) {
      console.error('Refresh failed', e);
    }
  }

  const isPending = currentAccount.status === 'syncing';
  const hasError = currentAccount.status === 'error';
  const statusPill = document.getElementById('acc-status-pill');
  // Only states worth acting on get a pill. "Live" is what every healthy
  // account is, so saying it adds nothing — the sync time below already tells
  // you the data is current.
  // "Sample data" is the label for a seeded demo account. An adhoc account's
  // figures are real money the business is paying — they just weren't fetched —
  // so it gets its own wording rather than being called a sample.
  statusPill.hidden = !isPending && !hasError && (isLive || isAdhoc);
  statusPill.className = `status-pill ${isPending ? 'pending' : ''}`;
  statusPill.innerHTML = isPending
    ? '<span class="dot"></span> Backfilling data…'
    : hasError
      ? `<span class="dot"></span> Sync failed`
      : isLive
        ? ''
        : '<span class="dot"></span> Sample data';
  if (hasError && currentAccount.lastSyncError) statusPill.title = currentAccount.lastSyncError;

  if (isPending) {
    document.getElementById('stat-grid-section').style.display = 'none';
    document.getElementById('breakdown-section').style.display = 'none';
    document.getElementById('monthly-section').style.display = 'none';
    document.getElementById('daily-section').style.display = 'none';
    document.getElementById('empty-state').style.display = 'block';
    return;
  }

  // Before the cost fetch, not after: the cards this strips are still showing
  // skeleton loaders at this point, and hiding them later means a shimmer on
  // tiles that were never going to be filled.
  if (isAdhoc) applyAdhocLayout();

  /*
   * Providers whose spend has no region behind it.
   *
   * A region is a property of a machine running somewhere. OpenAI bills per
   * token, WhatsApp per conversation and GCP's export here carries no region
   * column — none of them has a place to put on the card, so it only ever
   * showed an empty state. Hidden before the fetch, and the fetch skipped,
   * rather than asking a route that has nothing to answer with.
   */
  if (REGIONLESS_PROVIDERS.has(currentAccount.provider)) {
    document.getElementById('region-section').style.display = 'none';
  }

  // Before the cost fetch, like the adhoc layout above: these headings ship
  // with the generic wording, and retitling them after the cards have painted
  // would show "service" for a moment on a page that has no services.
  applyUnitWording(currentAccount.provider);

  /*
   * On an OpenAI account, "Cost by model" replaces both "Cost by service"
   * and "Cost by project": it is those two crossed, and holds everything
   * either one showed. Hidden here, before the fetch, so the two cards don't
   * paint their skeletons and then vanish. If the month turns out to have no
   * project split to build the replacement from, renderByModelCard puts them
   * back — an account page with no breakdown at all would be worse than the
   * two it had.
   */
  if (currentAccount.provider === 'openai') {
    document.getElementById('breakdown-section').style.display = 'none';
  }

  document.getElementById('stat-spend').textContent = fmt(currentAccount.spend);
  // Adhoc accounts get no sub-line at all — applyAdhocLayout has already
  // emptied it. The line that sat here said subscriptions charge the same every
  // month, which stopped being true the day annual plans began landing in their
  // renewal month alone.
  if (!isAdhoc) {
    document.getElementById('stat-spend-sub').textContent =
      `Last synced ${new Date(currentAccount.sync).toLocaleString()}`;
  }

  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  // Run-rate projection assumes spend accrues through the month, which is true
  // of metered cloud usage and false of a subscription. The tile is hidden
  // altogether for adhoc (see applyAdhocLayout) rather than shown repeating the
  // figure to its left.
  if (!isAdhoc) {
    const covered = Number.isFinite(currentAccount.coveredDays) && currentAccount.coveredDays > 0
      ? currentAccount.coveredDays
      : dayOfMonth;
    document.getElementById('stat-projected').textContent =
      fmt(projectedMonthEnd(currentAccount.spend, currentAccount.coveredDays, dayOfMonth, daysInMonth));
    // Names the reported days rather than the date, so the caption cannot
    // claim six days for a figure built from five.
    document.getElementById('stat-projected-sub').textContent =
      `on pace, ${covered} of ${daysInMonth} days reported`;
  }

  /*
   * A Member on an adhoc account has no account-wide figures to fetch.
   *
   * These two routes answer with the whole workspace's totals, so they are
   * closed to a Member on these accounts — and the cards they feed were hidden
   * a few lines above anyway. Asking regardless would 404, and because the
   * fetch is awaited before the subscriptions card mounts, it would take that
   * card down with it: the Member would reach the page and find nothing to add
   * a subscription to, which is precisely the thing they came for.
   */
  const scopedAdhoc = isAdhoc && (window.CM_ME || {}).role === 'member';

  let months = [];
  if (!scopedAdhoc) {
    const [svc, history] = await Promise.all([
      window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/services`),
      window.CM_Api.get(`/accounts/${encodeURIComponent(currentAccount.id)}/cost/history`),
    ]);
    months = history.months;
    currentComparisonDays = svc.comparisonDays ?? null;
    renderServiceCard(svc.services);
  }

  if (isAdhoc) {
    // `?add=subscription` arrives from the Add Account flow, which lands here
    // the moment a tool is created. Stripped from the address bar first, so a
    // refresh or a shared link doesn't reopen the dialog forever.
    const params = new URLSearchParams(window.location.search);
    const addOnLoad = params.get('add') === 'subscription';
    if (addOnLoad) {
      params.delete('add');
      const q = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
    }
    await window.CM_Adhoc.mount(currentAccount, onAdhocChanged, { addOnLoad });
  } else {
    await loadAndRenderTagCard();
    // Skipped where the card is hidden above — the route would answer with an
    // empty list for a card nobody is going to see.
    if (!REGIONLESS_PROVIDERS.has(currentAccount.provider)) await loadAndRenderRegionCard();
  }

  const compareRange = isAdhoc ? null : document.getElementById('compare-range');
  if (compareRange) {
    compareRange.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        compareRange.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await loadAndRenderCompare(btn.dataset.days);
      });
    });
    await loadAndRenderCompare(compareRange.querySelector('button.active').dataset.days);
  }

  // Nothing to draw for a Member here — the chart is hidden and `months` was
  // never fetched. Drawing an empty one would replace the hidden card with a
  // visible "no data" state.
  if (!scopedAdhoc) {
    renderMonthlyStats(months);
    renderMonthlyChart(months, 'monthly-chart');
  }

  const dailyRange = isAdhoc ? null : document.getElementById('daily-range');
  if (dailyRange) {
    dailyRange.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        dailyRange.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await loadAndRenderDaily(btn.dataset.days);
      });
    });
    await loadAndRenderDaily(dailyRange.querySelector('button.active').dataset.days);
  }

  const serviceOverlay = document.getElementById('service-overlay');
  document.getElementById('service-modal-close').addEventListener('click', closeServiceModal);
  serviceOverlay.addEventListener('click', e => { if (e.target === serviceOverlay) closeServiceModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && serviceOverlay.classList.contains('show')) closeServiceModal(); });
});
