// CloudMeter — "Add cloud account" modal wizard (mockup only, no real connection is made)
// Usage: add [data-open-add-account] to open the provider picker, or
//        [data-open-add-account-provider="aws"] to jump straight to that provider's setup.

(function () {
  let selectedProvider = null;
  let connectionToken = null;
  let providerMeta = null;
  const OTHER_TOOL = '__other__';

  /** "Pro $20 · Max 5x $100 · Team $30 per seat" — what this tool sells. */
  function describePlans(toolName) {
    const plans = (window.CM_AdhocCatalog && window.CM_AdhocCatalog.plansFor(toolName)) || [];
    if (!plans.length) return '';
    return plans.map((p) => {
      const price = p.usd === null || p.usd === undefined
        ? (p.note || 'negotiated')
        : `$${p.usd}${p.cadence === 'yearly' ? '/yr' : ''}${p.note ? ` ${p.note}` : ''}`;
      return `${p.name} ${price}`;
    }).join(' · ');
  }

  /**
   * The tool list, from the catalogue BMS maintains.
   *
   * Shown as a list rather than a text box so the name matches the catalogue
   * exactly — that match is what lets the account page offer this tool's plans
   * later. "Other…" is always there: a tool nobody has added to BMS yet must
   * not be un-recordable, it simply gets a typed plan name instead.
   */
  /*
   * What the tool picker currently holds: a catalogue label, OTHER_TOOL, or
   * '' for nothing chosen yet.
   *
   * Kept here rather than read back off the search box, because the two are
   * not the same thing. The box holds whatever is being typed — "openai", a
   * half-finished word, or nothing after a clear — while this holds what was
   * actually picked. Deriving the choice from the text is how a half-typed
   * query becomes a tool name nobody selected.
   */
  let chosenTool = '';
  /** The catalogue, as [{label, aliases}], once loaded. */
  let toolChoices = [];

  /** Case- and space-insensitive, which is how people type a tool's name. */
  function normaliseQuery(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  /**
   * The tools worth showing for what has been typed.
   *
   * Matched against the aliases as well as the label, which is the whole
   * point: "openai" has to find ChatGPT. A native <select> could not do this —
   * its type-ahead only jumps to labels *starting* with the query — so
   * somebody searching by the name they know fell through to "Other…" and
   * created a second tool beside the real one.
   *
   * Substring rather than prefix, so "copilot" finds GitHub Copilot and
   * "cursor.sh" finds Cursor. An empty query shows everything, because the
   * box opening to the full list is what makes it browsable as well as
   * searchable.
   */
  function matchingTools(query, choices) {
    const q = normaliseQuery(query);
    if (!q) return choices;
    return choices.filter(({ label, aliases }) => {
      if (normaliseQuery(label).includes(q)) return true;
      return (aliases || []).some((a) => normaliseQuery(a).includes(q));
    });
  }

  /**
   * The tool list, from the catalogue BMS maintains.
   *
   * Shown as a list rather than a free text box so the name matches the
   * catalogue exactly — that match is what lets the account page offer this
   * tool's plans later. "Other…" is always there: a tool nobody has added to
   * BMS yet must not be un-recordable, it simply gets a typed plan name
   * instead.
   */
  async function renderToolPicker() {
    const picker = el('aa-tool-picker');
    const search = el('aa-tool-search');
    const hint = el('aa-tool-plans');
    const input = el('aa-nickname');

    picker.hidden = false;
    chosenTool = '';
    search.value = '';
    input.hidden = true;
    hint.hidden = true;

    if (window.CM_AdhocCatalog && window.CM_AdhocCatalog.ready) {
      await window.CM_AdhocCatalog.ready();
    }
    const catalog = window.CM_AdhocCatalog;
    toolChoices = (catalog && catalog.toolOptions)
      ? catalog.toolOptions()
      // An older catalogue with no toolOptions still fills the list; it simply
      // has no aliases to match or show.
      : ((catalog && catalog.knownTools()) || []).map((label) => ({ label, aliases: [] }));

    // Only the typed box carries the name for "Other…", so it starts empty
    // rather than holding whatever the last visit left behind.
    input.value = '';
    input.placeholder = 'e.g. Notion AI';
    paintToolList('');
    search.focus();
  }

  /**
   * Draws the list for a query. Each row shows the tool's other names, so the
   * reader can see *why* a search for "openai" surfaced ChatGPT.
   */
  function paintToolList(query) {
    const list = el('aa-tool-list');
    const matches = matchingTools(query, toolChoices);

    const rows = matches.map(({ label, aliases }) => {
      const also = (aliases || []).filter(Boolean).join(', ');
      return `<li class="tool-opt" role="option" aria-selected="false" data-tool="${esc(label)}">
        <span class="tool-opt-name">${esc(label)}</span>
        ${also ? `<span class="tool-opt-alias">${esc(also)}</span>` : ''}
      </li>`;
    });

    // "Other…" is never filtered out. A search that matches nothing is the
    // moment somebody most needs it — the tool genuinely is not in BMS yet.
    rows.push(`<li class="tool-opt is-other" role="option" aria-selected="false" data-tool="${OTHER_TOOL}">
      <span class="tool-opt-name">Other…</span>
      <span class="tool-opt-alias">${matches.length ? 'not in this list' : 'nothing matched — name it yourself'}</span>
    </li>`);

    list.innerHTML = rows.join('');
    list.hidden = false;
    el('aa-tool-search').setAttribute('aria-expanded', 'true');
  }

  function closeToolList() {
    el('aa-tool-list').hidden = true;
    el('aa-tool-search').setAttribute('aria-expanded', 'false');
  }

  /**
   * Records a choice and shows what that tool sells.
   *
   * The search box is set to the plain label afterwards, not to the query that
   * found it: "openai" is how this person found ChatGPT, but ChatGPT is what
   * is being recorded, and the box must not claim otherwise.
   */
  function chooseTool(value) {
    const hint = el('aa-tool-plans');
    const input = el('aa-nickname');
    const other = value === OTHER_TOOL;

    chosenTool = value;
    el('aa-tool-search').value = other ? '' : value;
    el('aa-error').classList.remove('show');
    closeToolList();

    input.hidden = !other;
    if (other) { input.value = ''; input.focus(); }

    const plans = other ? '' : describePlans(value);
    hint.hidden = !plans;
    hint.textContent = plans ? `Plans: ${plans}` : '';
  }

  /** Whichever control is currently naming the tool. */
  function manualToolName() {
    if (el('aa-tool-picker').hidden) return el('aa-nickname').value.trim();
    return chosenTool === OTHER_TOOL ? el('aa-nickname').value.trim() : chosenTool;
  }

  const modalHTML = `
  <div class="modal-overlay" id="add-account-overlay">
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="Add cloud account">
      <button class="modal-close" id="add-account-close" aria-label="Close">✕</button>

      <div class="modal-step active" id="aa-step-1">
        <div class="modal-step-label">Step 1 of 3</div>
        <h2>Choose a cloud provider</h2>
        <p class="modal-sub">You can connect as many accounts as you need per provider — every one rolls into the same unified ledger.</p>
        <div class="provider-pick-grid" id="provider-pick-grid"></div>
      </div>

      <div class="modal-step" id="aa-step-2">
        <div class="modal-step-label">Step 2 of 3</div>
        <button class="modal-back" id="aa-back-1">← Choose a different provider</button>
        <h2 id="aa-step2-title">Connect account</h2>
        <p class="modal-sub" id="aa-step2-sub"></p>

        <label class="field-label" data-connect-only>1. Create a <span id="aa-role-label"></span></label>
        <div class="code-block" data-connect-only>
          <button class="code-copy" id="aa-copy-btn">Copy</button>
          <pre id="aa-snippet"></pre>
        </div>

        <div style="margin-top:16px">
          <label class="field-label" id="aa-nickname-label">2. Nickname this account</label>
          <!-- Manual-entry providers pick from the catalogue BMS maintains
               rather than typing a name. Choosing the same tool as the
               catalogue is what makes its plans offerable afterwards; a typed
               "Claude AI" would quietly get no plan list at all.

               A search box rather than a <select>: the list is matched against
               each tool's "Also known as" names too, and a native dropdown
               cannot do that. Its type-ahead only jumps to labels *starting*
               with what you typed, so "openai" found nothing and the reader
               fell through to "Other…" — the duplicate-tool outcome the alias
               list exists to prevent. -->
          <div class="tool-picker" id="aa-tool-picker" hidden>
            <input class="field-input" id="aa-tool-search" autocomplete="off"
                   placeholder="Type to search — try “openai”"
                   role="combobox" aria-expanded="false" aria-autocomplete="list"
                   aria-controls="aa-tool-list">
            <ul class="tool-picker-list" id="aa-tool-list" role="listbox" hidden></ul>
          </div>
          <p class="field-hint" id="aa-tool-plans" hidden></p>
          <input class="field-input" id="aa-nickname" placeholder="e.g. prod">
        </div>
        <div id="aa-id-block" data-connect-only>
          <label class="field-label" id="aa-id-label" style="margin-top:14px">Account ID</label>
          <input class="field-input" id="aa-id" placeholder="">
        </div>
        <!-- Per-provider credential inputs, rendered from server metadata -->
        <div id="aa-credential-fields" data-connect-only></div>
        <!-- Hidden for manual-entry providers. An adhoc account is a tool, and
             the plans inside it can each be for a different person, so no
             single name is true of the account itself. -->
        <div id="aa-owner-block">
          <label class="field-label" for="aa-owner" style="margin-top:14px">Owner / contact <span class="field-optional">optional</span></label>
          <input class="field-input" id="aa-owner" maxlength="120" placeholder="e.g. Platform team, or jane@acme.com">
          <p class="field-hint">Who to talk to about this account's spend. Shown on the accounts list — you can add or change it later.</p>
        </div>
        <div class="field-error" id="aa-error">Give this account a nickname so you can find it later.</div>

        <div class="demo-note" id="aa-unverified-note" style="display:none">
          <strong>Not yet verified against a live account.</strong>
          <span id="aa-unverified-text"></span>
        </div>

        <button class="btn btn-primary btn-block" id="aa-connect-btn">Connect</button>
        <button class="btn btn-block" id="aa-sample-btn" style="margin-top:8px" data-connect-only>Use sample data instead</button>
      </div>

      <div class="modal-step" id="aa-step-3">
        <div class="connecting-state">
          <div class="spinner"></div>
          <div class="connecting-text" id="aa-connecting-text">Verifying read-only access…</div>
        </div>
      </div>

      <div class="modal-step" id="aa-step-4">
        <div class="success-state">
          <div class="success-check">✓</div>
          <h2 id="aa-success-title">Account connected</h2>
          <p class="modal-sub" id="aa-success-sub"></p>
          <div class="success-actions">
            <button class="btn" id="aa-add-another">+ Add another account</button>
            <button class="btn btn-primary" id="aa-view-accounts">View in Cloud Accounts</button>
          </div>
        </div>
      </div>

      <div class="modal-step" id="aa-step-error">
        <div class="success-state">
          <h2 id="aa-error-title">Couldn't connect that account</h2>
          <p class="modal-sub" id="aa-error-detail"></p>
          <div class="success-actions">
            <!-- Replaced for a duplicate tool: retrying the same name fails
                 the same way, and the account it clashed with is the one the
                 message points at. -->
            <button class="btn btn-primary" id="aa-error-back">← Try again</button>
            <a class="btn btn-primary" id="aa-error-open" hidden>Open it</a>
          </div>
        </div>
      </div>

    </div>
  </div>`;

  function el(id) { return document.getElementById(id); }

  /**
   * HTML-escape before innerHTML. Local to this file, matching the convention
   * used across this frontend — each page loads its own script set.
   */
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }


  function buildProviderGrid() {
    el('provider-pick-grid').innerHTML = PROVIDER_ORDER.map(key => {
      const m = PROVIDER_META[key];
      const count = (typeof ACCOUNTS !== 'undefined') ? ACCOUNTS.filter(a => a.provider === key).length : null;
      // Adhoc has no provider behind it, so "0 connected" would be meaningless
      // — its subtitle already says what the card is for. With nothing set up
      // yet the count line is dropped rather than replaced with a prompt: the
      // card is a button, and telling someone to press the thing they are
      // about to press adds nothing.
      const meta = m.manualEntry
        ? `<span class="ppc-sub">${esc(m.subtitle)}</span>`
          + (count ? `<span class="ppc-meta">${count} set up</span>` : '')
        : (count !== null
          ? `<span class="ppc-meta">${count} connected</span>`
          : `<span class="ppc-meta">Connect an account</span>`);

      return `
      <button class="provider-pick-card" data-provider="${key}">
        <span class="provider-badge-lg" style="background:${m.color}">${m.badge}</span>
        <span class="ppc-name">${esc(m.fullName)}</span>
        ${meta}
      </button>`;
    }).join('');

    document.querySelectorAll('.provider-pick-card').forEach(card => {
      card.addEventListener('click', () => goToStep2(card.dataset.provider));
    });
  }

  function showStep(n) {
    document.querySelectorAll('.modal-step').forEach(s => s.classList.remove('active'));
    el(`aa-step-${n}`).classList.add('active');
  }

  function renderCredentialFields(fields) {
    const wrap = el('aa-credential-fields');
    if (!fields.length) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = fields.map(f => {
      const input = f.type === 'textarea'
        ? `<textarea class="field-input" data-cred="${f.name}" rows="5" placeholder="${f.placeholder ?? ''}"></textarea>`
        : `<input class="field-input" data-cred="${f.name}" type="${f.type === 'secret' ? 'password' : 'text'}"
             autocomplete="off" spellcheck="false" placeholder="${f.placeholder ?? ''}">`;
      return `<div style="margin-top:14px">
        <label class="field-label">${f.label}</label>
        ${input}
        ${f.help ? `<div class="provider-meta" style="margin-top:4px">${f.help}</div>` : ''}
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-cred]').forEach(input => {
      input.addEventListener('input', () => el('aa-error').classList.remove('show'));
    });
  }

  function collectCredentials() {
    const creds = {};
    el('aa-credential-fields').querySelectorAll('[data-cred]').forEach(input => {
      creds[input.dataset.cred] = input.value.trim();
    });
    return creds;
  }

  async function goToStep2(providerKey) {
    selectedProvider = providerKey;
    connectionToken = null;
    const m = PROVIDER_META[providerKey];
    el('aa-step2-title').textContent = `Connect ${m.fullName}`;
    el('aa-step2-sub').textContent = `Grant CloudMeter a ${m.roleLabel} — we only ever request read-only billing and metadata access, never write access.`;
    el('aa-role-label').textContent = m.roleLabel;
    el('aa-id-label').textContent = m.idLabel;
    el('aa-id').placeholder = m.idPlaceholder;
    el('aa-id').value = '';
    el('aa-nickname').value = '';
    el('aa-nickname').hidden = false;
    // Rebuilt on each visit to step 2, but cleared here too so reopening the
    // modal never flashes the previous tool's selection or its plan list.
    chosenTool = '';
    el('aa-tool-search').value = '';
    closeToolList();
    el('aa-tool-picker').hidden = true;
    el('aa-tool-plans').hidden = true;
    el('aa-owner').value = '';
    el('aa-error').classList.remove('show');
    el('aa-credential-fields').innerHTML = '';
    el('aa-unverified-note').style.display = 'none';

    /**
     * Manual-entry providers have no credential to create and nothing to
     * verify, so the setup snippet, the credential fields and the account-id
     * box are all meaningless. Hide them and ask only for a name — the
     * subscriptions themselves are added on the account page afterwards,
     * where there is room to list them.
     */
    const manual = !!m.manualEntry;
    el('aa-connect-btn').textContent = manual ? 'Create' : 'Connect';
    el('aa-nickname-label').textContent = manual ? 'Name this entry' : '2. Nickname this account';
    el('aa-owner-block').hidden = manual;
    document.querySelectorAll('[data-connect-only]').forEach((n) => { n.hidden = manual; });
    if (manual) {
      // Pick a tool and Create, nothing else. The plans live on the account
      // page, where there is room to list them and where they are managed for
      // the rest of the tool's life.
      el('aa-step2-title').textContent = m.fullName;
      // Short, because the screen is a list and a button. The old line spent
      // its first clause explaining what wasn't happening ("nothing to
      // connect") before reaching what to do.
      el('aa-step2-sub').hidden = false;
      el('aa-step2-sub').textContent = "Choose a tool. You'll record its plans on the account page.";
      el('aa-nickname-label').textContent = 'Tool';
      el('aa-connect-btn').textContent = 'Create';
      showStep(2);
      await renderToolPicker();
      return;
    }
    // Every other provider types its own nickname.
    el('aa-tool-picker').hidden = true;
    el('aa-tool-plans').hidden = true;
    el('aa-nickname').hidden = false;

    showStep(2);

    let meta;
    try {
      meta = (await fetchProviderMeta())[providerKey];
    } catch (err) {
      el('aa-snippet').textContent = `Couldn't load connection details: ${err.message}`;
      return;
    }
    providerMeta = meta;

    if (meta && !meta.verified) {
      el('aa-unverified-note').style.display = '';
      el('aa-unverified-text').textContent =
        ` The ${meta.displayName} integration is built but hasn't been exercised against a real account yet, so connecting may surface issues. You can use sample data instead while that's confirmed.`;
    }

    if (providerKey === 'aws') {
      // The snippet embeds a per-connection External ID the server issues, so
      // it has to be fetched rather than shipped as static text.
      el('aa-snippet').textContent = 'Generating your unique setup commands…';
      try {
        const params = await fetchConnectParams();
        connectionToken = params.connectionToken;
        el('aa-snippet').textContent = params.snippet;
      } catch (err) {
        el('aa-snippet').textContent = `Couldn't generate setup commands: ${err.message}`;
      }
    } else {
      el('aa-snippet').textContent = m.snippet;
    }

    renderCredentialFields(meta?.credentialFields ?? []);

    // Providers whose identity is one of their credentials collect it once,
    // in the credential list — showing the standalone field too asked for
    // the same value twice under the same label.
    el('aa-id-block').style.display = m.idFromCredential ? 'none' : '';
  }

  async function connect(useSampleData) {
    // Manual-entry providers name themselves from the tool list; everything
    // else types a nickname.
    const nickname = manualToolName();
    if (!nickname) {
      const picking = !el('aa-tool-picker').hidden && chosenTool !== OTHER_TOOL;
      el('aa-error').textContent = picking
        ? 'Choose the tool this account is for.'
        : 'Give this account a nickname so you can find it later.';
      el('aa-error').classList.add('show');
      (picking ? el('aa-tool-search') : el('aa-nickname')).focus();
      return;
    }
    const m = PROVIDER_META[selectedProvider];

    // Nothing to collect and nothing to verify — create the tool and let the
    // account page take it from there.
    if (m.manualEntry) {
      showStep(3);
      el('aa-connecting-text').textContent = 'Creating…';
      try {
        const created = await window.CM_addAccount(selectedProvider, {
          name: nickname,
          id: nickname,
          // Deliberately none. An adhoc account is a tool, and the plans inside
          // it can each be for a different person — no single name is true of
          // the account itself.
          owner: '',
        });
        // Naming the tool and recording what someone pays for it are one act,
        // so the flow continues into the subscription dialog rather than
        // stopping on a success screen that asks the reader to go and find the
        // account they just made. The success step is still shown while the
        // page changes, so a slow navigation is not a frozen modal.
        if (created && created.id) {
          el('aa-success-title').textContent = `${nickname} created`;
          el('aa-success-sub').textContent = 'Opening it so you can add the first subscription…';
          showStep(4);
          window.location.href = `account-detail.html?id=${encodeURIComponent(created.id)}&add=subscription`;
          return;
        }
        el('aa-success-title').textContent = `${nickname} created`;
        el('aa-success-sub').textContent =
          'Open it and use "Add subscription" to record each plan — who it is '
          + 'for, what it costs, and the dates.';
        showStep(4);
      } catch (err) {
        // A duplicate tool is not a failure to connect — nothing was being
        // connected, and the account it clashes with is the one they want. So
        // the action is a way into that account, not a retry that would be
        // refused on the same name.
        const clash = err.status === 409 && err.data && err.data.existingAccountId;
        el('aa-error-title').textContent = clash ? 'That tool is already here' : "Couldn't add that tool";
        el('aa-error-detail').textContent = err.message || 'Something went wrong — please try again.';
        const open = el('aa-error-open');
        const back = el('aa-error-back');
        if (clash) {
          open.href = `account-detail.html?id=${encodeURIComponent(err.data.existingAccountId)}&add=subscription`;
          open.textContent = `Open ${err.data.existingName || 'it'}`;
          open.hidden = false;
          back.hidden = true;
        } else {
          open.hidden = true;
          back.hidden = false;
        }
        showStep('error');
      }
      return;
    }

    const credentials = useSampleData ? {} : collectCredentials();

    if (!useSampleData) {
      const missing = (providerMeta?.credentialFields ?? [])
        .filter(f => f.required !== false && !credentials[f.name]);
      if (missing.length) {
        el('aa-error').textContent = `${missing[0].label} is required.`;
        el('aa-error').classList.add('show');
        return;
      }
      if (selectedProvider === 'aws' && !/^arn:aws:iam::\d{12}:role\/.+/.test(credentials.roleArn ?? '')) {
        el('aa-error').textContent = 'Paste the full Role ARN printed by the last command above.';
        el('aa-error').classList.add('show');
        return;
      }
    }

    const idValue = (m.idFromCredential
      ? (credentials[m.idFromCredential] || '').trim()
      : el('aa-id').value.trim()) || m.idPlaceholder;

    showStep(3);
    el('aa-connecting-text').textContent = useSampleData
      ? 'Setting up sample data…'
      : 'Verifying access and pulling 6 months of cost data…';

    try {
      await window.CM_addAccount(selectedProvider, {
        name: nickname,
        id: `${m.idLabel} ${idValue}`,
        owner: (el('aa-owner').value || '').trim(),
        useSampleData: !!useSampleData,
        ...(useSampleData ? {} : { credentials, connectionToken }),
      });
      el('aa-success-title').textContent = `${nickname} connected`;
      el('aa-success-sub').innerHTML = useSampleData
        ? `Added to <strong>${m.fullName}</strong> with sample data.`
        : `Connected to <strong>${m.fullName}</strong> — showing live cost data.`;
      showStep(4);
    } catch (err) {
      el('aa-error-title').textContent = "Couldn't connect that account";
      el('aa-error-open').hidden = true;
      el('aa-error-back').hidden = false;
      el('aa-error-detail').textContent = err.message || 'Something went wrong — please try again.';
      showStep('error');
    }
  }

  function openModal(presetProvider) {
    document.getElementById('add-account-overlay').classList.add('show');
    document.body.style.overflow = 'hidden';
    buildProviderGrid();
    if (presetProvider) {
      goToStep2(presetProvider);
    } else {
      showStep(1);
    }
  }

  function closeModal() {
    document.getElementById('add-account-overlay').classList.remove('show');
    document.body.style.overflow = '';
  }

  window.CM_openAddAccount = openModal;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    el('add-account-close').addEventListener('click', closeModal);
    el('add-account-overlay').addEventListener('click', e => {
      if (e.target.id === 'add-account-overlay') closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && el('add-account-overlay').classList.contains('show')) closeModal();
    });

    el('aa-back-1').addEventListener('click', () => { buildProviderGrid(); showStep(1); });
    el('aa-connect-btn').addEventListener('click', () => connect(false));
    el('aa-sample-btn').addEventListener('click', () => connect(true));
    el('aa-error-back').addEventListener('click', () => showStep(2));
    el('aa-nickname').addEventListener('input', () => el('aa-error').classList.remove('show'));

    /*
     * The tool search box.
     *
     * Typing re-filters against labels *and* aliases, and clears the current
     * choice: once the text no longer says ChatGPT, the form must not still be
     * holding ChatGPT underneath. Choosing a tool reveals what it sells, so
     * the catalogue is visible here rather than only once the account exists.
     */
    el('aa-tool-search').addEventListener('input', () => {
      el('aa-error').classList.remove('show');
      chosenTool = '';
      el('aa-tool-plans').hidden = true;
      el('aa-nickname').hidden = true;
      paintToolList(el('aa-tool-search').value);
    });

    // Clicking the box reopens the full list — browsable as well as
    // searchable, which is what the old dropdown was good at.
    el('aa-tool-search').addEventListener('focus', () => {
      paintToolList(chosenTool ? '' : el('aa-tool-search').value);
    });

    el('aa-tool-search').addEventListener('keydown', (e) => {
      const list = el('aa-tool-list');
      if (e.key === 'Escape') { closeToolList(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) paintToolList(el('aa-tool-search').value);
        const rows = [...list.querySelectorAll('.tool-opt')];
        if (!rows.length) return;
        const at = rows.findIndex((r) => r.classList.contains('is-active'));
        const next = e.key === 'ArrowDown'
          ? Math.min(at + 1, rows.length - 1)
          : Math.max(at - 1, 0);
        rows.forEach((r) => { r.classList.remove('is-active'); r.setAttribute('aria-selected', 'false'); });
        rows[next].classList.add('is-active');
        rows[next].setAttribute('aria-selected', 'true');
        rows[next].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        const active = list.querySelector('.tool-opt.is-active');
        // Enter with nothing highlighted takes the only match, which is what
        // typing a full name then pressing Enter plainly means.
        const rows = [...list.querySelectorAll('.tool-opt')];
        const only = rows.length === 2 ? rows[0] : null; // the match plus "Other…"
        const pick = active || only;
        if (pick) { e.preventDefault(); chooseTool(pick.dataset.tool); }
      }
    });

    // mousedown, not click: the box blurs first on a click, and a blur handler
    // that closed the list would remove the row before the click landed on it.
    el('aa-tool-list').addEventListener('mousedown', (e) => {
      const row = e.target.closest('.tool-opt');
      if (!row) return;
      e.preventDefault();
      chooseTool(row.dataset.tool);
    });

    // Clicking away closes the list without choosing anything.
    document.addEventListener('mousedown', (e) => {
      const picker = el('aa-tool-picker');
      if (!picker || picker.hidden) return;
      if (!e.target.closest || !e.target.closest('#aa-tool-picker')) closeToolList();
    });
    el('aa-add-another').addEventListener('click', () => { buildProviderGrid(); showStep(1); });

    // On the accounts page a link to accounts.html#provider is a same-page
    // anchor, so it would leave the modal open and appear to do nothing.
    // Close the modal and scroll instead; navigate only from other pages.
    el('aa-view-accounts').addEventListener('click', () => {
      const onAccountsPage = window.location.pathname.endsWith('accounts.html');
      if (!onAccountsPage) {
        window.location.href = `accounts.html#${selectedProvider}`;
        return;
      }
      closeModal();
      const group = selectedProvider && document.getElementById(selectedProvider);
      if (group) group.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    el('aa-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(el('aa-snippet').textContent).then(() => {
        const btn = el('aa-copy-btn');
        const original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
    });

    document.querySelectorAll('[data-open-add-account]').forEach(btn => {
      btn.addEventListener('click', () => openModal(null));
    });
    document.querySelectorAll('[data-open-add-account-provider]').forEach(btn => {
      btn.addEventListener('click', () => openModal(btn.dataset.openAddAccountProvider));
    });
  });
})();
