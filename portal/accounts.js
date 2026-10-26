// CloudMeter — Cloud Accounts page, backed by the real Accounts API.

let ACCOUNTS = [];
// Most restrictive until /me resolves, so a Remove button never flashes to
// someone who can't use it.
let callerRole = 'member';
let callerUserId = null;

// Owners can remove any account. Admins can remove only what they connected —
// removal destroys stored credentials and cost history, so one Admin shouldn't
// be able to undo another's work. An account connected before we recorded a
// creator counts as unknown, not as theirs.
// Account names and owner text are free-form and typed by teammates, so they
// go through here before landing in innerHTML.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * This caller's role.
 *
 * Read from CM_ME first, falling back to the cached role.
 *
 * auth-guard sets window.CM_ME *before* it dispatches cm-me-loaded, so this is
 * correct no matter which of the two async chains — /me or /accounts —
 * finishes first. Relying only on the event meant a render that happened to
 * land in the wrong order drew the rows without their Remove control and
 * nothing re-drew them.
 */
function currentRole() {
  return (window.CM_ME && window.CM_ME.role) || callerRole;
}

// Owners and Admins can remove any account in the tenant. Members never can,
// whatever they're mapped to — reading an account's costs is not the same as
// being able to destroy it and its stored history.
function canRemove() {
  const role = currentRole();
  return role === 'owner' || role === 'admin';
}

function isMember() {
  return currentRole() === 'member';
}

document.addEventListener('cm-me-loaded', (e) => {
  callerRole = e.detail.role || 'member';
  callerUserId = e.detail.userId || null;
  // Unconditional: the old `if (ACCOUNTS.length)` guard skipped the re-render
  // whenever /me won the race, which is exactly when the first render had the
  // least information to work with.
  renderAccounts();
});

/**
 * How many people are on an adhoc tool.
 *
 * Takes the place of the external id on these rows, which for a tool is the
 * name again — "Claude" under "Claude", a line of pixels saying nothing. The
 * useful fact about a tool is how many of us are on it.
 *
 * Counted server-side, and sent only to an Owner or an Admin: a Member reads
 * only their own lines inside these accounts, so how many colleagues are on a
 * tool is not theirs. They get nothing on that line rather than the name
 * echoed back at them, which is what it said before and said nothing.
 */
function adhocUsers(a) {
  const n = a.subscribers;
  if (n === null) return '';
  // Undefined rather than null is a response from before the field existed.
  // Falling back to the id keeps such a row looking as it did, rather than
  // silently claiming nobody uses the tool.
  if (typeof n !== 'number') return a.externalId;
  const people = n === 0 ? 'No one yet' : `${n} ${n === 1 ? 'user' : 'users'}`;

  /*
   * The subscription count beside the head count.
   *
   * They answer different questions and the pair is the point: "11 users · 11
   * subscriptions" is eleven separate purchases of one tool and an argument
   * for a team plan, while "11 users · 1 subscription" is already
   * consolidated. The head count alone reads identically in both.
   *
   * Absent on a response from before this existed — an older deploy, or a
   * cached page — where the row simply reads as it always did rather than
   * claiming nothing is running.
   */
  const s = a.subscriptions;
  if (typeof s !== 'number' || s === 0) return people;
  return `${people} · ${s} ${s === 1 ? 'subscription' : 'subscriptions'}`;
}

function fmt(n) { return CM_money(n, { decimals: 0 }); }

/*
 * Which provider the page is scoped to, from the URL hash.
 *
 * The dashboard's "Spend by provider" rows have always linked here as
 * accounts.html#aws, and nothing read it — so clicking AWS landed on a page
 * listing every provider, with AWS somewhere in it. The link promised a filter
 * and delivered an anchor.
 *
 * An unknown provider, or one with no accounts, falls back to showing
 * everything rather than an empty page: a stale link should degrade to the
 * full list, not to something that looks like the workspace lost its accounts.
 */
