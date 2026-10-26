// CloudMeter — Team page: roster, invites, and role changes via the real Team API.

let TEAM = [];
// The cloud accounts this caller can grant. Owners see the tenant's; an Admin
// sees the same list but the server only lets them grant the ones they manage.
let ACCOUNTS = [];
let callerRole = 'member'; // most restrictive until GET /me resolves

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'U';
}

// Relative time from an ISO timestamp. Returns null for anything unparseable
// so callers can decide what to show — never guesses a date out of prose.
function relativeTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString();
}

// Each row type has its own timestamp field, so the label is chosen from the
// row rather than inferred from the value's shape.
function activityLabel(m) {
  if (m.pendingInvite) {
    const rel = relativeTime(m.invitedAt);
    return rel ? `Invited ${rel}` : 'Invited';
  }
  const active = relativeTime(m.lastActiveAt);
  if (active) return `Active ${active}`;
  const joined = relativeTime(m.joinedAt);
  return joined ? `Joined ${joined}` : '';
}

function badgeClass(m) {
  if (m.status === 'pending') return 'badge-pending';
  if (m.role === 'owner') return 'badge-good';
  return 'badge-neutral';
}

function renderRow(m) {
  const isOwner = m.role === 'owner';
  const badgeText = m.status === 'pending' ? `${ROLE_LABEL[m.role]} · Pending` : ROLE_LABEL[m.role];

  // Role changes stay owner-only. Removal: owners can remove admins or
  // members; admins can only remove members. Whoever can invite can cancel
  // a pending invite.
  const canChangeRole = callerRole === 'owner';
  const canRemove = callerRole === 'owner' || (callerRole === 'admin' && m.role === 'member');
  const canManageInvites = callerRole === 'owner' || callerRole === 'admin';
  // Transferring is offered once, on the owner's own row — it is a single
  // decision about this CloudMeter account, not a per-person action, and
  // repeating it against every teammate buried the ordinary controls.
  const canTransfer = isOwner && m.isYou && callerRole === 'owner'
    && eligibleForOwnership().length > 0;

  let actions = '';
  if (m.pendingInvite) {
    if (canManageInvites) {
      actions = `<button class="member-remove-btn" data-cancel-invite="${m.id}"
                   data-invite-email="${esc(m.email)}">Cancel invite</button>`;
    }
  } else if (canTransfer) {
    actions = `<button class="link-btn-sm" data-transfer-ownership>Transfer ownership</button>`;
  } else if (!isOwner && (canChangeRole || canRemove)) {
    actions = `
      <span style="display:flex;gap:8px;align-items:center">
        ${canChangeRole ? `
        <select class="member-role-select" data-role-select="${m.id}">
          <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option>
        </select>` : ''}
        ${canRemove ? `<button class="member-remove-btn" data-remove-member="${m.id}">Remove</button>` : ''}
      </span>`;
  }

  // Renaming is offered on the name itself rather than as another action
  // link — the row already carries enough controls, and the thing being
  // edited is the obvious place to click. A pending invitee has no
  // membership row to rename yet.
  const canRename = (callerRole === 'owner' || callerRole === 'admin') && !m.pendingInvite;
  const nameCell = canRename
    ? `<button class="member-name-btn" data-rename="${m.id}" title="Rename ${esc(m.name)}">
         ${esc(m.name)}
         <svg class="ic-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
         ><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
       </button>`
    : esc(m.name);

  return `
    <div class="member-row">
      <span class="member-avatar">${esc(initials(m.name))}</span>
      <div class="member-info">
        <div class="name">${nameCell}${m.isYou ? ' <span class="member-you-tag">You</span>' : ''}</div>
        <div class="email">${esc(m.email)}</div>
        ${scopeLine(m)}
      </div>
      <span class="badge ${badgeClass(m)}">${badgeText}</span>
      <span class="member-meta">${activityLabel(m)}</span>
      ${actions}
    </div>`;
}

/**
 * Members see only the cloud accounts they're mapped to, so the row has to show
 * which — an unmapped Member can sign in and find nothing, and without this
 * that looks like a bug rather than a setting.
 *
 * Owners and Admins see everything, so they get no line at all.
 */
