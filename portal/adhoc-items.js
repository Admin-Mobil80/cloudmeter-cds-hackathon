// CloudMeter — the subscriptions behind an "Adhoc Spend" account.
//
// Every other provider is polled: a sync runs, numbers arrive, the page shows
// them. This one has nothing to poll — Claude Pro, ChatGPT Plus, Cursor and
// Midjourney publish no billing API — so this card *is* the data source. Each
// write recomputes six months of snapshots server-side, which is the only
// moment these figures can move.
//
// Amounts are entered and stored in USD, like every other provider's figures;
// the display currency is applied at render time by CM_money. The input is
// labelled USD explicitly because the reader may be looking at rupees
// everywhere else on the page, and a number typed into the wrong currency is a
// mistake nothing downstream can detect.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function myRole() {
    return (window.CM_ME && window.CM_ME.role) || null;
  }

  /** A Member records their own subscriptions; Owners and Admins record anyone's. */
  function canAdd() {
    const role = myRole();
    return role === 'owner' || role === 'admin' || role === 'member';
  }

  /**
   * Whether this particular line may be changed.
   *
   * Decided by the server, which sends `canEdit` per line: a Member owns the
   * lines they are named on and no others. The role fallback covers a response
   * from before that field existed — an older deploy, or a cached page — and
   * errs the way the API does, so the button is never offered where the write
   * would be refused.
   */
  function canEditItem(item) {
    if (item && typeof item.canEdit === 'boolean') return item.canEdit;
    const role = myRole();
    return role === 'owner' || role === 'admin';
  }

  function path(accountId, itemId) {
    const base = `/accounts/${encodeURIComponent(accountId)}/adhoc-items`;
    return itemId ? `${base}/${encodeURIComponent(itemId)}` : base;
  }

  /** "12 May 2026", or "—" for an open-ended date. */
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return esc(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /**
   * What one line costs in a month it is charged in — mirrors chargeAmount()
   * on the server. The full amount either way: an annual plan is paid once, in
   * its renewal month, not divided across the year.
   */
  function chargeAmount(item) {
    return Number(item.amount) || 0;
  }

  /**
   * What to print beside a line.
   *
   * A line recorded at a vendor's own local price prints that figure exactly
   * as it was billed. Everything else in CloudMeter is stored in USD and
   * converted at render time, which is right for a cloud bill that genuinely
   * arrives in dollars — but a ₹1,999 subscription converted back through
   * today's rate reads ₹1,987 one morning and ₹2,004 the next, and neither is
   * a number on anyone's card statement.
   *
   * Only when the currency still matches: a workspace that has since switched
   * to dollars is better served by the converted figure than by rupees it no
   * longer reads anything else in.
   */
  function amountText(item) {
    const charge = chargeAmount(item);
    const code = (window.CM_ME && window.CM_ME.currency && window.CM_ME.currency.code) || 'USD';
    const paid = Number(item.paidAmount);
    if (!item.paidCurrency || item.paidCurrency !== code || !Number.isFinite(paid)) {
      return CM_money(charge);
    }
    const locale = code === 'INR' ? 'en-IN' : 'en-US';
    const decimals = paid % 1 === 0 ? 0 : 2;
    return CM_currencySymbol() + paid.toLocaleString(locale, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
  }

  function describeSubscribers(item) {
    const names = Array.isArray(item.subscribers) ? item.subscribers.filter(Boolean) : [];
    if (names.length === 0) return 'No one named';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
  }

  // ---- rendering -------------------------------------------------------

  function rowHtml(item, i) {
    const ended = item.needsReview;
    // A line only counts toward this month's total if a payment fell in it. An
    // ended subscription never does; a live one whose renewal landed in a
    // previous month doesn't either, and saying "ended" about that one would
    // be plainly wrong — it is still running.
    const counted = item.chargedThisMonth !== false;
    // An annual charge is paid in full in its renewal month, so the figure
    // beside it is that whole payment — saying "per month" about it would be
    // plainly wrong, and dividing it by twelve reported money in eleven months
    // where none had moved.
    const cadenceNote = counted
      ? (item.cadence === 'yearly' ? 'billed yearly — charged this month' : 'per month')
      : ended
        ? 'not counted — ended'
        : item.cadence === 'yearly'
          ? 'billed yearly — not due this month'
          : 'not billed this month';
    return `
      <div class="adhoc-row${counted ? '' : ' is-uncounted'}" data-adhoc-i="${i}">
        <div class="adhoc-main">
          <div class="adhoc-name">
            ${esc(item.name)}
            <span class="adhoc-type">${item.type === 'shared' ? 'Shared' : 'Individual'}</span>
            ${ended ? '<span class="adhoc-flag">Ended</span>' : ''}
            ${!ended && item.needsCheckIn ? '<span class="adhoc-flag is-checkin">Still paying?</span>' : ''}
          </div>
          <div class="adhoc-meta">
            ${esc(describeSubscribers(item))}
            <span class="adhoc-sep">·</span>
            ${fmtDate(item.startsAt)} → ${fmtDate(item.endsAt)}
          </div>
        </div>
        <div class="adhoc-amt">
          <div class="adhoc-amt-value">${amountText(item)}</div>
          <div class="adhoc-amt-note">${esc(cadenceNote)}</div>
        </div>
        ${canEditItem(item) ? `
        <div class="adhoc-actions">
          <button class="btn btn-sm" data-adhoc-edit="${i}">Edit</button>
          <button class="btn btn-sm btn-danger-ghost" data-adhoc-delete="${i}">Remove</button>
        </div>` : ''}
      </div>`;
  }

  function render(state) {
    const list = document.getElementById('adhoc-list');
    const sub = document.getElementById('adhoc-sub');
    if (!list) return;

    list.removeAttribute('aria-busy');

    if (!state.items.length) {
      list.innerHTML = `
        <div class="adhoc-empty">
          <p>No subscriptions recorded yet.</p>
          <p class="muted">Add the AI tools this workspace pays for and they'll
             appear in your dashboard and digests alongside cloud spend.</p>
        </div>`;
    } else {
      // Most expensive first: the question this card answers is "what are we
      // paying the most for", and a creation-ordered list never answers it.
      const ordered = state.items
        .map((item, i) => ({ item, i }))
        .sort((a, b) => chargeAmount(b.item) - chargeAmount(a.item));
      list.innerHTML = ordered.map(({ item, i }) => rowHtml(item, i)).join('');
    }

    if (sub) {
      const n = state.items.length;
      sub.textContent = n === 0
        ? 'AI tools billed outside any cloud provider'
        : `${n} subscription${n === 1 ? '' : 's'} · ${CM_money(state.monthlyTotal)} this month`;
    }

    const review = document.getElementById('adhoc-review');
    if (review) {
      // Only the check-in prompt now. The banner that counted ended
      // subscriptions said what each of their rows already says: an "Ended"
      // chip beside the name, the amount greyed, and "not counted — ended"
      // under it. Three statements of one fact, and the banner was the one
      // furthest from the row it was about.
      //
      // This prompt is different and stays: it is about a line that has NOT
      // ended, is still charging, and nobody has confirmed in months. Nothing
      // on the row says that, because there is no date to have passed.
      const lines = [];
      if (state.checkInCount) {
        lines.push(state.checkInCount === 1
          ? `1 open-ended subscription hasn't been updated in over ${CHECK_IN_MONTHS} months and is still being charged. Check it is still being paid for.`
          : `${state.checkInCount} open-ended subscriptions haven't been updated in over ${CHECK_IN_MONTHS} months and are still being charged. Check they are still being paid for.`);
      }
      review.hidden = lines.length === 0;
      review.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
    }
  }

  // ---- the add / edit dialog -------------------------------------------


  /** Datalists need unique ids; rows are rebuilt often, so this just counts up. */
  let SUB_LIST_ID = 0;

  function subscriberRowHtml(name) {
    const value = name || '';
    // No team loaded — a scoped Member, or the call failed. Typing still works.
    if (!TEAM.length) {
      return `
      <div class="adhoc-sub-row">
        <input class="field-input" data-sub-name maxlength="80" autocomplete="off"
               placeholder="Name" value="${esc(value)}">
        <button type="button" class="btn btn-sm" data-sub-remove aria-label="Remove this person">×</button>
      </div>`;
    }

    // The team, and nothing else — a subscriber must be someone in the
    // workspace. A name already stored that is not in the team stays
    // selectable, labelled, so editing an unrelated field on that row does not
    // quietly erase who it was for; it simply cannot be chosen afresh.
    const known = TEAM.includes(value);
    const legacy = value && !known;

    /*
     * A text box backed by a datalist, not a dropdown.
     *
     * The list is the whole workspace, which on a real team is long enough
     * that finding a name means scrolling past everyone else. Typing narrows
     * it natively, and the box still opens to the full list on click, so the
     * old behaviour is a subset of the new one.
     *
     * Free text is still not a valid subscriber — the server stores whatever
     * name it is given but can only attribute one it recognises, so an
     * invented name becomes a subscriber who is nobody. subscriberValue()
     * below resolves what was typed back to a real team member, and validate()
     * refuses to save anything that does not resolve.
     */
    const listId = `sub-list-${SUB_LIST_ID++}`;
    return `
      <div class="adhoc-sub-row">
        <input class="field-input" data-sub-select list="${listId}" maxlength="80"
               autocomplete="off" placeholder="Type to search…"
               aria-label="Subscriber" value="${esc(value)}">
        <datalist id="${listId}">
          ${TEAM.map((n) => `<option value="${esc(n)}"></option>`).join('')}
          ${legacy ? `<option value="${esc(value)}">${esc(value)} — no longer in the team</option>` : ''}
        </datalist>
        <button type="button" class="btn btn-sm" data-sub-remove aria-label="Remove this person">×</button>
      </div>`;
  }

  /**
   * The name a subscriber row is currently carrying, as the team spells it.
   *
   * What was typed is resolved back to a workspace member, case- and
   * space-insensitively, so "  rohan rahman " becomes "Rohan Rahman" and is
   * attributed to the right person. Anything that resolves to nobody is
   * returned as typed, and validate() rejects it rather than storing a
   * subscriber who does not exist.
   */
  function subscriberValue(row) {
    const select = row.querySelector('[data-sub-select]');
    if (select) {
      const typed = (select.value || '').trim();
      if (!typed) return '';
      const match = TEAM.find((n) => n.toLowerCase() === typed.toLowerCase());
      return match || typed;
    }
    // Only reached when the team could not be read at all — see subscriberRowHtml.
    const input = row.querySelector('[data-sub-name]');
    return input ? (input.value || '').trim() : '';
  }

  /**
   * Names on the form that are not anyone in the workspace.
   *
   * Empty when the team could not be read at all: that path is a free text box
   * by design, and there is nothing to check a name against.
   */
  function unknownSubscribers(root) {
    if (!TEAM.length) return [];
    const known = new Set(TEAM.map((n) => n.toLowerCase()));
    return [...root.querySelectorAll('.adhoc-sub-row')]
      .map(subscriberValue)
      .filter(Boolean)
      .filter((n) => !known.has(n.toLowerCase()));
  }

  /** An empty subscription, dated today. */
  /**
   * An empty subscription, dated today.
   *
   * A Member's starts with their own name already in the first subscriber
   * field, on both Individual and Shared. It is not a guess: the server puts
   * them on their own line whatever the form says, so leaving the field blank
   * asked them to type a name that was going to be added anyway — and on
   * Shared it read as though they had to name themselves before anyone else.
   *
   * Taken from `youAre`, which the server sends as the name the line will
   * actually be filed under, rather than from the display name on the client.
   * The two are normally identical; when they differ, the server's is the one
   * that ends up stored.
   */
  function blankItem(youAre) {
    const mine = (youAre || '').trim();
    return {
      name: '', type: 'individual', subscribers: mine ? [mine] : [], amount: '',
      cadence: 'monthly', startsAt: new Date().toISOString().slice(0, 10), endsAt: '',
    };
  }

  const OTHER = '__other__';

  /**
   * The workspace's team, for the subscriber field.
   *
   * Loaded once per page. An empty list is not an error state — a scoped
   * Member cannot read /team at all — so the field falls back to a plain text
   * box rather than offering nothing.
   */
  let TEAM = [];
  let teamPromise = null;
  function teamReady() {
    if (teamPromise) return teamPromise;
    teamPromise = window.CM_Api.get('/team')
      .then((res) => {
        TEAM = ((res && res.members) || [])
          .filter((m) => m.status !== 'removed')
          .map((m) => (m.name || m.email || '').trim())
          .filter(Boolean)
          // Alphabetical, and case-insensitively so "ravi" does not sort below
          // every capitalised name. localeCompare rather than < so names with
          // accents land where a reader expects them.
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      })
      .catch((err) => {
        console.warn('Team list unavailable — subscriber falls back to typing', err);
        TEAM = [];
      });
    return teamPromise;
  }
  /** Mirrors CHECK_IN_MONTHS on the server; used only for wording. */
  const CHECK_IN_MONTHS = 6;

  /**
   * The plan field: a dropdown of that tool's plans, or a text box.
   *
   * The account is the tool and each line is a plan on it, so with the tool
   * known the plan is a closed list — which is what stops three lines all
   * called "Pro" that nobody can tell apart. A tool the catalogue doesn't
   * cover, or "Other…" on one it does, falls back to typing: a list that
   * blocks an unlisted tool would be worse than no list.
   */
  function planFieldHtml(item, toolName) {
    const plans = (window.CM_AdhocCatalog && window.CM_AdhocCatalog.plansFor(toolName)) || null;
    if (!plans) {
      return `
        <label class="field-label" for="adhoc-name">Plan</label>
        <input class="field-input" id="adhoc-name" maxlength="80" autocomplete="off"
               placeholder="Pro" value="${esc(item.name)}">`;
    }

    // A stored plan that has since left the catalogue stays selectable rather
    // than silently becoming something else when the row is next edited.
    const known = plans.some((p) => p.name === item.name);
    const custom = item.name && !known;

    const selected = custom ? OTHER : item.name;
    const rows = [
      // Every price the plan carries rides along, so a row can be quoted in
      // the workspace's own currency, for either cadence, without looking the
      // plan up again.
      ...plans.map((p) => ({
        value: p.name, name: p.name, usd: p.usd, prices: p.prices, cadence: p.cadence, note: p.note,
        yearlyUsd: p.yearlyUsd, yearlyPrices: p.yearlyPrices,
      })),
      { value: OTHER, name: 'Other…', usd: null, note: null, other: true },
    ];

    return `
      <label class="field-label" id="adhoc-plan-label">Plan</label>
      <div class="cm-select" data-plan-select>
        <button type="button" class="cm-select-btn" data-plan-btn
                aria-haspopup="listbox" aria-expanded="false" aria-labelledby="adhoc-plan-label">
          <span class="cm-select-value" data-plan-value>${esc(planButtonText(selected, rows))}</span>
          <svg class="cm-select-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <ul class="cm-select-list" role="listbox" data-plan-list hidden
            aria-labelledby="adhoc-plan-label">
          ${rows.map((r) => optionRow(r, r.value === selected)).join('')}
        </ul>
      </div>
      <input type="hidden" id="adhoc-plan" value="${esc(selected)}">
      <input class="field-input" id="adhoc-name" maxlength="80" autocomplete="off"
             style="margin-top:8px" placeholder="Plan name"
             value="${esc(custom ? item.name : '')}" ${custom ? '' : 'hidden'}>`;
  }

  /**
   * One row of the list: the plan's name, and any qualifier beneath it.
   *
   * No price. The list can only ever show one of a plan's two figures, and
   * whichever it showed would contradict the Billed selector the moment that
   * moved — "Pro · ₹2,399/mo" sitting above a yearly cost box is the picker
   * arguing with the field it fills. The cost box below is the one place the
   * price is stated, and it follows the cadence.
   *
   * The note stays: "per seat" and "negotiated" qualify which plan this is,
   * which is exactly what the list is for.
   */
  function optionRow(row, isSelected) {
    const showNote = !!row.note;
    return `
      <li role="option" class="cm-option${isSelected ? ' is-selected' : ''}${row.other ? ' is-other' : ''}"
          data-value="${esc(row.value)}" aria-selected="${isSelected}" tabindex="-1">
        <span class="cm-option-name">${esc(row.name)}</span>
        ${showNote ? `<span class="cm-option-note">${esc(row.note)}</span>` : ''}
      </li>`;
  }

  /** What the closed control reads, for a given value. */
  function planButtonText(value, rows) {
    if (!value) return 'Choose a plan…';
    const row = rows.find((r) => r.value === value);
    if (!row) return value;
    return row.other ? 'Other…' : row.name;
  }

  /**
   * The subscription fields, as markup.
   *
   * Shared by the edit dialog here and by the "Add account" flow, which
   * collects the first subscription while the account is being created — one
   * definition, because two forms for the same seven fields is how the two
   * quietly stop agreeing about which of them are required.
   *
   * @param toolName  the account's own name, which is the tool. Decides
   *                  whether the plan is a dropdown or a text box.
   */
  function fieldsHtml(item, toolName) {
    return `
      ${planFieldHtml(item, toolName)}

      <label class="field-label" style="margin-top:14px">Type of subscription</label>
      <div class="seg-control adhoc-type-switch" id="adhoc-type">
        <button type="button" data-type="individual"
          class="${item.type !== 'shared' ? 'active' : ''}">Individual</button>
        <button type="button" data-type="shared"
          class="${item.type === 'shared' ? 'active' : ''}">Shared</button>
      </div>

      <div id="adhoc-subs-block">
        <label class="field-label" style="margin-top:14px" id="adhoc-subs-label">Subscriber</label>
        <div id="adhoc-subs"></div>
        <button type="button" class="btn btn-sm" id="adhoc-sub-add" hidden>+ Add another person</button>
      </div>

      <div class="adhoc-grid">
        <div>
          <label class="field-label" for="adhoc-amount" id="adhoc-amount-label">Cost (USD)</label>
          <!-- The figure is the plan's, not the reader's: picking a plan fills
               it and it cannot be typed over. Kept as a real input so every
               existing read of #adhoc-amount still works; "Other…" re-enables
               it, because a tool the catalogue has never heard of has no price
               to fill and a locked empty box would block the entry entirely. -->
          <input class="field-input" id="adhoc-amount" type="number" min="0" step="0.01"
                 inputmode="decimal" placeholder="20.00" value="${esc(item.amount)}">
          <p class="field-hint" id="adhoc-amount-note" hidden></p>
        </div>
        <div>
          <label class="field-label" for="adhoc-cadence">Billed</label>
          <select class="field-input" id="adhoc-cadence">
            <option value="monthly" ${item.cadence !== 'yearly' ? 'selected' : ''}>Monthly</option>
            <option value="yearly" ${item.cadence === 'yearly' ? 'selected' : ''}>Yearly</option>
          </select>
        </div>
      </div>

      <div class="adhoc-grid">
        <div>
          <label class="field-label" for="adhoc-starts">Start date</label>
          <input class="field-input" id="adhoc-starts" type="date" value="${esc(item.startsAt)}"
                 ${item.needsReview ? 'disabled' : ''}>
        </div>
        <div>
          <label class="field-label" for="adhoc-ends">End date <span class="muted">(optional)</span></label>
          <input class="field-input" id="adhoc-ends" type="date" value="${esc(item.endsAt || '')}">
        </div>
      </div>
      ${item.needsReview ? `
      <p class="field-hint">
        This subscription has ended, so its start date is fixed — moving it would
        rewrite months that have already been reported. Change the end date to
        extend it, or add a new subscription for a new period.
      </p>` : ''}
      <p class="field-hint" id="adhoc-recur-hint"></p>
`;
  }

  /**
   * Brings the fields to life inside `root` and hands back a reader.
   *
   * @returns {{read: function, validate: function}} `read()` gives the request
   *   body; `validate(body)` gives null, or `{message, focus}` naming the first
   *   thing wrong with it. The server re-checks all of it — this exists so the
   *   answer arrives at the field rather than after a round trip.
   */
  /**
   * Makes the plan listbox behave like the select it replaced.
   *
   * The value still lives in a hidden #adhoc-plan and a `change` event is still
   * dispatched on it, so everything downstream — reading the plan, filling the
   * cost, validating — is untouched by the control being custom.
   *
   * Keyboard support is not optional here: replacing a native select means
   * inheriting what it did for free. Arrows move, Enter and Space choose, Esc
   * closes and returns focus, and the list closes on any click outside it.
   */
  function wirePlanSelect(root) {
    const wrap = root.querySelector('[data-plan-select]');
    if (!wrap) return;

    const btn = wrap.querySelector('[data-plan-btn]');
    const list = wrap.querySelector('[data-plan-list]');
    const valueEl = wrap.querySelector('[data-plan-value]');
    const hidden = root.querySelector('#adhoc-plan');
    const options = [...list.querySelectorAll('.cm-option')];

    let active = Math.max(0, options.findIndex((o) => o.classList.contains('is-selected')));

    function paintActive() {
      options.forEach((o, i) => o.classList.toggle('is-active', i === active));
      options[active]?.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      list.hidden = false;
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      paintActive();
    }

    function close({ focusBtn = true } = {}) {
      list.hidden = true;
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      if (focusBtn) btn.focus();
    }

    function choose(i) {
      const opt = options[i];
      if (!opt) return;
      active = i;
      options.forEach((o) => {
        o.classList.remove('is-selected');
        o.setAttribute('aria-selected', 'false');
      });
      opt.classList.add('is-selected');
      opt.setAttribute('aria-selected', 'true');

      hidden.value = opt.dataset.value;
      valueEl.textContent = opt.classList.contains('is-other')
        ? 'Other…'
        : (opt.querySelector('.cm-option-name')?.textContent || opt.dataset.value);

      close();
      // The one event everything downstream listens for.
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    btn.addEventListener('click', () => (list.hidden ? open() : close()));

    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.cm-option');
      if (opt) choose(options.indexOf(opt));
    });

    // Hovering moves the active row so mouse and keyboard don't disagree about
    // which one Enter would take.
    list.addEventListener('mousemove', (e) => {
      const opt = e.target.closest('.cm-option');
      if (opt) { active = options.indexOf(opt); paintActive(); }
    });

    wrap.addEventListener('keydown', (e) => {
      const isOpen = !list.hidden;
      if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault(); open(); return;
      }
      if (!isOpen) return;

      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, options.length - 1); paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paintActive(); }
      else if (e.key === 'Home') { e.preventDefault(); active = 0; paintActive(); }
      else if (e.key === 'End') { e.preventDefault(); active = options.length - 1; paintActive(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close({ focusBtn: false });
    });

    // Listens on the document because the click that dismisses this may land
    // anywhere — including on another field in the same dialog.
    document.addEventListener('click', (e) => {
      if (!list.hidden && !wrap.contains(e.target)) close({ focusBtn: false });
    });
  }

  /**
   * Says what happens when the end date is left empty.
   *
   * Worded from the Billed selector rather than hardcoded: an annual plan left
   * open-ended recurs every year, and telling someone it recurs monthly would
   * be plainly wrong on the one screen where they are deciding the figure.
   */
  function paintRecurHint(root) {
    const hint = root.querySelector('#adhoc-recur-hint');
    const cadence = root.querySelector('#adhoc-cadence');
    if (!hint || !cadence) return;
    const every = cadence.value === 'yearly' ? 'year' : 'month';
    hint.textContent = `If no end date is entered, the cost recurs every ${every} until one is added.`;
  }

  function wireFields(root, item, toolName) {
    const planSelect = root.querySelector('#adhoc-plan');
    wirePlanSelect(root);
    paintRecurHint(root);
    root.querySelector('#adhoc-cadence')?.addEventListener('change', () => paintRecurHint(root));
    const nameInput = root.querySelector('#adhoc-name');
    const amountInput = root.querySelector('#adhoc-amount');

    const amountLabel = root.querySelector('#adhoc-amount-label');
    const amountNote = root.querySelector('#adhoc-amount-note');

    /*
     * The Cost box holds the figure the subscriber is actually billed, in the
     * currency they are billed in — ₹2,399, the price on Anthropic's Indian
     * page, because a plan that reads "Pro · ₹2,399/mo" two fields above and
     * "25.08" here is two answers to one question.
     *
     * `costCurrency` is what the number in the box means, and it is a property
     * of the line rather than of the workspace: a plan with no rupee price on
     * file is quoted in dollars even to a rupee workspace, and the label says
     * so instead of the number quietly changing meaning.
     *
     * `costRate` turns it into the USD every roll-up totals in. That is the
     * one conversion in here, it happens once on save, and the rate travels
     * with the line so the arithmetic can be checked rather than redone.
     */
    const pricing = (window.CM_AdhocCatalog && window.CM_AdhocCatalog.pricing())
      || { currency: 'USD', rate: 1 };
    let costCurrency = 'USD';
    let costRate = 1;

    function setCostCurrency(code, rate) {
      costCurrency = code || 'USD';
      costRate = costCurrency === 'USD' ? 1 : (Number(rate) || 1);
      if (amountLabel) amountLabel.textContent = `Cost (${costCurrency})`;
    }

    /** Shows what a chosen plan costs, and stops it being typed over. */
    function showQuote(quote) {
      setCostCurrency(quote.currency, quote.rate);
      amountInput.value = String(Number(quote.amount.toFixed(2)));
      amountInput.readOnly = true;
      amountInput.classList.add('is-locked');
      if (!amountNote) return;

      const catalog = window.CM_AdhocCatalog;
      const per = quote.cadence === 'yearly' ? 'a year' : 'a month';
      const shown = `${catalog.quoteText(quote)} ${per}`;
      // "including" and "plus" are not decoration: one says the figure is
      // complete, the other that tax was added on top of a list price.
      const taxed = !quote.taxLabel ? shown
        : quote.taxIncluded ? `${shown}, ${quote.taxLabel} included`
          : `${shown}, list price plus ${quote.taxLabel}`;
      amountNote.hidden = false;
      amountNote.textContent = quote.isLocal
        ? `${taxed} — the price ${toolName || 'the vendor'} publishes here. Change the plan to change it.`
        // No local price on file, so the vendor's own dollar figure stands.
        // Saying so is the difference between "correct" and "looks like it
        // forgot the rupees".
        : `${taxed} — this plan has no ${catalog.pricing().currency} price on file, so the vendor's USD price is shown.`;
    }

    /**
     * Back to a typed figure — only "Other…" and unpriced plans get here.
     *
     * Typed in the workspace's own currency, because that is what the person
     * paying it reads on their card statement. A rupee workspace typing 2399
     * means ₹2,399, not $2,399.
     */
    function unlockAmount() {
      setCostCurrency(pricing.currency, pricing.rate);
      amountInput.readOnly = false;
      amountInput.classList.remove('is-locked');
      if (amountNote) { amountNote.hidden = true; amountNote.textContent = ''; }
    }

    // An existing line opened for editing keeps its stored figures: they came
    // from a plan, at the price and rate of the day it was recorded, and
    // re-quoting it here would silently reprice a subscription nobody touched.
    if (Number.isFinite(Number(item.paidAmount)) && item.paidCurrency) {
      setCostCurrency(item.paidCurrency, Number(item.paidRate) || 1);
      amountInput.value = String(Number(item.paidAmount));
    } else if (String(item.amount) === '') {
      // Nothing recorded yet. The box is empty and typeable, so it is in the
      // currency whoever fills it in actually pays.
      setCostCurrency(pricing.currency, pricing.rate);
    } else {
      // Recorded before local prices existed, or bought in dollars: the box
      // holds the USD it was stored as, labelled as such. Converting it for
      // display would invent the figure this whole path exists to avoid.
      setCostCurrency('USD', 1);
    }
    if (planSelect && planSelect.value && planSelect.value !== OTHER && String(item.amount) !== '') {
      amountInput.readOnly = true;
      amountInput.classList.add('is-locked');
      if (amountNote && costCurrency !== 'USD') {
        amountNote.hidden = false;
        amountNote.textContent = 'Recorded at the price on the day. Change the plan to change it.';
      }
    }

    /*
     * Re-quotes from the plan and the Billed selector together.
     *
     * The two are one question — "what does a year of Pro cost" is a
     * different figure from "what does a month of Pro cost", and the vendor
     * publishes them separately or not at all. Switching Billed therefore
     * re-prices rather than leaving a monthly figure sitting under "Yearly",
     * which would report twelve times the real cost with nothing downstream
     * able to catch it.
     *
     * `preferPlanCadence` is for choosing a plan: a plan sold only by the
     * year moves the selector to match. Switching Billed by hand does not,
     * because that is the reader stating the answer.
     */
    function requote(preferPlanCadence) {
      const chosen = planSelect && planSelect.value;
      const cadenceInput = root.querySelector('#adhoc-cadence');
      const catalog = window.CM_AdhocCatalog;
      if (!chosen || chosen === OTHER || !catalog) { amountInput.value = ''; unlockAmount(); return; }

      if (preferPlanCadence) {
        const plan = catalog.planFor(toolName, chosen);
        // Sold only by the year: the selector follows, because leaving it on
        // Monthly would quote nothing and read as a missing price.
        if (plan && !plan.usd && plan.usd !== 0 && catalog.hasYearlyPrice(plan) && cadenceInput) {
          cadenceInput.value = 'yearly';
        }
      }

      const cadence = cadenceInput ? cadenceInput.value : 'monthly';
      const quote = catalog.quoteFor(toolName, chosen, cadence);

      // "Other…", a plan with no published figure (Enterprise), or a year
      // the vendor never priced: there is nothing to fill, so the box is
      // handed back rather than left locked and empty.
      if (!quote) {
        amountInput.value = '';
        unlockAmount();
        if (amountNote && cadence === 'yearly') {
          amountNote.hidden = false;
          amountNote.textContent = `${toolName || 'This vendor'} publishes no price for a year of this plan, `
            + 'so there is nothing to fill in. Enter what you are charged.';
        }
        return;
      }

      showQuote(quote);
    }

    if (planSelect) {
      planSelect.addEventListener('change', () => {
        const other = planSelect.value === OTHER;
        nameInput.hidden = !other;
        if (other) { nameInput.value = ''; nameInput.focus(); }
        requote(true);
      });
    }
    root.querySelector('#adhoc-cadence')?.addEventListener('change', () => requote(false));

    const subsWrap = root.querySelector('#adhoc-subs');
    const subsAdd = root.querySelector('#adhoc-sub-add');
    const subsLabel = root.querySelector('#adhoc-subs-label');
    const typeSwitch = root.querySelector('#adhoc-type');
    let type = item.type === 'shared' ? 'shared' : 'individual';

    /*
     * A Member used to get a disabled box with their own name and no way to
     * add anyone, while the Individual/Shared switch above it stayed live —
     * so choosing Shared appeared to do nothing.
     *
     * They now get the same picker as everyone else. One rule still holds and
     * the server enforces it: a Member is always on their own line, added
     * silently if the form leaves them off. They can say who else shares a
     * subscription; they cannot file one they have no part in.
     */
    function paintSubscribers() {
      const shared = type === 'shared';
      subsLabel.textContent = shared ? 'Subscribers' : 'Subscriber';
      subsAdd.hidden = !shared;

      const current = [...subsWrap.querySelectorAll('.adhoc-sub-row')].map(subscriberValue);
      const names = current.length ? current : (item.subscribers || []);
      // Individual is exactly one person by definition; collapsing to the first
      // name is what the reader means by switching, and keeping three inputs
      // around would silently save all three.
      const shown = shared ? (names.length ? names : ['']) : [names[0] || ''];
      subsWrap.innerHTML = shown.map(subscriberRowHtml).join('');
      syncRemoveButtons();
    }

    /** The last remaining name can't be removed — there'd be nobody left. */
    function syncRemoveButtons() {
      const rows = subsWrap.querySelectorAll('.adhoc-sub-row');
      rows.forEach(r => {
        // A Member's locked row has no remove button — there is nothing to
        // remove and nothing to add it back.
        const btn = r.querySelector('[data-sub-remove]');
        if (btn) btn.hidden = type !== 'shared' || rows.length <= 1;
      });
    }

    // Delegated rather than wired per button: rows are added and rebuilt as the
    // type switches, and re-wiring on each of those paths is how a handler ends
    // up attached twice and a single click removes two people.
    subsWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sub-remove]');
      if (!btn) return;
      btn.closest('.adhoc-sub-row').remove();
      syncRemoveButtons();
    });

    typeSwitch.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        type = btn.dataset.type;
        typeSwitch.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        paintSubscribers();
      });
    });

    subsAdd.addEventListener('click', () => {
      subsWrap.insertAdjacentHTML('beforeend', subscriberRowHtml(''));
      syncRemoveButtons();
      const last = subsWrap.querySelector('.adhoc-sub-row:last-child');
      (last.querySelector('[data-sub-select]') || last.querySelector('[data-sub-name]')).focus();
    });

    paintSubscribers();

    return {
      read() {
        // The dropdown is the plan name unless it's on "Other…", where the
        // text box beside it is.
        const chosen = planSelect && planSelect.value;
        const name = (chosen && chosen !== OTHER)
          ? chosen
          : root.querySelector('#adhoc-name').value.trim();
        // What the box holds, and what it is worth in the USD every total is
        // kept in. The two are the same number unless the line is priced in
        // something else, which is the only place a rate is applied at all.
        const typed = Number(root.querySelector('#adhoc-amount').value);
        const local = costCurrency !== 'USD' && Number.isFinite(typed);
        const usd = local ? Math.round((typed / (costRate || 1)) * 100) / 100 : typed;

        return {
          name,
          type,
          amount: usd,
          cadence: root.querySelector('#adhoc-cadence').value,
          // Whoever the form says, for everyone. A Member used to be special-
          // cased here, back when their field was disabled and carried no
          // value: their rows were thrown away and replaced with their own
          // name. The field became a real picker and this did not follow, so
          // a Member could name colleagues on a shared subscription, save it,
          // and get a line with only themselves on it — the names were never
          // sent. The server still puts a Member on their own line if the
          // form leaves them off; that is where the rule belongs.
          subscribers: [...root.querySelectorAll('.adhoc-sub-row')]
            .map(subscriberValue).filter(Boolean),
          startsAt: root.querySelector('#adhoc-starts').value,
          endsAt: root.querySelector('#adhoc-ends').value || null,
          // What is actually billed, where that is not dollars. Sent alongside
          // the USD rather than instead of it: the roll-ups need one currency,
          // the card needs this one.
          ...(local ? {
            paidAmount: typed, paidCurrency: costCurrency, paidRate: costRate,
          } : {}),
        };
      },
      validate(body) {
        if (!body.name) {
          // Points at whichever control is actually on screen — telling someone
          // to fill a hidden text box is worse than no message.
          return planSelect && planSelect.value !== OTHER
            // The button, not the hidden input behind it — focusing something
            // display:none does nothing at all.
            ? { message: 'Choose a plan.', focus: '[data-plan-btn]' }
            : { message: 'Give the plan a name.', focus: '#adhoc-name' };
        }
        if (!Number.isFinite(body.amount) || body.amount < 0) {
          return { message: 'Cost must be a number, and cannot be negative.', focus: '#adhoc-amount' };
        }
        /*
         * A subscriber has to be somebody.
         *
         * The field is a text box now so it can be searched, which means it
         * will also accept anything typed. The server stores whatever name it
         * is given but can only attribute one it recognises, so an invented
         * name becomes a subscriber who is nobody — counted in "total users",
         * attributed to no one, and impossible to notice afterwards.
         *
         * Names already stored for someone since removed from the workspace
         * are exempt: they were valid when saved, and refusing them here would
         * make an old line impossible to edit at all.
         */
        const wasStored = new Set((item.subscribers || []).map((n) => String(n).toLowerCase()));
        const strangers = unknownSubscribers(root).filter((n) => !wasStored.has(n.toLowerCase()));
        if (strangers.length) {
          return {
            message: `${strangers[0]} isn't in this workspace — pick a name from the list.`,
            focus: '[data-sub-select]',
          };
        }

        /*
         * One person, one row.
         *
         * Nothing stops the same name being picked twice — the rows are
         * independent text boxes — and a line reading "lavanya, lavanya" is
         * how it shows up afterwards. The head count is unaffected, since it
         * counts distinct people, so the duplicate is invisible in every
         * figure and visible only in the list, where it looks like the record
         * is wrong about who is on it.
         *
         * Refused rather than quietly merged: two rows for one person is
         * usually the second one meant to be somebody else, and dropping it
         * silently would save a line missing a subscriber they thought they
         * had added. Matched case- and space-insensitively, because the box
         * accepts what is typed — "lavanya" and "Lavanya " are one person.
         */
        const seen = new Set();
        const rows = [...root.querySelectorAll('.adhoc-sub-row')];
        for (let i = 0; i < rows.length; i++) {
          const name = subscriberValue(rows[i]);
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) {
            return {
              message: `${name} is already on this subscription — remove the extra row, or pick someone else.`,
              // The duplicate row itself, not the first one: the one to change
              // is the one they are being told about.
              focus: `.adhoc-sub-row:nth-of-type(${i + 1}) input`,
            };
          }
          seen.add(key);
        }

        if (!body.startsAt) return { message: 'Enter a start date.', focus: '#adhoc-starts' };
        if (body.endsAt && body.endsAt < body.startsAt) {
          return { message: 'The end date cannot be before the start date.', focus: '#adhoc-ends' };
        }
        return null;
      },
    };
  }

  function openEditor(state, existing, onSaved) {
    const isNew = !existing;
    const item = existing || blankItem(state && state.youAre);

    const dlg = document.createElement('dialog');
    dlg.className = 'modal scope-modal adhoc-modal';
    dlg.innerHTML = `
      <h2>${isNew ? 'Add a subscription' : `Edit ${esc(item.name)}`}</h2>
      <p class="modal-sub">
        A plan this workspace pays for that no billing API reports. Its cost is
        counted in the month each payment is made — every month for a monthly
        plan, once a year for an annual one.
      </p>
      ${fieldsHtml(item, state.toolName)}
      <p class="field-error" id="adhoc-error"></p>
      <div class="modal-actions">
        <button class="btn" data-adhoc-cancel>Cancel</button>
        <button class="btn btn-primary" data-adhoc-save>${isNew ? 'Add subscription' : 'Save changes'}</button>
      </div>`;

    document.body.appendChild(dlg);
    dlg.showModal();

    const fields = wireFields(dlg, item, state.toolName);
    const err = dlg.querySelector('#adhoc-error');
    const first = dlg.querySelector('[data-plan-btn]')
      || dlg.querySelector('#adhoc-name:not([hidden])');
    if (first) first.focus();

    const close = () => { dlg.close(); dlg.remove(); };
    dlg.querySelector('[data-adhoc-cancel]').addEventListener('click', close);

    const fail = (msg, focus) => {
      err.textContent = msg;
      err.classList.add('show');
      // Tolerant of a selector that matches nothing: the message is the point,
      // and a missed focus target used to throw here and swallow it entirely.
      const target = focus && dlg.querySelector(focus);
      if (target) target.focus();
    };

    const save = dlg.querySelector('[data-adhoc-save]');
    save.addEventListener('click', async () => {
      const body = fields.read();
      const bad = fields.validate(body);
      if (bad) return fail(bad.message, bad.focus);

      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const res = existing
          ? await window.CM_Api.patch(path(state.accountId, existing.id), body)
          : await window.CM_Api.post(path(state.accountId), body);
        close();
        onSaved(res);
      } catch (e) {
        save.disabled = false;
        save.textContent = isNew ? 'Add subscription' : 'Save changes';
        fail(e.message || 'Could not save that subscription.');
      }
    });
  }

  function confirmRemove(state, item, onDone) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal scope-modal';
    dlg.innerHTML = `
      <h2>Remove ${esc(item.name)}?</h2>
      <p class="modal-sub">
        This takes ${esc(item.name)} out of every month it was counted in, not
        just from today — the reported history changes to say this was never
        paid. If it was paid and has simply stopped, set an end date instead.
      </p>
      <p class="field-error" id="adhoc-del-error"></p>
      <div class="modal-actions">
        <button class="btn" data-del-cancel>Cancel</button>
        <button class="btn btn-danger" data-del-go>Remove subscription</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.showModal();

    const close = () => { dlg.close(); dlg.remove(); };
    dlg.querySelector('[data-del-cancel]').addEventListener('click', close);

    const go = dlg.querySelector('[data-del-go]');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Removing…';
      try {
        const res = await window.CM_Api.delete(path(state.accountId, item.id));
        close();
        onDone(res);
      } catch (e) {
        go.disabled = false;
        go.textContent = 'Remove subscription';
        const err = dlg.querySelector('#adhoc-del-error');
        err.textContent = e.message || 'Could not remove that subscription.';
        err.classList.add('show');
      }
    });
  }

  // ---- mount -----------------------------------------------------------

  /**
   * @param account    the adhoc account being viewed.
   * @param onChanged  called after any successful write, with the new view, so
   *                   the page can re-pull the figures this card just moved.
   */
  async function mount(account, onChanged, opts = {}) {
    const section = document.getElementById('adhoc-section');
    if (!section) return;
    section.hidden = false;

    // The account is the tool — "Claude" — and each item under it is a plan.
    const state = {
      accountId: account.id, toolName: account.name,
      items: [], monthlyTotal: 0, checkInCount: 0,
      // Set from the response: whether this is one person's slice of the
      // account, and the name their new lines are filed under.
      scoped: false, youAre: null, teamNames: null,
    };

    const addBtn = document.getElementById('adhoc-add');
    if (addBtn) addBtn.hidden = !canAdd();

    // The plan list is maintained in BMS, so fetch it before any dropdown is
    // built. Awaited here rather than at each call site: a dialog opened
    // against the built-in list would silently offer stale prices.
    // Both lists are needed before a dialog can render: the plans for the plan
    // field, the team for the subscriber field.
    await Promise.all([
      window.CM_AdhocCatalog && window.CM_AdhocCatalog.ready
        ? window.CM_AdhocCatalog.ready() : null,
      teamReady(),
    ]);

    function apply(res) {
      state.items = (res && res.items) || [];
      state.monthlyTotal = (res && res.monthlyTotal) || 0;
      state.checkInCount = (res && res.checkInCount) || 0;
      state.scoped = !!(res && res.scoped);
      state.youAre = (res && res.youAre) || null;
      // A Member cannot read /team, so the adhoc response carries the names
      // instead. Seeding TEAM from it is what lets their subscriber picker
      // work at all.
      state.teamNames = (res && res.teamNames) || null;
      if (state.teamNames && state.teamNames.length && !TEAM.length) TEAM = state.teamNames.slice();
      render(state);
      wireRows();
    }

    function afterWrite(res) {
      apply(res);
      if (onChanged) onChanged(res);
    }

    function wireRows() {
      document.querySelectorAll('#adhoc-list [data-adhoc-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
          openEditor(state, state.items[+btn.dataset.adhocEdit], afterWrite);
        });
      });
      document.querySelectorAll('#adhoc-list [data-adhoc-delete]').forEach(btn => {
        btn.addEventListener('click', () => {
          confirmRemove(state, state.items[+btn.dataset.adhocDelete], afterWrite);
        });
      });
    }

    if (addBtn) {
      addBtn.addEventListener('click', () => openEditor(state, null, afterWrite));
    }

    try {
      apply(await window.CM_Api.get(path(account.id)));
      /*
       * Straight into the dialog when the tool was just created.
       *
       * Naming a tool and recording what someone pays for it are one act:
       * an empty "Claude" account is of no use to anybody, and the old flow
       * ended on a success screen telling the reader to go and find the
       * account they had that moment made. Opened after the first load, so
       * the plan list and the team roster are already in hand.
       *
       * Only for someone who may add — a Member whose role has since changed
       * would otherwise meet a dialog that cannot save.
       */
      if (opts.addOnLoad && canAdd()) openEditor(state, null, afterWrite);
    } catch (e) {
      window.CM_renderLoadError(e, 'adhoc-list');
    }
  }

  window.CM_Adhoc = {
    mount,
    chargeAmount,
    // For the "Add account" flow, which collects the first subscription on the
    // same screen that names the account.
    blankItem,
    fieldsHtml,
    wireFields,
    createItem: (accountId, body) => window.CM_Api.post(path(accountId), body),
  };
})();