function providerFilter() {
  const key = decodeURIComponent((window.location.hash || '').replace(/^#/, '')).trim().toLowerCase();
  if (!key) return null;
  if (!PROVIDER_ORDER.includes(key)) return null;
  return ACCOUNTS.some(a => a.provider === key) ? key : null;
}

/*
 * The way back to every provider, when the page is scoped to one.
 *
 * Deliberately a line of text rather than a panel. The first version was a
 * bordered card with the provider's badge, a bold heading and a button, which
 * announced a filter nobody needed announcing — the group below it already
 * carries the provider's name and badge in a larger size. One quiet link says
 * the same thing and stops competing with the content.
 *
 * Still worth having: without it the only exit is the sidebar, which is not
 * obviously a way out of a filter the user reached from the dashboard.
 */
function backToAllHtml() {
  return `
    <button type="button" class="provider-filter-back" id="clear-provider-filter">
      ← All providers
    </button>`;
}

function renderAccounts() {
  renderStats();
  const container = document.getElementById('accounts-container');

  /*
   * "Ask an Owner or Admin to add an account" is true of a Member on every
   * screen but one: an empty workspace, where the button beside it is theirs
   * to press. Decided on each render rather than hidden once, so a Member who
   * is later granted an account — or who has some withheld — gets the banner
   * back the moment it is true again.
   */
  const banner = document.querySelector('.readonly-banner');
  if (banner) {
    banner.hidden = isMember()
      && ACCOUNTS.length === 0
      && !(window.CM_ACCOUNTS_HIDDEN || 0);
  }

  if (ACCOUNTS.length === 0) {
    // A Member sees only the accounts they've been mapped to. When the
    // organisation has some and none of them are this person's, "nothing is
    // connected" is simply untrue, and it sends them to an Add button they
    // aren't allowed to use instead of to the person who can grant access.
    const hidden = window.CM_ACCOUNTS_HIDDEN || 0;
    container.innerHTML = hidden > 0
      ? `
      <section class="card" style="text-align:center; padding:48px 24px;">
        <div style="font-size:32px; margin-bottom:12px">🔒</div>
        <h2 style="font-size:16px; margin:0 0 8px">No cloud accounts shared with you yet</h2>
        <p style="font-size:13.5px; color:var(--text-secondary); max-width:460px; margin:0 auto">This organisation has ${hidden} connected cloud ${hidden === 1 ? 'account' : 'accounts'}, but ${hidden === 1 ? 'it has' : 'none have'} been assigned to you. Ask your account Owner or an Admin to give you access, and ${hidden === 1 ? 'it' : 'they'}'ll appear here.</p>
      </section>`
      : isMember()
        // A Member cannot connect a cloud bill, so offering them AWS is an
        // invitation to a 403. Adhoc Spend is the one thing they can start
        // here, and in an empty workspace there is nobody's account to add it
        // to — so this is where it gets created. The server allows exactly
        // this: a Member, provider adhoc, and only while the workspace has no
        // accounts at all.
        ? `
      <section class="card" style="text-align:center; padding:48px 24px;">
        <div style="font-size:32px; margin-bottom:12px">🧾</div>
        <h2 style="font-size:16px; margin:0 0 8px">Nothing connected yet</h2>
        <p style="font-size:13.5px; color:var(--text-secondary); max-width:470px; margin:0 auto 16px">Cloud accounts are connected by an Owner or an Admin. You can start an <strong>Adhoc Spend</strong> account yourself — that is where everyone records what they pay for tools like Claude or ChatGPT, which no billing API reports.</p>
        <button class="btn btn-primary" data-open-adhoc>+ Start Adhoc Spend</button>
      </section>`
        : `
      <section class="card" style="text-align:center; padding:48px 24px;">
        <div style="font-size:32px; margin-bottom:12px">☁️</div>
        <h2 style="font-size:16px; margin:0 0 8px">No cloud accounts connected yet</h2>
        <p style="font-size:13.5px; color:var(--text-secondary); max-width:420px; margin:0 auto 16px">Connect your first AWS, Azure, GCP, Alibaba, or Huawei account to start seeing unified cost data.</p>
        <button class="btn btn-primary role-write" data-open-add-account>+ Add cloud account</button>
      </section>`;
    document.querySelectorAll('[data-open-add-account]').forEach(btn => {
      btn.addEventListener('click', () => window.CM_openAddAccount(null));
    });
    // Straight to the Adhoc Spend step: the provider grid behind it offers
    // five clouds a Member may not connect.
    document.querySelectorAll('[data-open-adhoc]').forEach(btn => {
      btn.addEventListener('click', () => window.CM_openAddAccount('adhoc'));
    });
    return;
  }

  // Providers are ordered by what they cost too, so the whole page reads
  // highest-spend-first rather than mixing a fixed order with sorted rows.
  const providers = PROVIDER_ORDER.filter(key => ACCOUNTS.some(a => a.provider === key))
    .sort((x, y) => providerTotal(y) - providerTotal(x));

  // Scoped to one provider when the URL asks for it — the dashboard's provider
  // rows link here expecting exactly that.
  const only = providerFilter();
  const shown = only ? [only] : providers;
  container.innerHTML = (only ? backToAllHtml() : '')
    + shown.map(key => renderGroup(key, shown.length)).join('');

  const clearBtn = document.getElementById('clear-provider-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      // Replace rather than push: the filtered view and the full list are the
      // same page, and Back should leave Accounts rather than toggle a filter.
      history.replaceState(null, '', window.location.pathname + window.location.search);
      renderAccounts();
    });
  }

  container.querySelectorAll('[data-add-provider]').forEach(btn => {
    // Inside a <summary>-headed <details>, so stop the click from also toggling
    // the section shut behind the modal.
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.CM_openAddAccount(btn.dataset.addProvider);
    });
  });

  container.querySelectorAll('details[data-group]').forEach(el => {
    el.addEventListener('toggle', () => {
      sessionStorage.setItem(`cm_group_open_${el.dataset.group}`, el.open ? '1' : '0');
    });
  });

  container.querySelectorAll('[data-show-more]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rest = container.querySelector(`[data-hidden-rows="${btn.dataset.showMore}"]`);
      if (!rest) return;
      rest.hidden = false;
      btn.closest('.show-more-row')?.remove();
    });
  });

  container.querySelectorAll('[data-delete-account]').forEach(btn => {
    btn.addEventListener('click', () => removeAccount(btn));
  });

  container.querySelectorAll('[data-rename-account]').forEach(btn => {
    btn.addEventListener('click', () => {
      const account = ACCOUNTS.find(a => a.id === btn.dataset.renameAccount);
      // Re-renders rather than patching the one label in place: the account's
      // name also drives the group ordering and the aria-labels on both of
      // these buttons.
      if (account) CM_openRenameAccount(account, renderAccounts);
    });
  });
}