function scopeLine(m) {
  if (m.role !== 'member') return '';

  const ids = Array.isArray(m.accountIds) ? m.accountIds : [];
  const names = ids
    .map(id => (ACCOUNTS.find(a => a.id === id) || {}).name)
    .filter(Boolean);

  const verb = m.pendingInvite ? 'Will see' : 'Sees';
  const label = names.length
    ? `${verb} ${names.length} account${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
    : 'No cloud accounts yet — they will see an empty portal';

  // A pending invite has no membership to edit yet; its scope is fixed until
  // they join. Cancelling and re-inviting is the way to change it.
  const canEdit = !m.pendingInvite && (callerRole === 'owner' || callerRole === 'admin');
  return `<div class="member-scope ${names.length ? '' : 'is-empty'}">
      ${esc(label)}
      ${canEdit ? `<button class="link-btn-sm" data-edit-scope="${esc(m.id)}">Change</button>` : ''}
    </div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Opens the picker for one member. Only accounts the caller manages are
// offered; the server rejects anything else and leaves grants it can't see
// untouched, so an Admin editing scope can't clobber a colleague's grants.
function openScopeEditor(userId) {
  const m = TEAM.find(x => x.id === userId);
  if (!m) return;
  const current = new Set(Array.isArray(m.accountIds) ? m.accountIds : []);

  const rows = ACCOUNTS.map(a => `
    <label class="scope-option">
      <input type="checkbox" value="${esc(a.id)}" ${current.has(a.id) ? 'checked' : ''}>
      <span>${esc(a.name)}<span class="scope-option-meta">${esc(a.externalId || '')}</span></span>
    </label>`).join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Cloud accounts for ${esc(m.name)}</h2>
    <p class="modal-sub">They will see only what you tick here — the roll-up dashboard stays hidden either way.</p>
    <div class="scope-options">${rows || '<p class="modal-sub">No cloud accounts to grant yet.</p>'}</div>
    <p class="field-error" id="scope-error"></p>
    <div class="modal-actions">
      <button class="btn" data-scope-cancel>Cancel</button>
      <button class="btn btn-primary" data-scope-save>Save access</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-scope-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-scope-save]').addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-scope-save]');
    const err = dlg.querySelector('#scope-error');
    const accountIds = [...dlg.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await window.CM_Api.put(`/team/${encodeURIComponent(userId)}/accounts`, { accountIds });
      m.accountIds = res.accountIds;
      close();
      renderTeam();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save access';
      err.textContent = e.message || 'Could not save that.';
      err.classList.add('show');
    }
  });
}

/**
 * Removes a teammate, handing on any cloud accounts they manage first.
 *
 * The server refuses with 409 rather than orphaning them, and names what it is
 * holding — so the first attempt is what discovers whether a handover is
 * needed, instead of the page keeping its own idea of who manages what.
 */
async function removeMember(userId, reassignTo) {
  const m = TEAM.find(x => x.id === userId);
  if (!m) return;

  if (!reassignTo && !window.confirm(`Remove ${m.name} from this CloudMeter account?`)) return;

  const query = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
  try {
    await window.CM_Api.delete(`/team/${encodeURIComponent(userId)}${query}`);
    TEAM = TEAM.filter(x => x.id !== userId);
    renderTeam();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.needsReassignment) {
      openHandoverEditor(m, err.data.managedAccounts || []);
      return;
    }
    window.alert(err.message);
  }
}

// Asks who takes over before the removal is retried. Defaults to the person
// doing the removing: they are here, and they are accountable for the decision.
function openHandoverEditor(member, accounts) {
  const me = window.CM_ME || {};
  const eligible = TEAM.filter(t => !t.pendingInvite && t.id !== member.id);

  const options = eligible.map(t => {
    const role = t.role === 'owner' ? 'Owner' : t.role === 'admin' ? 'Admin' : 'Member';
    const selected = t.id === me.userId ? ' selected' : '';
    return `<option value="${esc(t.id)}"${selected}>${esc(t.name)} — ${role}${t.isYou ? ' (you)' : ''}</option>`;
  }).join('');

  const list = accounts.map(a => `<li>${esc(a.name)}</li>`).join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Who takes over ${esc(member.name)}'s cloud accounts?</h2>
    <p class="modal-sub">${accounts.length === 1 ? 'This account is' : `These ${accounts.length} accounts are`}
      managed by ${esc(member.name)}. Pick who becomes responsible, then ${esc(member.name)} will be removed.</p>
    <ul class="handover-list">${list}</ul>
    <label class="field-label" for="handover-to" style="margin-top:16px">New manager</label>
    <select class="field-input" id="handover-to">${options}</select>
    <p class="field-error" id="handover-error"></p>
    <div class="modal-actions">
      <button class="btn" data-handover-cancel>Cancel</button>
      <button class="btn btn-danger" data-handover-save>Reassign &amp; remove</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-handover-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-handover-save]').addEventListener('click', async () => {
    const save = dlg.querySelector('[data-handover-save]');
    const err = dlg.querySelector('#handover-error');
    const to = dlg.querySelector('#handover-to').value;
    save.disabled = true;
    save.textContent = 'Reassigning…';
    try {
      await window.CM_Api.delete(`/team/${encodeURIComponent(member.id)}?reassignTo=${encodeURIComponent(to)}`);
      TEAM = TEAM.filter(x => x.id !== member.id);
      close();
      // The new manager's mapped accounts may have grown, so re-read rather
      // than patching the row from here.
      await reloadTeam();
    } catch (e) {
      save.disabled = false;
      save.textContent = 'Reassign & remove';
      err.textContent = e.message || 'Could not complete that.';
      err.classList.add('show');
    }
  });
}

