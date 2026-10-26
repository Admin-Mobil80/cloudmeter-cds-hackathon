// CloudMeter BMS — the revenue ledger: every payment, refund and failed charge.

let TXNS = [];
let TOTALS = {};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const SYMBOL = { INR: '₹', USD: '$' };

function money(amount, currency) {
  const cur = (currency || 'INR').toUpperCase();
  return (SYMBOL[cur] || `${cur} `)
    + Number(amount || 0).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function renderTotals() {
  const el = document.getElementById('txn-totals');
  el.setAttribute('aria-busy', 'false');

  const currencies = Object.keys(TOTALS);
  if (!currencies.length) {
    el.innerHTML = '<p class="muted" style="margin:0">Nothing collected yet. Rows appear here as gateways report payments.</p>';
    return;
  }

  el.innerHTML = `<div class="txn-totals">${currencies.map(cur => {
    const t = TOTALS[cur];
    return `<div class="txn-total">
      <div class="txn-total-cur">${esc(cur)}</div>
      <div class="txn-total-amt">${money(t.collected, cur)}</div>
      <div class="txn-total-sub">
        ${t.count} transaction${t.count === 1 ? '' : 's'}
        ${t.refunded ? ` · ${money(t.refunded, cur)} refunded` : ''}
        ${t.failed ? ` · ${money(t.failed, cur)} failed` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// A refund is money going out and a failure is money that never arrived, so
// neither is shown in the same weight as a successful charge.
const KIND_CLASS = { payment: 'is-ok', refund: 'is-refund', failed: 'is-failed' };
const KIND_LABEL = { payment: 'Paid', refund: 'Refunded', failed: 'Failed' };

function renderRows() {
  const body = document.getElementById('txn-body');
  body.setAttribute('aria-busy', 'false');

  const q = (document.getElementById('txn-filter').value || '').trim().toLowerCase();
  const rows = q
    ? TXNS.filter(t => [t.tenantName, t.planId, t.gateway, t.method, t.gatewayPaymentId]
        .some(v => String(v ?? '').toLowerCase().includes(q)))
    : TXNS;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted">${
      TXNS.length ? 'No transactions match that filter.'
        : 'No transactions yet. They appear here as soon as a gateway reports one.'
    }</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(t => {
    // The tax split is shown only when it was actually charged — a dollar
    // payment has no GST line, and printing "+ $0 tax" would imply one exists.
    const taxLine = t.tax
      ? `<span class="d">${money(t.subtotal, t.currency)} + ${money(t.tax, t.currency)} GST</span>`
      : '';
    return `
    <tr>
      <td>${esc(when(t.occurredAt))}</td>
      <td><span class="bms-name">${esc(t.tenantName)}</span></td>
      <td>${t.planId ? esc(t.planId) : '<span class="d">—</span>'}</td>
      <td class="num"><span class="bms-ends">${money(t.amount, t.currency)}</span>${taxLine}</td>
      <td><span class="txn-pill ${KIND_CLASS[t.kind] || ''}">${esc(KIND_LABEL[t.kind] || t.kind)}</span></td>
      <td>${esc(t.gateway)}${t.method ? `<span class="d">${esc(t.method)}</span>` : ''}</td>
      <td><code class="txn-ref">${esc(t.gatewayPaymentId)}</code></td>
    </tr>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await window.CM_Api.get('/bms/transactions');
    TXNS = data.transactions || [];
    TOTALS = data.totals || {};
  } catch (e) {
    document.getElementById('txn-body').innerHTML =
      `<tr><td colspan="7" class="muted">Couldn't load transactions — ${esc(e.message || '')}</td></tr>`;
    document.getElementById('txn-totals').innerHTML = '';
    return;
  }
  renderTotals();
  renderRows();
  document.getElementById('txn-filter').addEventListener('input', renderRows);
});
