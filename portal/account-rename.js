// CloudMeter — renaming a connected cloud account.
//
// Shared by the Cloud Accounts list and the account detail header, so the
// wording about what a rename does and does not touch is written once. The
// server re-checks the caller's role; the controls here only decide whether
// to offer it.

function CM_canRenameAccount() {
  const role = (window.CM_ME && window.CM_ME.role) || null;
  return role === 'owner' || role === 'admin';
}

/**
 * @param account  the account being renamed; its `name` is updated in place on
 *                 success, so callers holding the same object see the new value.
 * @param onSaved  called with the saved name once the API confirms it.
 */
function CM_openRenameAccount(account, onSaved) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Rename ${esc(account.name)}</h2>
    <p class="modal-sub">
      The label this account is shown under in CloudMeter. It doesn't touch the
      provider account itself, its stored credentials, or its cost history —
      spend already recorded stays exactly where it is.
    </p>

    <label class="field-label" for="acct-rename-value" style="margin-top:16px">Name</label>
    <input class="field-input" id="acct-rename-value" maxlength="80" autocomplete="off"
           value="${esc(account.name)}">
    <div class="provider-meta" style="margin-top:4px">${esc(account.externalId || '')}</div>

    <p class="field-error" id="acct-rename-error"></p>
    <div class="modal-actions">
      <button class="btn" data-rename-cancel>Cancel</button>
      <button class="btn btn-primary" data-rename-save>Save name</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const input = dlg.querySelector('#acct-rename-value');
  const save = dlg.querySelector('[data-rename-save]');
  const err = dlg.querySelector('#acct-rename-error');
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
    // Saving an unchanged name would be a pointless write, and worse, a
    // pointless "renamed" confirmation.
    if (name === account.name) { close(); return; }

    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const res = await renameAccount(account.id, name);
      account.name = res.name || name;
      close();
      if (onSaved) onSaved(account.name);
    } catch (e) {
      save.disabled = false;
      save.textContent = 'Save name';
      err.textContent = e.message || 'Could not save that name.';
      err.classList.add('show');
    }
  });
}