/**
 * Renames someone on this account's roster.
 *
 * The name is per CloudMeter account, not per person: the same colleague can
 * be "Neeta Kumar" here and something else in another account they belong to.
 * That is deliberate — this is how *this* team lists them — and the dialog
 * says so, since "change their name" otherwise sounds like editing their
 * profile everywhere.
 */
function openRenameDialog(member) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Rename ${esc(member.name)}</h2>
    <p class="modal-sub">
      How this person is listed in this CloudMeter account, and how they're
      named in its alerts and emails. It doesn't change their sign-in address
      or how they appear in any other CloudMeter account.
    </p>

    <label class="field-label" for="rename-value" style="margin-top:16px">Name</label>
    <input class="field-input" id="rename-value" maxlength="80" autocomplete="off"
           value="${esc(member.name)}">
    <div class="provider-meta" style="margin-top:4px">${esc(member.email)}</div>

    <p class="field-error" id="rename-error"></p>
    <div class="modal-actions">
      <button class="btn" data-rename-cancel>Cancel</button>
      <button class="btn btn-primary" data-rename-save>Save name</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const input = dlg.querySelector('#rename-value');
  const save = dlg.querySelector('[data-rename-save]');
  const err = dlg.querySelector('#rename-error');
  input.focus();
  input.select();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-rename-cancel]').addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });

  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      err.textContent = 'Enter a name.';
      err.classList.add('show');
      input.focus();
      return;
    }
    if (name === member.name) { close(); return; }

    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const res = await window.CM_Api.patch(`/team/${encodeURIComponent(member.id)}`, { name });
      member.name = res.name || name;
      close();
      renderTeam();
    } catch (e) {
      save.disabled = false;
      save.textContent = 'Save name';
      err.textContent = e.message || 'Could not save that name.';
      err.classList.add('show');
    }
  });
}

/**
 * Who ownership could be handed to: anyone already on the team but the
 * current owner. A pending invitee is excluded — they may never accept, and
 * an account owned by someone who has never signed in has nobody who can
 * actually run it.
 */
function eligibleForOwnership() {
  return TEAM.filter(t => !t.pendingInvite && t.status !== 'pending' && t.role !== 'owner');
}

/**
 * Hands the CloudMeter account to someone else.
 *
 * Two decisions in one dialog, because they are one decision in practice:
 * who takes over, and what becomes of the person handing it on. There is no
 * safe default for the second — staying on as an Admin is usual, but someone
 * leaving the company wants off the team entirely — so it is asked outright
 * rather than guessed.
 */