async function removeAccount(btn) {
  const id = btn.dataset.deleteAccount;
  const account = ACCOUNTS.find(a => a.id === id);
  if (!account) return;

  const extra = account.dataSource === 'live'
    ? '\n\nStored credentials for this account will be deleted too. Reconnecting later means setting up access again.'
    : '';
  if (!window.confirm(`Remove "${account.name}" and its stored cost history?${extra}`)) return;

  btn.disabled = true;
  btn.textContent = 'Removing…';
  try {
    await deleteAccount(id);
    ACCOUNTS = ACCOUNTS.filter(a => a.id !== id);
    renderAccounts();
  } catch (err) {
    window.alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Remove';
  }
}

// Combined MTD spend for one provider — the same figure shown in its header.
function providerTotal(key) {
  return ACCOUNTS
    .filter(a => a.provider === key && a.status === 'connected')
    .reduce((sum, a) => sum + (a.spend ?? 0), 0);
}

// Biggest spender first — that's the account worth looking at. Accounts still
// backfilling have no spend figure yet rather than a spend of zero, so they
// sort to the bottom instead of being ranked against real numbers.
function bySpendDescending(a, b) {
  const pending = x => x.status === 'syncing';
  if (pending(a) !== pending(b)) return pending(a) ? 1 : -1;
  if (pending(a)) return a.name.localeCompare(b.name);
  return (b.spend ?? 0) - (a.spend ?? 0);
}

// Rows shown before the list is truncated behind a "show all". Enough to see
// the accounts that actually cost something (they're sorted by spend) without
// turning the page into a scroll.
const ROWS_BEFORE_TRUNCATE = 6;

// With one provider the group is the whole page, so collapsing it would leave
// the user staring at a single header. With several, collapsed-by-default is
// the point — an overview you expand into.
function groupStartsOpen(providerCount) {
  return providerCount === 1;
}

