function trendEmptyState(message) {
  return `<div class="muted" style="display:flex;align-items:center;justify-content:center;
    height:260px;text-align:center;padding:0 24px;font-size:13.5px">${message}</div>`;
}

// Same height as the chart it replaces, so switching granularity doesn't make
// the card collapse and the page jump under the cursor.
function renderTrendLoading(message) {
  const container = document.getElementById('trend-chart');
  const legend = document.getElementById('trend-legend');
  if (!container) return;
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:260px;gap:14px">
      <div class="spinner"></div>
      <div class="muted" style="font-size:13px">${message || 'Loading cost data…'}</div>
    </div>`;
  if (legend) legend.innerHTML = '';
}

// Picks a gridline step that divides the axis into `ticks` equal, readable
// parts. A fixed $100 step was fine for monthly totals but useless for a 7-day
// view of a small account, where every bar sat in the bottom sliver of the
// plot — and dividing an arbitrary maximum by 4 gave labels like $38 and $113.
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceAxisMax(rawMax, ticks) {
  const target = (rawMax * 1.05) / ticks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const normalised = target / magnitude;
  const chosen = NICE_STEPS.find((c) => c >= normalised) ?? 10;
  // Sub-dollar steps would render as a column of identical rounded labels.
  const step = Math.max(1, chosen * magnitude);
  return step * ticks;
}

function providerMetaFor(key) {
  return TREND_PROVIDER_META[key] ?? { name: key, hex: '#898781' };
}

// `emptyMessage` lets the caller explain the specific reason there's nothing
// to plot — "no accounts connected" and "accounts connected, no data for this
// window" are very different situations and shouldn't share one message.
function renderTrendChart(trend, emptyMessage) {
  const container = document.getElementById('trend-chart');
  const legend = document.getElementById('trend-legend');
  if (!container) return;

  const labels = trend?.labels ?? [];
  const series = (trend?.series ?? []).filter(s => s.values.some(v => v > 0));

  if (!labels.length || !series.length) {
    container.innerHTML = trendEmptyState(
      emptyMessage || 'No cost data yet. Connect a cloud account to start building a spend trend.'
    );
    if (legend) legend.innerHTML = '';
    return;
  }

  const points = labels.length;
  const W = 900, H = 260, padL = 56, padR = 12, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Each period's spend is one column split by provider. Stacked rather than
  // grouped: the total is the number people read first, and stacking keeps the
  // bar height equal to it however many providers are connected.
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const rawMax = Math.max(...totals, 0);
  const ticks = 4;
  const maxV = rawMax > 0 ? niceAxisMax(rawMax, ticks) : 100;

  const slot = plotW / points;
  const barW = Math.max(2, Math.min(38, slot * 0.62));
  const cx = i => padL + slot * i + slot / 2;
  const y = v => padT + plotH - (v / maxV) * plotH;

  let gridlines = '', axisLabels = '', xAxisLabels = '', bars = '', hitAreas = '';
  for (let t = 0; t <= ticks; t++) {
    const v = (maxV / ticks) * t;
    const yy = y(v);
    gridlines += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--gridline)" stroke-width="1"/>`;
    axisLabels += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${CM_money(v, { decimals: 0 })}</text>`;
  }

  // 30 or 90 daily labels can't fit side by side, so only every Nth is drawn —
  // aiming for ~8 across any window. The newest is always labelled, since
  // that's the one being read.
  const labelStep = Math.max(1, Math.ceil(points / 8));
  labels.forEach((l, i) => {
    const isLast = i === points - 1;
    if (i % labelStep !== 0 && !isLast) return;
    // Skip a label that would collide with the always-drawn last one.
    if (!isLast && points - 1 - i < labelStep * 0.6) return;
    xAxisLabels += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${l}</text>`;
  });

  // Today's column is outlined rather than filled: the provider hasn't posted
  // the full day yet, so a solid short bar would read as a real drop in spend.
  const partial = trend?.partialFlags ?? [];

  labels.forEach((_, i) => {
    let cursor = 0;
    series.forEach(s => {
      const v = s.values[i] ?? 0;
      if (v <= 0) return;
      const meta = providerMetaFor(s.provider);
      const yTop = y(cursor + v);
      const h = Math.max(1, y(cursor) - yTop);
      bars += partial[i]
        ? `<rect x="${(cx(i) - barW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="none" stroke="${meta.hex}" stroke-width="1.5" stroke-dasharray="3,2"/>`
        : `<rect x="${(cx(i) - barW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${series.length > 1 ? 0 : 2}" fill="${meta.hex}"/>`;
      cursor += v;
    });
    hitAreas += `<rect data-i="${i}" x="${(cx(i) - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>`;
  });

  container.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="260" id="chart-svg" role="img" aria-label="Cost by period, split by provider">
    ${gridlines}${axisLabels}${xAxisLabels}${bars}
    <line id="crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3" opacity="0"/>
    ${hitAreas}
  </svg>
  <div id="chart-tooltip" class="chart-tooltip" style="opacity:0"></div>`;

  if (legend) {
    legend.innerHTML = series.map(s => {
      const meta = providerMetaFor(s.provider);
      return `<span class="legend-item"><span class="legend-swatch" style="background:${meta.hex}"></span>${meta.name}</span>`;
    }).join('');
  }

  const tooltip = document.getElementById('chart-tooltip');
  const crosshair = document.getElementById('crosshair');

  container.querySelectorAll('rect[data-i]').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const i = +rect.getAttribute('data-i');
      crosshair.setAttribute('x1', cx(i));
      crosshair.setAttribute('x2', cx(i));
      crosshair.setAttribute('opacity', '1');

      const rows = series.map(s => {
        const meta = providerMetaFor(s.provider);
        return `<div class="tt-row"><span class="tt-dot" style="background:${meta.hex}"></span><span class="tt-name">${meta.name}</span><span class="tt-val">${CM_money(s.values[i] ?? 0, { decimals: 0 })}</span></div>`;
      }).join('');
      // With one provider the total would just repeat the single row.
      const totalRow = series.length > 1
        ? `<div class="tt-row" style="border-top:1px solid rgba(255,255,255,0.18);margin-top:4px;padding-top:5px">
             <span class="tt-name">Total</span><span class="tt-val">${CM_money(totals[i], { decimals: 0 })}</span></div>`
        : '';
      const head = partial[i] ? `${labels[i]} (partial — still reporting)` : labels[i];
      tooltip.innerHTML = `<div class="tt-head">${head}</div>${rows}${totalRow}`;
      tooltip.style.opacity = '1';
      // Positioned by bar centre, clamped so the tooltip can't run off either
      // edge of the card.
      const centrePct = ((cx(i) - padL) / plotW) * 100;
      tooltip.style.left = `${Math.min(78, Math.max(0, centrePct - 12))}%`;
    });
    rect.addEventListener('mouseleave', () => {
      crosshair.setAttribute('opacity', '0');
      tooltip.style.opacity = '0';
    });
  });
}