function openTransferOwnershipDialog() {
  const candidates = eligibleForOwnership();
  if (candidates.length === 0) return;

  const me = TEAM.find(t => t.isYou);
  const myName = me ? me.name : 'you';
  const orgName = (window.CM_ME && window.CM_ME.tenantName) || 'this CloudMeter account';

  // Names only. Their current role is about to be replaced by Owner anyway,
  // so showing it here answers a question nobody is asking and reads as if
  // it were the role being granted.
  const options = candidates
    .map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)
    .join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Transfer ownership of ${esc(orgName)}</h2>
    <p class="modal-sub">
      The new owner will be able to manage billing and the plan, change what everyone
      else can do, transfer ownership on, and close this CloudMeter account.
      You will stop being able to do those things immediately.
    </p>

    <label class="field-label" for="transfer-to" style="margin-top:16px">New owner</label>
    <select class="field-input" id="transfer-to">${options}</select>

    <label class="field-label" for="transfer-outgoing" style="margin-top:16px">
      What happens to ${esc(myName)}?
    </label>
    <select class="field-input" id="transfer-outgoing">
      <option value="admin" selected>Stay as an Admin</option>
      <option value="member">Stay as a Member</option>
      <option value="remove">Leave this CloudMeter account</option>
    </select>
    <p class="provider-meta" id="transfer-note" style="margin-top:8px"></p>

    <p class="field-error" id="transfer-error"></p>
    <div class="modal-actions">
      <button class="btn" data-transfer-cancel>Cancel</button>
      <button class="btn btn-primary" data-transfer-save>Transfer ownership</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const toSelect = dlg.querySelector('#transfer-to');
  const roleSelect = dlg.querySelector('#transfer-outgoing');
  const note = dlg.querySelector('#transfer-note');
  const save = dlg.querySelector('[data-transfer-save]');

  // Leaving is the one irreversible choice here — you can't put yourself back
  // on a team you no longer own — so it is called out rather than left to be
  // inferred from the word "Leave".
  function describe() {
    const leaving = roleSelect.value === 'remove';
    const to = candidates.find(c => c.id === toSelect.value);
    const toName = to ? to.name : 'the new owner';
    note.textContent = leaving
      ? `You'll lose access to this CloudMeter account straight away, and any cloud accounts `
        + `you manage will be assigned to ${toName}. Only ${toName} could invite you back.`
      : '';
    save.className = leaving ? 'btn btn-danger' : 'btn btn-primary';
    save.textContent = leaving ? 'Transfer & leave' : 'Transfer ownership';
  }
  describe();
  toSelect.addEventListener('change', describe);
  roleSelect.addEventListener('change', describe);

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-transfer-cancel]').addEventListener('click', close);

  save.addEventListener('click', async () => {
    const err = dlg.querySelector('#transfer-error');
    const targetId = toSelect.value;
    const outgoingRole = roleSelect.value;
    const target = candidates.find(c => c.id === targetId);
    const label = save.textContent;

    // Named out loud, because the button alone doesn't say who is getting it.
    if (!window.confirm(
      `Make ${target ? target.name : 'this person'} the owner of ${orgName}?`
      + (outgoingRole === 'remove' ? '\n\nYou will be removed from this CloudMeter account.' : '')
    )) return;

    save.disabled = true;
    save.textContent = 'Transferring…';
    try {
      await window.CM_Api.post(
        `/team/${encodeURIComponent(targetId)}/transfer-ownership`,
        { outgoingRole },
      );
      close();
      // Everything about this page — who can do what, whether the caller is
      // even still on the team — has just changed, so start clean rather
      // than patching rows.
      window.location.reload();
    } catch (e) {
      save.disabled = false;
      save.textContent = label;
      err.textContent = e.message || 'Could not transfer ownership.';
      err.classList.add('show');
    }
  });
}

/**
 * Confirms an invitation by choosing what the person will actually see.
 *
 * Sending first and granting later is the order that produces a Member who
 * signs in to nothing, so the accounts are picked as part of sending.
 *
 * Picking none is allowed, and is a real answer rather than an oversight:
 * Adhoc Spend accounts are open to the whole workspace, so someone brought in
 * only to record what they pay for Claude or ChatGPT needs no cloud account at
 * all. Requiring one meant inventing a mapping to a bill they have nothing to
 * do with, purely to get them through the door.
 */