// Adhoc accounts are tools, not bills. Most carry no spend in any given month,
// so ranking them by it produced a tie broken by whichever was created first —
// an order nobody chose and nobody can predict. A name is the one thing every
// tool has, and the one thing someone scanning for "Perplexity" is looking for.
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function renderGroup(key, providerCount) {
  const meta = PROVIDER_META[key];
  const accounts = ACCOUNTS.filter(a => a.provider === key)
    .sort(key === 'adhoc' ? byName : bySpendDescending);
  const total = accounts.reduce((s, a) => s + (a.status === 'connected' ? a.spend : 0), 0);
  const noun = accounts.length === 1 ? meta.nounSingular : meta.nounPlural;

  // A choice the user made this session outranks the default either way.
  const remembered = sessionStorage.getItem(`cm_group_open_${key}`);
  const open = remembered === null ? groupStartsOpen(providerCount) : remembered === '1';

  const truncated = accounts.length > ROWS_BEFORE_TRUNCATE;
  const visible = truncated ? accounts.slice(0, ROWS_BEFORE_TRUNCATE) : accounts;
  const hidden = truncated ? accounts.slice(ROWS_BEFORE_TRUNCATE) : [];

  return `
  <details class="card accounts-group collapse" id="${key}" data-group="${key}"${open ? ' open' : ''}>
    <summary class="accounts-group-head">
      <span class="provider-badge-lg" style="background:${meta.color}">${meta.badge}</span>
      <div>
        <div class="g-name">${meta.fullName}</div>
        <!-- Manual-entry providers have no credential to name, and saying
             "connected via undefined" is what happens when that is forgotten. -->
        <div class="g-meta">${accounts.length} ${noun} connected${meta.manualEntry ? '' : ` via ${meta.roleLabel}`}</div>
      </div>
      <div class="g-total"><div class="v">${fmt(total)}</div><div class="l">combined MTD spend</div></div>
      <svg class="collapse-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </summary>
    ${visible.map(renderRow).join('')}
    <div data-hidden-rows="${key}" hidden>${hidden.map(renderRow).join('')}</div>
    ${truncated ? `
    <div class="show-more-row">
      <button class="show-more-btn" data-show-more="${key}"
              aria-expanded="false">Show all ${accounts.length} ${meta.nounPlural} ↓</button>
    </div>` : ''}
    <div class="add-account-row">
      <!-- Everyone may add a tool to Adhoc Spend, including Members: an adhoc
           account *is* one tool, so "add another" means Cursor or Midjourney,
           not a second copy of an existing ledger. Connecting a real cloud
           bill stays role-write — it hands over credentials. -->
      <button class="btn btn-sm${key === 'adhoc' ? '' : ' role-write'}" data-add-provider="${key}">+ Add another ${meta.name} ${meta.nounSingular}</button>
    </div>
  </details>`;
}

