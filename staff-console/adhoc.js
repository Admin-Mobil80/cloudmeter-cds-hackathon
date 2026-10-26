// CloudMeter BMS — the AI tools and plan prices the Adhoc Spend form offers.
//
// Customers record what they pay for tools no billing API reports. Picking a
// tool and plan pre-fills the cost box from the figures here, so when a vendor
// reprices, this page is where that is corrected — no deploy, no engineer.
//
// Nothing here changes a cost a customer has already entered. It seeds a field
// and nothing more, which is why staff may edit it without being root.

let CATALOG = null;
let DEFAULTS = [];
let dirty = false;

/**
 * Which tools are open, by an ephemeral per-tool id.
 *
 * Not by array index: indices shift the moment a tool is added or removed, and
 * the wrong block would spring open. Not by key or label either — a new tool
 * has neither until it is named. `_uid` is assigned on load and never sent to
 * the server.
 */
const expanded = new Set();
let uidSeq = 0;
const uidFor = (tool) => {
  if (!tool._uid) tool._uid = `t${++uidSeq}`;
  return tool._uid;
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function stamp() {
  const el = document.getElementById('adhoc-stamp');
  if (!CATALOG) return;
  const n = CATALOG.tools.length;
  const count = `${n} tool${n === 1 ? '' : 's'}`;
  if (!CATALOG.updatedAt) {
    el.textContent = `${count} · never edited — showing the built-in list`;
    return;
  }
  const when = new Date(CATALOG.updatedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  el.textContent = `${count} · last edited by ${CATALOG.updatedBy || 'unknown'} on ${when}`;
}

function markDirty() {
  dirty = true;
  document.getElementById('adhoc-saved').textContent = 'Unsaved changes';
}

// ---- rendering ---------------------------------------------------------

function planRow(plan, ti, pi) {
  // The price is deliberately free to leave empty — an enterprise plan has no
  // single public figure, and 0 would claim it were free.
  const num = (v) => (v === null || v === undefined ? '' : esc(v));
  const money = (f, value, ph) => `<td><input class="field-input" data-f="${f}" type="number" min="0"
      step="0.01" inputmode="decimal" value="${num(value)}" placeholder="${ph}"></td>`;
  return `
    <tr data-tool="${ti}" data-plan="${pi}">
      <td><input class="field-input" data-f="name" maxlength="60" value="${esc(plan.name)}" placeholder="Pro"></td>
      ${money('usd', plan.usd, '—')}
      ${money('inr', (plan.prices || {}).INR, '—')}
      ${money('usdYear', plan.yearlyUsd, '—')}
      ${money('inrYear', (plan.yearlyPrices || {}).INR, '—')}
      <td><input class="field-input" data-f="note" maxlength="40" value="${esc(plan.note || '')}" placeholder="per seat"></td>
      <td><button class="btn btn-sm" data-remove-plan="${ti}:${pi}" aria-label="Remove ${esc(plan.name)}">×</button></td>
    </tr>`;
}

/** What a collapsed tool says about itself, so it stays useful shut. */
function planSummary(tool) {
  const n = tool.plans.length;
  if (!n) return 'No plans';
  const priced = tool.plans.map((p) => p.usd).filter((v) => v !== null && v !== undefined && v !== '');
  const count = `${n} plan${n === 1 ? '' : 's'}`;
  if (!priced.length) return count;
  const lo = Math.min(...priced.map(Number));
  const hi = Math.max(...priced.map(Number));
  return `${count} · ${lo === hi ? `$${lo}` : `$${lo}–$${hi}`}`;
}

function toolBlock(tool, ti) {
  const uid = uidFor(tool);
  const open = expanded.has(uid);
  return `
    <div class="adhoc-tool${open ? ' is-open' : ''}" data-tool-block="${ti}">
      <div class="adhoc-tool-head">
        <button class="adhoc-chev" data-toggle="${ti}" aria-expanded="${open}"
                aria-label="${open ? 'Hide' : 'Show'} plans for ${esc(tool.label || 'this tool')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <div>
          <label class="field-label" for="tool-name-${ti}">Tool</label>
          <input class="field-input" id="tool-name-${ti}" data-tool-f="label" data-tool="${ti}"
                 maxlength="60" value="${esc(tool.label)}" placeholder="Claude">
        </div>
        <div class="adhoc-alias">
          <label class="field-label" for="tool-alias-${ti}">Also known as <span class="muted">(comma separated)</span></label>
          <input class="field-input" id="tool-alias-${ti}" data-tool-f="aliases" data-tool="${ti}"
                 value="${esc((tool.aliases || []).join(', '))}" placeholder="anthropic, claude.ai">
        </div>
        <span class="adhoc-summary">${esc(planSummary(tool))}</span>
        <button class="btn btn-sm" data-remove-tool="${ti}">Remove tool</button>
      </div>

      <div class="adhoc-tool-body"${open ? '' : ' hidden'}>
      <table class="adhoc-plans">
        <thead>
          <tr><th>Plan</th>
              <th style="width:96px">USD<br><span class="muted" style="font-weight:500">per month</span></th>
              <th style="width:104px">INR<br><span class="muted" style="font-weight:500">per month, incl. GST</span></th>
              <th style="width:96px">USD<br><span class="muted" style="font-weight:500">per year</span></th>
              <th style="width:104px">INR<br><span class="muted" style="font-weight:500">per year, incl. GST</span></th>
              <th style="width:140px">Note</th><th style="width:44px"></th></tr>
        </thead>
        <tbody>
          ${tool.plans.map((p, pi) => planRow(p, ti, pi)).join('')
            || '<tr><td colspan="7" class="muted" style="padding:10px 2px">No plans yet.</td></tr>'}
        </tbody>
      </table>
      <button class="btn btn-sm" data-add-plan="${ti}">+ Add plan</button>
      </div>
    </div>`;
}

function render() {
  const wrap = document.getElementById('adhoc-editor');
  wrap.setAttribute('aria-busy', 'false');
  wrap.innerHTML = CATALOG.tools.length
    ? CATALOG.tools.map(toolBlock).join('')
    : `<div class="muted" style="padding:18px 2px">
         No tools. The customer's form will fall back to a plain text box for the plan name.
         <button class="btn btn-sm" id="adhoc-restore" style="margin-left:10px">Restore the built-in list</button>
       </div>`;
  stamp();

  document.getElementById('adhoc-restore')?.addEventListener('click', () => {
    CATALOG.tools = JSON.parse(JSON.stringify(DEFAULTS));
    markDirty();
    render();
  });
}

// ---- reading the form back --------------------------------------------

/**
 * Reads every field back into CATALOG.tools.
 *
 * Done wholesale on each change rather than binding per input: the editor is
 * one form saved in one request, and tracking which of a hundred inputs moved
 * buys nothing but a way for the two to disagree.
 */
function harvest() {
  const wrap = document.getElementById('adhoc-editor');

  wrap.querySelectorAll('[data-tool-f]').forEach((input) => {
    const t = CATALOG.tools[+input.dataset.tool];
    if (!t) return;
    if (input.dataset.toolF === 'label') t.label = input.value;
    else t.aliases = input.value.split(',').map((a) => a.trim()).filter(Boolean);
  });

  wrap.querySelectorAll('tr[data-plan]').forEach((tr) => {
    const t = CATALOG.tools[+tr.dataset.tool];
    const p = t && t.plans[+tr.dataset.plan];
    if (!p) return;
    const get = (f) => tr.querySelector(`[data-f="${f}"]`);
    p.name = get('name').value;
    // Empty stays null rather than becoming 0 — "no public price" and "free"
    // are different things, and 0 would put a free plan in front of someone
    // negotiating an enterprise contract. The same holds for a year's price:
    // most vendors never publish one, and blank says so.
    const usd = (f) => {
      const raw = get(f).value.trim();
      return raw === '' ? null : Number(raw);
    };
    p.usd = usd('usd');
    p.yearlyUsd = usd('usdYear');
    if (p.yearlyUsd === null) delete p.yearlyUsd;

    // The vendor's own rupee prices, as published — not a conversion of the
    // dollar box beside them. Left empty they are dropped entirely, and an
    // Indian customer is quoted the USD figure rather than an invented one.
    const localInto = (field, key) => {
      const raw = get(field).value.trim();
      const prices = { ...(p[key] || {}) };
      if (raw === '') delete prices.INR;
      else prices.INR = Number(raw);
      if (Object.keys(prices).length) p[key] = prices;
      else delete p[key];
    };
    localInto('inr', 'prices');
    localInto('inrYear', 'yearlyPrices');

    // The columns say which price is which, so there is no cadence to pick.
    // A plan sold only by the year is one with the monthly boxes left empty.
    p.cadence = 'monthly';
    p.note = get('note').value.trim() || null;
  });
}

// ---- save --------------------------------------------------------------

async function save() {
  harvest();
  const btn = document.getElementById('adhoc-save');
  const err = document.getElementById('adhoc-error');
  err.classList.remove('show');

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    // _uid is this page's own bookkeeping; the server has no use for it.
    const tools = CATALOG.tools.map(({ _uid, ...tool }) => tool);
    const saved = await window.CM_Api.put('/bms/adhoc-catalog', { tools });
    // The server sorts and normalises, so the returned tools are new objects
    // without _uid. Re-key the open set by label, which is the only thing that
    // survives the round trip, so sections do not all snap shut on save.
    const openLabels = new Set(
      CATALOG.tools.filter((t) => expanded.has(t._uid)).map((t) => t.label),
    );
    CATALOG = { ...CATALOG, ...saved };
    expanded.clear();
    CATALOG.tools.forEach((t) => { if (openLabels.has(t.label)) expanded.add(uidFor(t)); });
    dirty = false;
    document.getElementById('adhoc-saved').textContent = 'Saved';
    // Re-rendered from what the server stored, not from what was typed: it
    // sorts and normalises, and showing the typed version would leave the page
    // disagreeing with the next person to load it.
    render();
  } catch (e) {
    err.textContent = e.message || 'Could not save the catalogue.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await window.CM_Api.get('/bms/adhoc-catalog');
    DEFAULTS = res.defaults || [];
    CATALOG = { tools: res.tools || [], updatedAt: res.updatedAt, updatedBy: res.updatedBy };
  } catch (err) {
    window.CM_renderLoadError(err, 'adhoc-editor');
    return;
  }
  render();

  const wrap = document.getElementById('adhoc-editor');

  // Delegated: rows and blocks are rebuilt on every structural change, and
  // re-binding each time is how a handler ends up attached twice.
  wrap.addEventListener('input', markDirty);
  wrap.addEventListener('change', markDirty);

  wrap.addEventListener('click', (e) => {
    // Toggling is done in place rather than by re-rendering: a rebuild would
    // discard anything typed into the other tools' fields, and opening a
    // section is not an edit.
    const chev = e.target.closest('[data-toggle]');
    if (chev) {
      const block = chev.closest('[data-tool-block]');
      const tool = CATALOG.tools[+chev.dataset.toggle];
      const uid = uidFor(tool);
      const open = !expanded.has(uid);
      if (open) expanded.add(uid); else expanded.delete(uid);
      block.classList.toggle('is-open', open);
      block.querySelector('.adhoc-tool-body').hidden = !open;
      chev.setAttribute('aria-expanded', String(open));
      chev.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} plans for ${tool.label || 'this tool'}`);
      return;
    }

    const addPlan = e.target.closest('[data-add-plan]');
    const rmPlan = e.target.closest('[data-remove-plan]');
    const rmTool = e.target.closest('[data-remove-tool]');
    if (!addPlan && !rmPlan && !rmTool) return;

    // Harvest before any structural change — the edits sitting in the inputs
    // would otherwise be thrown away by the re-render.
    harvest();

    if (addPlan) {
      const t = CATALOG.tools[+addPlan.dataset.addPlan];
      t.plans.push({ name: '', usd: null, cadence: 'monthly', note: null });
      expanded.add(uidFor(t));
    } else if (rmPlan) {
      const [ti, pi] = rmPlan.dataset.removePlan.split(':').map(Number);
      CATALOG.tools[ti].plans.splice(pi, 1);
    } else {
      const t = CATALOG.tools[+rmTool.dataset.removeTool];
      if (!window.confirm(`Remove ${t.label || 'this tool'} and its plans from the list?`)) return;
      CATALOG.tools.splice(+rmTool.dataset.removeTool, 1);
    }
    markDirty();
    render();
  });

  document.getElementById('adhoc-add-tool').addEventListener('click', () => {
    harvest();
    const fresh = { key: '', label: '', aliases: [], plans: [{ name: '', usd: null, cadence: 'monthly', note: null }] };
    CATALOG.tools.push(fresh);
    expanded.add(uidFor(fresh));
    markDirty();
    render();
    // Straight into the new name field — it is the only thing that must be
    // filled for the tool to be savable.
    const inputs = document.querySelectorAll('[data-tool-f="label"]');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById('adhoc-save').addEventListener('click', save);

  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
});