function openInviteScopeDialog(email, role, name) {
  const rows = ACCOUNTS.map(a => `
    <label class="scope-option">
      <input type="checkbox" value="${esc(a.id)}">
      <span>${esc(a.name)}<span class="scope-option-meta">${esc(a.externalId || '')}</span></span>
    </label>`).join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>What should ${esc(name || email)} see?</h2>
    <p class="modal-sub">They'll be invited as a Member, so they see only the cloud accounts you pick —
      and the costs for those. Not the organisation-wide dashboard.
      Pick none and they can still record their own Adhoc Spend subscriptions, which every member
      of the workspace can reach.</p>
    <div class="scope-selectall">
      <button type="button" class="link-btn-sm" data-scope-all>Select all</button>
      <button type="button" class="link-btn-sm" data-scope-none>Clear</button>
      <span class="scope-count" id="invite-scope-count">None selected</span>
    </div>
    <div class="scope-options">${rows}</div>
    <p class="field-error" id="invite-dlg-error"></p>
    <div class="modal-actions">
      <button class="btn" data-invite-cancel>Cancel</button>
      <button class="btn btn-primary" data-invite-send>Send invite</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const boxes = [...dlg.querySelectorAll('input[type=checkbox]')];
  const send = dlg.querySelector('[data-invite-send]');
  const count = dlg.querySelector('#invite-scope-count');
  const sync = () => {
    const n = boxes.filter(b => b.checked).length;
    // None selected is a valid invitation — Adhoc Spend only — so the count
    // says what that means rather than telling someone to fix it.
    count.textContent = n === 0
      ? 'None selected — Adhoc Spend only'
      : `${n} of ${boxes.length} selected`;
  };
  boxes.forEach(b => b.addEventListener('change', sync));
  dlg.querySelector('[data-scope-all]').addEventListener('click', () => { boxes.forEach(b => { b.checked = true; }); sync(); });
  dlg.querySelector('[data-scope-none]').addEventListener('click', () => { boxes.forEach(b => { b.checked = false; }); sync(); });
  sync();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-invite-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-invite-send]').addEventListener('click', async () => {
    send.disabled = true;
    send.textContent = 'Sending…';
    const err = dlg.querySelector('#invite-dlg-error');
    err.classList.remove('show');
    try {
      await sendInvite(email, role, boxes.filter(b => b.checked).map(b => b.value), name, true);
      close();
    } catch (e) {
      send.disabled = false;
      send.textContent = 'Send invite';
      err.textContent = e.message || 'Could not send that invitation.';
      err.classList.add('show');
    }
  });
}

/**
 * @param fromDialog  whether the scope dialog is on screen and will show the
 *                    error itself. Asked explicitly rather than inferred from
 *                    an empty account list: picking none is now a real choice
 *                    made in that dialog, so "no accounts" no longer means
 *                    "no dialog", and an error written to the form behind a
 *                    modal is an error nobody sees.
 */
async function sendInvite(email, role, accountIds, name, fromDialog) {
  const inviteEmail = document.getElementById('invite-email');
  const inviteName = document.getElementById('invite-name');
  const inviteError = document.getElementById('invite-error');
  try {
    await window.CM_Api.post('/team/invite', { email, role, accountIds, name });
  } catch (err) {
    if (!fromDialog) {
      inviteError.textContent = err.message;
      inviteError.classList.add('show');
    }
    throw err;
  }
  // Re-fetch rather than appending a local row: the real invite token is
  // needed for the Cancel action, and the server owns the display order.
  const { members } = await window.CM_Api.get('/team');
  TEAM = members;
  inviteEmail.value = '';
  if (inviteName) inviteName.value = '';
  renderTeam();
}

async function reloadTeam() {
  const [{ members }, accountsRes] = await Promise.all([
    window.CM_Api.get('/team'),
    window.CM_Api.get('/accounts').catch(() => ({ accounts: [] })),
  ]);
  TEAM = members;
  ACCOUNTS = accountsRes.accounts || [];
  renderTeam();
}