function renderRow(a) {
  const isPending = a.status === 'syncing';
  const href = `account-detail.html?id=${encodeURIComponent(a.id)}`;

  // The name doubles as the rename control, matching how a teammate is
  // renamed on the Team page: a pencil that only appears on hover, rather
  // than a labelled button repeated down every row.
  //
  // Opening the account is still a click anywhere on the row — the link below
  // is stretched over the whole of it in CSS — so the name giving up its role
  // as a link costs nothing.
  const nameCell = canRemove(a)
    ? `<button class="acc-name acc-name-btn" data-rename-account="${a.id}" title="Rename ${esc(a.name)}">
         ${esc(a.name)}
         <svg class="ic-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
         ><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
       </button>`
    : `<div class="acc-name">${esc(a.name)}</div>`;

  return `
    <div class="account-row-outer">
      <div class="account-row ${isPending ? 'is-pending' : ''}">
        <a class="acc-row-link" href="${href}" aria-label="Open ${esc(a.name)}"></a>
        <div>
          ${nameCell}
          <!-- An adhoc account is a tool, not something one person owns: the
               plans inside it can each be for a different subscriber, so there
               is no single name that would be true here. Neither the owner nor
               the reassignment prompt applies. -->
          <div class="acc-id">${a.dataSource === 'adhoc' ? esc(adhocUsers(a)) : esc(a.externalId)}${a.owner && a.dataSource !== 'adhoc' ? ` <span class="acc-owner-sep">·</span> <span class="acc-owner">${esc(a.owner)}</span>` : ''}${a.managerActive === false && a.dataSource !== 'adhoc' ? ` <span class="acc-owner-sep">·</span> <span class="acc-stale-manager" title="${esc(a.createdByEmail || 'The assigned manager')} has left — reassign this account">needs reassigning</span>` : ''}</div>
        </div>
        <div class="acc-spend">${isPending ? '—' : fmt(a.spend)}</div>
        <!-- Nothing syncs an adhoc account — its figures change when someone
             edits them — so a "synced 4 min ago" reads as a fetch that never
             happened, timed from whenever the last edit was saved. -->
        <div class="acc-sync">${a.dataSource === 'adhoc' ? '' : formatSync(a.sync)}</div>
        ${isPending
          ? `<span class="status-pill pending"><span class="dot"></span> Backfilling data…</span>`
          : a.status === 'error'
            ? `<span class="status-pill pending"><span class="dot"></span> Sync failed</span>`
            // "Sample data" means a seeded demo account. Adhoc figures are real
            // money someone typed in, so it gets the same clean row a healthy
            // live account gets.
            : a.dataSource === 'live' || a.dataSource === 'adhoc'
              // A healthy live account is the norm — a badge saying so on every
              // row is noise that makes the rows worth noticing harder to spot.
              ? `<span class="status-pill-empty"></span>`
              : `<span class="status-pill"><span class="dot"></span> Sample data</span>`}
        <span class="acc-chevron">›</span>
      </div>
      ${canRemove(a) ? `
      <button class="acc-delete role-write" data-delete-account="${a.id}"
              aria-label="Remove ${esc(a.name)}">Remove</button>` : ''}
    </div>`;
}

function formatSync(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'synced just now';
  if (mins < 60) return `synced ${mins} min ago`;
  const hours = Math.round(mins / 60);
  return `synced ${hours} hr ago`;
}

function renderStats() {
  const total = ACCOUNTS.length;
  const providersInUse = PROVIDER_ORDER.filter(key => ACCOUNTS.some(a => a.provider === key));
  const counts = {};
  ACCOUNTS.forEach(a => { counts[a.provider] = (counts[a.provider] || 0) + 1; });
  const topProviderEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  document.getElementById('stat-total-accounts').textContent = total;
  document.getElementById('stat-total-accounts-sub').textContent = `across ${providersInUse.length} provider${providersInUse.length === 1 ? '' : 's'}`;
  document.getElementById('stat-providers-count').textContent = providersInUse.length;
  document.getElementById('stat-providers-list').textContent = providersInUse.length
    ? providersInUse.map(k => PROVIDER_META[k].name).join(' · ')
    : 'None yet';

  if (topProviderEntry) {
    // Whole names: splitting on "-" turned real account names into fragments
    // ("AI-Lab" showed as "AI").
    const topNames = ACCOUNTS.filter(a => a.provider === topProviderEntry[0]).map(a => a.name).slice(0, 3).join(', ');
    document.getElementById('stat-top-provider').textContent = topProviderEntry[1];
    document.getElementById('stat-top-provider-sub').textContent = `${PROVIDER_META[topProviderEntry[0]].name} — ${topNames}`;
  } else {
    document.getElementById('stat-top-provider').textContent = '—';
    document.getElementById('stat-top-provider-sub').textContent = 'No accounts yet';
  }
  document.getElementById('stat-readonly').textContent = `${total} / ${total}`;
}

window.CM_addAccount = async function (providerKey, accountData) {
  const created = await createAccount(providerKey, accountData);
  ACCOUNTS.push(created);
  renderAccounts();
  const el = document.getElementById(providerKey);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return created;
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Spend on every row is formatted through CM_money, which needs the
    // display currency that rides on /me.
    const [accounts] = await Promise.all([loadAllAccounts(), window.CM_MeReady]);
    ACCOUNTS = accounts;
    renderAccounts();

    // Arriving from one provider row on the dashboard and then another — or
    // using Back — changes only the hash, which fires no reload. Without this
    // the second click would leave the first provider's filter on screen.
    window.addEventListener('hashchange', renderAccounts);
  } catch (err) {
    window.CM_renderLoadError(err, 'accounts-container');
  }
});
