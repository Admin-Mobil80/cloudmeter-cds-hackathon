// CloudMeter BMS — the account list and the manual subscription editor.

let TENANTS = [];
let PLANS = [];
// The configured free-trial length, from the same /plans catalogue the cards
// render from — so "Extend trial by N days" always names the number the
// server will actually apply, whatever it was changed to in Plans.
let TRIAL_DAYS = 7;

function money(n) { return `$${Math.round(n || 0).toLocaleString()}`; }

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function relative(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return 'never';
  if (mins < 60) return `${Math.max(mins, 0)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * How a tenant is paying, in one phrase.
 *
 * "Manual" is called out rather than dressed up as a subscription: an account
 * onboarded outside Stripe has no payment behind it, and whoever is looking at
 * this list is the person who needs to know that.
 */
function planCell(t) {
  const s = t.subscription;
  if (!s.planId) return '<span class="bms-plan is-none">Trial / no plan</span>';
  return `<span class="bms-plan">${esc(s.planName || s.planId)}</span>`
    + `<span class="bms-plan-meta">${s.manual ? 'manual' : 'Stripe'}</span>`;
}

/**
 * The end date, with how long is left.
 *
 * Days remaining is the number anyone renewing accounts actually acts on, and
 * expiry is called out in red rather than left to be worked out from a date.
 */
function endsCell(t) {
  const s = t.subscription;

  // A trial is a period with an end date like any other, so it shows one.
  // Leaving it blank made every trial look like an account nobody had to
  // think about, which is the opposite of true.
  if (!s.planId) {
    const trialEnd = s.trialEndsAt || t.trialEndsAt;
    if (!trialEnd) return '<span class="d">—</span>';
    const d = Math.ceil((new Date(trialEnd).getTime() - Date.now()) / 86400000);
    return `<span class="bms-ends${d < 0 ? ' is-expired' : d <= 3 ? ' is-soon' : ''}">${esc(shortDate(trialEnd))}</span>`
      + `<span class="d">${d < 0 ? `trial ended ${Math.abs(d)}d ago` : d === 0 ? 'trial ends today' : `trial · ${d}d left`}</span>`;
  }

  // Every subscription is meant to carry one. Flagged rather than described as
  // "open-ended", which read like a valid state instead of a gap to close.
  if (!s.currentPeriodEnd) {
    return '<span class="bms-ends is-expired">Not set</span><span class="d">needs an end date</span>';
  }

  const when = new Date(s.currentPeriodEnd);
  const days = Math.ceil((when.getTime() - Date.now()) / 86400000);
  const cls = days < 0 ? ' is-expired' : days <= 14 ? ' is-soon' : '';
  return `<span class="bms-ends${cls}">${esc(shortDate(s.currentPeriodEnd))}</span>`
    + `<span class="d">${days < 0 ? `expired ${Math.abs(days)}d ago` : days === 0 ? 'expires today' : `${days}d left`}</span>`;
}

function renderStats() {
  const paying = TENANTS.filter(t => t.subscription.entitled);
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('stat-tenants', TENANTS.length);
  set('stat-tenants-sub', `${TENANTS.filter(t => t.cloudAccounts > 0).length} with cloud accounts connected`);
  set('stat-paying', paying.length);
  set('stat-paying-sub', `${paying.filter(t => t.subscription.manual).length} onboarded manually`);
  set('stat-accounts', TENANTS.reduce((s, t) => s + t.cloudAccounts, 0));
  set('stat-accounts-sub', `${TENANTS.reduce((s, t) => s + t.liveAccounts, 0)} pulling live cost data`);
  set('stat-spend', money(TENANTS.reduce((s, t) => s + t.managedSpendUsd, 0)));
}

function renderList(filter = '') {
  const list = document.getElementById('tenant-list');
  const q = filter.trim().toLowerCase();
  const rows = q
    ? TENANTS.filter(t => `${t.name || ''} ${t.ownerEmail || ''} ${t.ownerName || ''}`.toLowerCase().includes(q))
    : TENANTS;

  list.removeAttribute('aria-busy');
  if (rows.length === 0) {
    list.innerHTML = `<p class="muted" style="padding:28px;text-align:center">
      ${q ? 'No accounts match that filter.' : 'No CloudMeter accounts yet.'}</p>`;
    return;
  }

  list.innerHTML = `
    <div class="bms-row bms-head">
      <span>Account</span><span>Owner</span><span class="num">Members</span>
      <span class="num">Cloud a/cs</span><span class="num">Spend</span>
      <span>Plan</span><span>Slack</span><span>Subscription ends</span><span>Last active</span><span></span>
    </div>`
    + rows.map(t => `
    <div class="bms-row" data-tenant="${esc(t.tenantId)}">
      <span>
        <span class="n">${esc(t.name || 'Unnamed')}</span>
        <span class="d">since ${esc(shortDate(t.createdAt) || '—')}</span>
      </span>
      <span>
        <span class="n">${esc(t.ownerName || '—')}</span>
        <span class="d">${esc(t.ownerEmail || '')}</span>
      </span>
      <span class="num">${t.members}</span>
      <span class="num">${t.cloudAccounts}<span class="d">${t.liveAccounts} live</span></span>
      <span class="num">${money(t.managedSpendUsd)}</span>
      <span>${planCell(t)}</span>
      <span>${slackCell(t)}</span>
      <span>${endsCell(t)}</span>
      <span class="d">${esc(relative(t.lastActiveAt))}</span>
      <span><button class="btn btn-sm" data-edit="${esc(t.tenantId)}">Change</button></span>
    </div>`).join('');

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditor(btn.dataset.edit));
  });
}

/**
 * Whether a workspace has Slack, and whether anyone is actually receiving it.
 *
 * Three states worth telling apart, because they need different responses:
 * never set up, set up but nobody followed through, and working. The middle
 * one is invisible from anywhere else — an admin installs CloudMeter, nobody
 * clicks Connect, and the workspace looks equipped while receiving nothing.
 *
 * `installed: null` means Secrets Manager could not be read. Said as unknown
 * rather than shown as "no", which would read as a fact.
 */
function slackCell(t) {
  const s = t.slack;
  if (!s) return '<span class="d">—</span>';
  if (s.installed === null) return '<span class="d" title="Could not read Slack installs">unknown</span>';
  if (!s.installed) return '<span class="d">—</span>';
  if (!s.connectedMembers) {
    return '<span class="d" title="Installed, but nobody has connected themselves">set up · 0 on it</span>';
  }
  const n = s.connectedMembers;
  return `<span class="n">${n} on it</span>`;
}

/**
 * Sets a plan and end date by hand.
 *
 * This is the path for accounts onboarded outside Stripe — an invoice, a
 * pilot. It writes the same fields Stripe's webhook writes, so the portal
 * enforces and displays one set of values whatever set them.
 */
function openEditor(tenantId) {
  const t = TENANTS.find(x => x.tenantId === tenantId);
  if (!t) return;

  const isRoot = (window.BMS_ME || {}).role === 'root';
  const s = t.subscription;

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>${esc(t.name || 'Unnamed account')}</h2>
    <p class="modal-sub">${esc(t.ownerEmail || '')} · ${t.cloudAccounts} cloud account${t.cloudAccounts === 1 ? '' : 's'} · ${money(t.managedSpendUsd)} monitored this month</p>

    <label class="field-label" for="edit-plan" style="margin-top:14px">Plan</label>
    <select class="field-input" id="edit-plan">
      <option value="">No plan (trial)</option>
      ${PLANS.map(p => `<option value="${esc(p.id)}"${p.id === s.planId ? ' selected' : ''}>${esc(p.name)} — $${p.priceUsd}/mo</option>`).join('')}
    </select>

    <label class="field-label" style="margin-top:14px">${s.planId ? 'Subscription ends' : 'Trial ends'}</label>
    <div class="readonly-row">
      <span class="readonly-value" id="edit-end-display">${
        s.planId
          ? (s.currentPeriodEnd ? esc(shortDate(s.currentPeriodEnd)) : '—')
          : (s.trialEndsAt ? esc(shortDate(s.trialEndsAt)) : '—')
      }</span>
      ${s.planId
        ? '<button class="btn btn-sm" data-renew type="button">Renew for another month</button>'
        : `<button class="btn btn-sm" data-renew-trial type="button">Extend trial by ${TRIAL_DAYS} day${TRIAL_DAYS === 1 ? '' : 's'}</button>`}
    </div>
    <p class="notify-note">${s.planId
      ? "Always one month from the start, so it isn't editable. Renewing extends it by a month — from the current end date if that hasn't passed, so no paid days are lost."
      : `Set from the trial length when the account was created, so it isn't editable. Extending adds another ${TRIAL_DAYS} days — from the current end if it hasn't passed, otherwise from today.`}</p>

    ${s.stripeCustomerId ? `<p class="field-error show" style="margin-top:12px">This account has a Stripe customer record.
      A change here is overwritten the next time Stripe sends an update — settle it in Stripe instead.</p>` : ''}

    <p class="field-error" id="edit-error"></p>
    <div class="modal-actions">
      ${isRoot ? '<button class="btn btn-danger" data-delete style="margin-right:auto">Delete account…</button>' : ''}
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-delete]')?.addEventListener('click', () => { close(); openDelete(t); });

  dlg.querySelector('[data-renew-trial]')?.addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-renew-trial]');
    const err = dlg.querySelector('#edit-error');
    btn.disabled = true;
    btn.textContent = 'Extending…';
    try {
      const res = await window.CM_Api.put(
        `/bms/tenants/${encodeURIComponent(tenantId)}/subscription`, { action: 'renew-trial' });
      dlg.querySelector('#edit-end-display').textContent = shortDate(res.trialEndsAt);
      btn.textContent = 'Extended ✓';
      await load();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = `Extend trial by ${TRIAL_DAYS} days`;
      err.textContent = e.message || 'Could not extend that trial.';
      err.classList.add('show');
    }
  });

  dlg.querySelector('[data-renew]')?.addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-renew]');
    const err = dlg.querySelector('#edit-error');
    btn.disabled = true;
    btn.textContent = 'Renewing…';
    try {
      const res = await window.CM_Api.put(
        `/bms/tenants/${encodeURIComponent(tenantId)}/subscription`, { action: 'renew' });
      dlg.querySelector('#edit-end-display').textContent = shortDate(res.currentPeriodEnd);
      btn.textContent = 'Renewed ✓';
      // The row behind the dialog still shows the old date until the list
      // reloads, so refresh it rather than leaving the two disagreeing.
      await load();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Renew for another month';
      err.textContent = e.message || 'Could not renew that subscription.';
      err.classList.add('show');
    }
  });
  dlg.querySelector('[data-save]').addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-save]');
    const err = dlg.querySelector('#edit-error');
    const planId = dlg.querySelector('#edit-plan').value || null;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // No date is sent: the server derives it. Setting or changing a plan
      // starts a fresh month; extending one is the Renew button.
      await window.CM_Api.put(`/bms/tenants/${encodeURIComponent(tenantId)}/subscription`, { planId });
      close();
      await load();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save';
      err.textContent = e.message || 'Could not save that.';
      err.classList.add('show');
    }
  });
}

/**
 * Creates a CloudMeter account for a business that hasn't signed up.
 *
 * The self-serve path makes a tenant as a side effect of somebody signing up.
 * This is the sales path: the account exists before its owner has ever visited,
 * their portal login is provisioned, and a plan can be set at the same time —
 * which is the whole point for accounts billed outside Stripe.
 */
function openOnboard() {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Onboard a business</h2>
    <p class="modal-sub">Creates the CloudMeter account and its owner's sign-in, and emails them.
      They sign in with a one-time code — no password, and no sign-up step.</p>

    <label class="field-label" for="ob-business">Business / organisation name</label>
    <input class="field-input" id="ob-business" placeholder="Acme Logistics" maxlength="80">

    <label class="field-label" for="ob-owner-name" style="margin-top:12px">Owner name</label>
    <input class="field-input" id="ob-owner-name" placeholder="Preeti Nair" maxlength="80">

    <label class="field-label" for="ob-owner-email" style="margin-top:12px">Owner email</label>
    <input class="field-input" type="email" id="ob-owner-email" placeholder="preeti@acme.com">

    <label class="field-label" for="ob-plan" style="margin-top:12px">Plan</label>
    <select class="field-input" id="ob-plan">
      <option value="">No plan — free trial</option>
      ${PLANS.map(p => `<option value="${esc(p.id)}">${esc(p.name)} — $${p.priceUsd}/mo</option>`).join('')}
    </select>

    <p class="notify-note" style="margin-top:12px">With a plan, the subscription runs one month from today and is extended by renewing. Without one, the account starts on the free trial.</p>

    <p class="field-error" id="ob-error"></p>
    <div class="modal-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-create>Create account</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('#ob-business').focus();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-create]').addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-create]');
    const err = dlg.querySelector('#ob-error');
    const businessName = dlg.querySelector('#ob-business').value.trim();
    const ownerName = dlg.querySelector('#ob-owner-name').value.trim();
    const ownerEmail = dlg.querySelector('#ob-owner-email').value.trim().toLowerCase();
    const planId = dlg.querySelector('#ob-plan').value || null;

    if (!businessName) { err.textContent = 'Enter the business name.'; err.classList.add('show'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      err.textContent = 'Enter a valid owner email.'; err.classList.add('show'); return;
    }
    err.classList.remove('show');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      // No date sent — the server derives one month from now when a plan is set.
      await window.CM_Api.post('/bms/tenants', { businessName, ownerName, ownerEmail, planId });
      close();
      await load();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Create account';
      err.textContent = e.message || 'Could not create that account.';
      err.classList.add('show');
    }
  });
}

/**
 * Purges a CloudMeter account.
 *
 * Separate from the edit dialog on purpose: nobody should reach an
 * irreversible action by tabbing through a form. The business name has to be
 * typed, which forces a look at exactly what is about to be destroyed.
 */
function openDelete(t) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Delete ${esc(t.name || 'this account')}?</h2>
    <p class="modal-sub">This removes the CloudMeter account, its ${t.members} member${t.members === 1 ? '' : 's'},
      ${t.cloudAccounts} connected cloud account${t.cloudAccounts === 1 ? '' : 's'}, all stored provider credentials
      and all cost history. It cannot be undone, and the owner is not asked first.</p>
    <p class="modal-sub">Use this for lapsed customers who never closed their own account —
      holding their cloud credentials indefinitely is a liability.</p>

    <label class="field-label" for="del-confirm">Type <strong>${esc(t.name || '')}</strong> to confirm</label>
    <input class="field-input" id="del-confirm" autocomplete="off" placeholder="${esc(t.name || '')}">
    <p class="field-error" id="del-error"></p>
    <div class="modal-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-danger" data-confirm>Delete permanently</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('#del-confirm').focus();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-confirm]').addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-confirm]');
    const err = dlg.querySelector('#del-error');
    const confirmName = dlg.querySelector('#del-confirm').value.trim();
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await window.CM_Api.request(`/bms/tenants/${encodeURIComponent(t.tenantId)}`, {
        method: 'DELETE', body: JSON.stringify({ confirmName }),
      });
      close();
      await load();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Delete permanently';
      // A live subscription is refused rather than silently allowed; say what
      // to do about it instead of just refusing.
      err.textContent = e.status === 409
        ? `${e.message} Set the plan to "No plan" first.`
        : (e.message || 'Could not delete that account.');
      err.classList.add('show');
    }
  });
}

async function load() {
  const [tenantsRes, plansRes] = await Promise.all([
    window.CM_Api.get('/bms/tenants'),
    fetch(`${window.CM_CONFIG.apiUrl}/plans`).then(r => r.json()),
  ]);
  TENANTS = tenantsRes.tenants;
  PLANS = plansRes.plans;
  if (Number.isFinite(plansRes.trialDays)) TRIAL_DAYS = plansRes.trialDays;
  renderStats();
  renderList(document.getElementById('tenant-filter').value);
}

document.addEventListener('bms-me-loaded', async () => {
  try {
    await load();
  } catch (err) {
    document.getElementById('tenant-list').innerHTML =
      `<p class="muted" style="padding:28px;text-align:center">Couldn't load accounts — ${esc(err.message || '')}</p>`;
  }
  document.getElementById('tenant-filter').addEventListener('input', e => renderList(e.target.value));
  document.getElementById('onboard-btn').addEventListener('click', openOnboard);
});