function renderTeam() {
  document.getElementById('team-list').innerHTML = TEAM.map(renderRow).join('');
  const pending = TEAM.filter(m => m.status === 'pending').length;
  const active = TEAM.length - pending;
  document.getElementById('member-count-sub').textContent =
    `${active} member${active === 1 ? '' : 's'}` + (pending ? ` · ${pending} pending invite${pending === 1 ? '' : 's'}` : '');

  document.querySelectorAll('[data-edit-scope]').forEach(btn => {
    btn.addEventListener('click', () => openScopeEditor(btn.dataset.editScope));
  });

  document.querySelectorAll('[data-role-select]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const m = TEAM.find(x => x.id === sel.dataset.roleSelect);
      try {
        await window.CM_Api.patch(`/team/${encodeURIComponent(sel.dataset.roleSelect)}`, { role: sel.value });
        if (m) m.role = sel.value;
        /*
         * Re-fetched rather than re-rendered, because role now decides where
         * a row sits. Patching m.role in place and re-rendering would leave
         * the person showing "Admin" while still sitting in the Member block
         * — the list would contradict itself until the next page load.
         *
         * The server owns the order, so asking it again is also what keeps
         * the client from carrying a second copy of the sorting rules that
         * could drift from it.
         */
        await reloadTeam();
        return;
      } catch (err) {
        window.alert(err.message);
      }
      // Failed: re-render so the dropdown snaps back to the real role.
      renderTeam();
    });
  });
  document.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', () => removeMember(btn.dataset.removeMember));
  });

  document.querySelectorAll('[data-transfer-ownership]').forEach(btn => {
    btn.addEventListener('click', () => openTransferOwnershipDialog());
  });

  document.querySelectorAll('[data-rename]').forEach(btn => {
    btn.addEventListener('click', () => {
      const member = TEAM.find(t => t.id === btn.dataset.rename);
      if (member) openRenameDialog(member);
    });
  });

  document.querySelectorAll('[data-cancel-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = btn.dataset.cancelInvite;
      const email = btn.dataset.inviteEmail;
      if (!window.confirm(`Cancel the invitation to ${email}?\n\nThe link in their email will stop working.`)) return;
      btn.disabled = true;
      btn.textContent = 'Cancelling…';
      try {
        await window.CM_Api.delete(`/team/invites/${encodeURIComponent(token)}`);
        TEAM = TEAM.filter(x => x.id !== token);
        renderTeam();
      } catch (err) {
        window.alert(err.message);
        btn.disabled = false;
        btn.textContent = 'Cancel invite';
      }
    });
  });
}

document.addEventListener('cm-me-loaded', (e) => {
  callerRole = e.detail.role || 'member';
  applyInvitePermissions();
  renderTeam();
});

// Admins can invite, but only Members — promoting someone to Admin stays with
// the Owner, matching removal (an Admin can remove Members, not Admins). The
// API enforces the same rule; this just avoids offering an option that would
// be rejected.
/**
 * An Admin can only bring in Members, so their Role control has exactly one
 * option. A dropdown you cannot choose anything in is just a control-shaped
 * label, so they get the label instead — the value still travels with the
 * invite, and the server enforces the rule regardless.
 */
function applyInvitePermissions() {
  const roleSelect = document.getElementById('invite-role');
  const roleField = roleSelect && roleSelect.closest('.field-group');
  if (!roleSelect) return;

  const adminOption = roleSelect.querySelector('option[value="admin"]');
  if (callerRole === 'owner') {
    if (adminOption) { adminOption.hidden = false; adminOption.disabled = false; }
    roleSelect.hidden = false;
    if (roleField) roleField.querySelector('.invite-role-fixed')?.remove();
    return;
  }

  roleSelect.value = 'member';
  roleSelect.hidden = true;
  if (roleField && !roleField.querySelector('.invite-role-fixed')) {
    const fixed = document.createElement('span');
    fixed.className = 'invite-role-fixed';
    fixed.textContent = 'Member';
    fixed.title = 'Admins can invite Members. Ask the Owner to add an Admin.';
    roleSelect.insertAdjacentElement('afterend', fixed);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Fetched together: a Member row can't say which accounts it covers
    // without the account names, and the roster is useless without the roster.
    const [{ members }, accountsRes] = await Promise.all([
      window.CM_Api.get('/team'),
      window.CM_Api.get('/accounts').catch(() => ({ accounts: [] })),
    ]);
    TEAM = members;
    ACCOUNTS = accountsRes.accounts || [];
    renderTeam();
  } catch (err) {
    window.CM_renderLoadError(err, 'team-list');
  }

  const inviteBtn = document.getElementById('invite-btn');
  const inviteEmail = document.getElementById('invite-email');
  const inviteRole = document.getElementById('invite-role');
  const inviteError = document.getElementById('invite-error');

  const inviteName = document.getElementById('invite-name');

  inviteBtn?.addEventListener('click', () => {
    const email = inviteEmail.value.trim();
    const name = inviteName ? inviteName.value.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      inviteError.textContent = 'Enter a valid email address.';
      inviteError.classList.add('show');
      inviteEmail.focus();
      return;
    }
    inviteError.classList.remove('show');

    // An Admin sees every cloud account, so there is nothing to choose.
    // A Member with no accounts would sign in to an empty portal, so the
    // choice is made before the invitation goes out rather than after.
    if (inviteRole.value === 'member' && ACCOUNTS.length) {
      openInviteScopeDialog(email, inviteRole.value, name);
      return;
    }
    sendInvite(email, inviteRole.value, [], name);
  });
  inviteEmail?.addEventListener('input', () => inviteError.classList.remove('show'));
});
