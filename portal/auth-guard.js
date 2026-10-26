// CloudMeter — real auth guard. Runs synchronously before paint (a decoded
// JWT expiry check, no network call) to avoid a flash of protected content,
// then asynchronously resolves the caller's real tenant + role from the API.
(function () {
  // An expired ID token is not the end of a session — the refresh token
  // outlives it by weeks. Only bounce to login when there's nothing left to
  // renew with; otherwise let cmLoadMe() below do the renewal.
  if (!window.CM_Session.isValid() && !window.CM_Session.getRefreshToken()) {
    window.location.replace('login.html?mode=signin');
    return;
  }

  // What the nav should look like, applied before the first paint.
  //
  // /me is the authority, but it is a round trip, and the nav cannot wait for
  // it without either flashing links a Member may not use or flickering an
  // Owner's links in on every single navigation. So the last answer /me gave
  // *in this tab* is replayed, and corrected a moment later if it was wrong.
  //
  // With no answer yet — a first page load, or a new tab — it falls back to the
  // narrowest access there is. Showing someone a door they cannot open is the
  // worse failure of the two, so that is the one this errs away from.
  let hint = null;
  try { hint = JSON.parse(sessionStorage.getItem('cm_nav_hint') || 'null'); } catch (e) { hint = null; }
  document.documentElement.setAttribute('data-role', (hint && hint.role) || 'member');
  document.documentElement.setAttribute('data-scope', (hint && hint.scope) || 'account');
  if (hint && hint.syncStatus) document.documentElement.setAttribute('data-sync-status', hint.syncStatus);
})();

window.CM_ME = null;

/**
 * Drops the cached nav shape.
 *
 * Called wherever who-you-are can change — signing out, switching CloudMeter
 * account, creating a new one. Without this the next page would paint the
 * previous identity's nav for one frame, which is the exact leak the cache
 * exists to avoid everywhere else.
 */
function cmForgetNavHint() {
  try { sessionStorage.removeItem('cm_nav_hint'); } catch (e) { /* nothing to do */ }
}

async function cmLoadMe() {
  if (!(await window.CM_Session.ensureFresh())) {
    cmForgetNavHint();
      window.CM_Session.clear();
    window.location.replace('login.html?mode=signin');
    return;
  }

  try {
    const res = await fetch(`${window.CM_CONFIG.apiUrl}/me`, {
      headers: { Authorization: `Bearer ${window.CM_Session.getIdToken()}` },
    });
    if (res.status === 401 || res.status === 403) {
      cmForgetNavHint();
      window.CM_Session.clear();
      window.location.replace('login.html?mode=signin');
      return;
    }
    // Authenticated, but this login isn't attached to any CloudMeter account.
    // Every other page call will fail the same way, so say so plainly instead
    // of leaving the panels spinning on "Loading…" forever.
    if (res.status === 404) {
      showNoAccount();
      return;
    }
    if (!res.ok) throw new Error(`GET /me failed: ${res.status}`);

    const me = await res.json();
    window.CM_ME = me;
    document.documentElement.setAttribute('data-role', me.role);
    // Read-only while the subscription is lapsed or a payment has failed.
    // Set on the same element as data-role and consumed the same way — by CSS
    // alone — so no render function has to know about billing state. The
    // server refuses these writes regardless; this only stops someone filling
    // in a form before being told no.
    document.documentElement.setAttribute('data-sync-status', me.syncStatus || 'active');

    // Kept for the next page in this tab only — sessionStorage, so a new tab
    // and a fresh sign-in both start from the narrow default rather than
    // inheriting somebody else's.
    try {
      sessionStorage.setItem('cm_nav_hint', JSON.stringify({
        role: me.role,
        scope: me.canSeeOrgRollup === false ? 'account' : 'org',
        syncStatus: me.syncStatus || 'active',
      }));
    } catch (e) { /* private mode, or storage full — the default still holds */ }

    const path = window.location.pathname;
    // Nothing is Owner-only at page level any more. Settings is operational —
    // an Admin needs the business name, timezone and digest hour — and Billing
    // shows an Admin what the organisation is on. The Owner-only actions inside
    // them (closing the CloudMeter account) stay hidden by .role-owner-only and
    // refused by their own routes.

    // A Member is scoped to individual cloud accounts, so the org-wide roll-up
    // and the team list aren't theirs to see. The API refuses both regardless;
    // this stops the page painting skeletons that can only resolve to a 403.
    // Notifications is not here: the page shows a Member their own channels and
    // a row per cloud account, and shows Owners and Admins the organisation-wide
    // rules. Same page, different content, so nobody is turned away from it.
    // Billing joins these: it reports organisation-wide spend against the plan,
    // which a Member is scoped out of by design.
    const orgOnlyPage = path.endsWith('dashboard.html') || path.endsWith('team.html')
      || path.endsWith('settings.html') || path.endsWith('billing.html');
    if (orgOnlyPage && !me.canSeeOrgRollup) {
      window.location.replace('accounts.html');
      return;
    }
    applyScopeToNav(me);

    document.dispatchEvent(new CustomEvent('cm-me-loaded', { detail: me }));
    applyIdentityToUI(me);
  } catch (err) {
    console.error('Failed to load /me', err);
  }
}

// Replaces the page body with a plain explanation. Used when the session is
// valid but there's no CloudMeter account behind it — the panels can never
// load, and silence looks like a hang.
function showNoAccount() {
  const render = () => {
    const main = document.querySelector('.main') || document.body;
    main.innerHTML = `
      <div style="max-width:520px;margin:80px auto;text-align:center">
        <h2 style="margin:0 0 10px">This sign-in isn't linked to a CloudMeter account</h2>
        <p class="muted" style="margin:0 0 20px">
          You're signed in, but you aren't a member of any CloudMeter account —
          so there's no data to show. If you were invited, open the invite link again,
          or ask the CloudMeter account owner to re-send it.
        </p>
        <button class="btn-primary" id="no-account-signout">Sign out</button>
      </div>`;
    document.getElementById('no-account-signout')?.addEventListener('click', () => {
      cmForgetNavHint();
      window.CM_Session.clear();
      window.location.href = 'login.html?mode=signin';
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
}

function applyIdentityToUI(me) {
  const emailLocalPart = (me.email || '').split('@')[0];
  // The stored member name is the real one; the email local-part is only a
  // fallback for members created before names were captured.
  const displayName = me.name
    || emailLocalPart.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  document.querySelectorAll('.sidebar-footer .who .n').forEach(el => { el.textContent = displayName || me.email; });
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'U';
  document.querySelectorAll('.sidebar-footer .avatar').forEach(el => { el.textContent = initials; });

  const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };
  document.querySelectorAll('.sidebar-footer .who .r').forEach(el => {
    el.textContent = ROLE_LABEL[me.role] || 'Member';
  });

  // The organization name replaces the decorative tagline in the sidebar brand,
  // so every page makes it obvious which account is being viewed.
  const brandTag = me.tenantName || 'cloud cost ledger';
  document.querySelectorAll('.sidebar-brand .tag').forEach(el => {
    el.textContent = brandTag;
    el.title = brandTag;
  });
  if (me.tenantName) document.title = `${document.title} · ${me.tenantName}`;
  applyPageOrgName(me.tenantName);
  renderAccountSwitcher(me);

  // Hidden at zero rather than showing "0": an empty badge reads as a count of
  // nothing, which is the same information without the visual noise.
  const count = me.activeAlerts ?? 0;
  document.querySelectorAll('[data-alert-count]').forEach(el => {
    el.textContent = count;
    el.hidden = count === 0;
  });

  const orgEmailEl = document.getElementById('org-email');
  if (orgEmailEl) orgEmailEl.value = me.email;
}

// Exposed as a promise, not just an event, because the event only helps code
// that was listening before it fired. A page whose own fetch resolves first
// has already missed it — which is how the dashboard came to render every
// figure in USD: CM_money falls back to USD while CM_ME is still null, and
// nothing re-drew it once the real currency arrived. Awaiting this makes the
// order deterministic instead of a race between two fetches.
window.CM_MeReady = cmLoadMe();

// A dashboard left open all afternoon should still work when someone comes
// back to it. Checking every five minutes keeps the token ahead of its own
// expiry without a burst of renewals.
setInterval(() => { window.CM_Session.ensureFresh(); }, 5 * 60 * 1000);

document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      cmForgetNavHint();
      window.CM_Session.clear();
      window.location.href = 'login.html?mode=signin';
    });
  }

  const trialBanner = document.getElementById('trial-banner');
  const trialClose = document.getElementById('trial-close');
  if (trialBanner) {
    if (sessionStorage.getItem('cm_trial_banner_dismissed') === '1') {
      trialBanner.style.display = 'none';
    }
    trialClose?.addEventListener('click', () => {
      trialBanner.style.display = 'none';
      sessionStorage.setItem('cm_trial_banner_dismissed', '1');
    });
  }
});

/**
 * Where someone lands when they're bounced off a page they can't see.
 *
 * A Member has no dashboard to fall back to, so sending them there would just
 * bounce again — cloud accounts is the first page they can actually use.
 */
function landingPageFor(me) {
  return me && me.canSeeOrgRollup === false ? 'accounts.html' : 'dashboard.html';
}
window.CM_landingPage = landingPageFor;

/**
 * Hides navigation a scoped Member can't use. This is presentation only —
 * every endpoint behind these links re-derives the same decision server-side,
 * so hiding a link never stands in for enforcing it.
 */
function applyScopeToNav(me) {
  const scoped = me.canSeeOrgRollup === false;
  // Relaxes, or confirms, the restrictive default set before paint. The links
  // themselves are hidden by CSS on this attribute, not here: hiding them in
  // JS is what left them on screen until /me resolved.
  document.documentElement.setAttribute('data-scope', scoped ? 'account' : 'org');
  if (!scoped) return;

  // A group heading with nothing under it is just a stray word. Billing and
  // Settings are hidden by role CSS rather than the hidden attribute, so this
  // asks for the computed result instead of trusting either mechanism.
  document.querySelectorAll('.nav-group .nav-label').forEach((label) => {
    let next = label.nextElementSibling;
    let visible = 0;
    while (next && !next.classList.contains('nav-label')) {
      if (getComputedStyle(next).display !== 'none') visible += 1;
      next = next.nextElementSibling;
    }
    if (visible === 0) label.hidden = true;
  });
}

/**
 * Lets someone move between the CloudMeter accounts they belong to.
 *
 * A person can be in several — their own, plus any they've been invited into —
 * and without this the only visible one is whichever the server picked, which
 * looks exactly like an invitation having silently failed.
 *
 * Only rendered when there is more than one; a single account needs no chooser.
 */
/**
 * Starts a second CloudMeter account for someone who already has one.
 *
 * Its own account, not a view of an existing one: separate cloud accounts,
 * separate team, separate billing. Said plainly here because "new account"
 * could just as easily be read as "new cloud account", which is a different
 * thing entirely and one click away on the same screen.
 */
function openCreateAccountDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal scope-modal';
  dlg.innerHTML = `
    <h2>Create a new CloudMeter account</h2>
    <p class="modal-sub">
      A separate CloudMeter account with its own cloud accounts, team and billing —
      not another cloud account inside this one. You'll be its owner, and it starts
      on a 7-day trial. You can switch between your accounts from this menu.
    </p>
    <label class="field-label" for="new-account-name" style="margin-top:16px">Business / organization name</label>
    <input class="field-input" id="new-account-name" maxlength="80" autocomplete="off" placeholder="Acme Inc.">
    <p class="field-error" id="new-account-error"></p>
    <div class="modal-actions">
      <button class="btn" data-create-cancel>Cancel</button>
      <button class="btn btn-primary" data-create-save>Create account</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const input = dlg.querySelector('#new-account-name');
  const save = dlg.querySelector('[data-create-save]');
  const err = dlg.querySelector('#new-account-error');
  input.focus();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-create-cancel]').addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });

  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      err.textContent = 'Give the new CloudMeter account a name.';
      err.classList.add('show');
      input.focus();
      return;
    }
    save.disabled = true;
    save.textContent = 'Creating…';
    try {
      await window.CM_Api.post('/tenants', { name });
      // A different tenant, and Owner of it — the cached nav belongs to the
      // account being left behind.
      cmForgetNavHint();
      // The server already made it the active account, so a clean load lands
      // in the new one rather than patching this page into a different tenant.
      window.location.replace('dashboard.html');
    } catch (e) {
      save.disabled = false;
      save.textContent = 'Create account';
      err.textContent = e.message || 'Could not create that account.';
      err.classList.add('show');
    }
  });
}

/**
 * Puts the organization name beside the page title — "Cloud Accounts (Mobil80)".
 *
 * Done here rather than in each page's markup because auth-guard already runs
 * everywhere and is the only place that knows the tenant. One implementation,
 * and a page added later gets it for free.
 *
 * The account drill-down is deliberately skipped: its <h1> is the cloud
 * account's own name, so this would read "Mobil80 OpenAI (Mobil80)". That page
 * already names the organization in its sub-line.
 *
 * Idempotent — an existing suffix is replaced rather than appended to, so a
 * tenant switch cannot leave two names stacked up.
 */
function applyPageOrgName(tenantName) {
  const name = (tenantName || '').trim();
  document.querySelectorAll('.topbar h1').forEach((h1) => {
    if (h1.id === 'acc-name') return;

    const existing = h1.querySelector('.page-org');
    if (existing) existing.remove();
    if (!name) return;

    const tag = document.createElement('span');
    tag.className = 'page-org';
    tag.textContent = `(${name})`;
    // Spacing comes from CSS, not a text node. Appending a separator here left
    // one behind on every re-run — removing the span did not remove the space,
    // so a tenant switch slowly pushed the name rightwards.
    h1.appendChild(tag);
  });
}

function renderAccountSwitcher(me) {
  const list = Array.isArray(me.memberships) ? me.memberships : [];
  // Rendered even for one account: it is also where an additional account is
  // created, and hiding it below two made that unreachable for exactly the
  // people who needed it.
  if (list.length === 0) return;

  const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };
  document.querySelectorAll('.sidebar-brand').forEach((brand) => {
    if (brand.querySelector('.account-switcher')) return;
    brand.classList.add('has-switcher');

    const wrap = document.createElement('div');
    wrap.className = 'account-switcher';
    wrap.innerHTML = `
      <button type="button" class="account-switcher-btn" aria-haspopup="true" aria-expanded="false"
              title="Switch CloudMeter account">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="account-switcher-menu" hidden>
        <div class="account-switcher-head">Your CloudMeter accounts</div>
        ${list.map((m) => `
          <button type="button" class="account-switcher-item${m.tenantId === me.tenantId ? ' is-current' : ''}"
                  data-tenant-id="${escapeAttr(m.tenantId)}" ${m.tenantId === me.tenantId ? 'disabled' : ''}>
            <span class="n">${escapeAttr(m.tenantName || 'Unnamed account')}</span>
            <span class="r">${ROLE_LABEL[m.role] || 'Member'}</span>
          </button>`).join('')}
        ${list.some((m) => m.role === 'owner') ? `
        <div class="account-switcher-note">
          One email can own one CloudMeter account. You can be added to others
          as an Admin or Member by their owner.
        </div>` : `
        <button type="button" class="account-switcher-new" data-create-account>
          + Create a new CloudMeter account
        </button>`}
      </div>`;
    brand.appendChild(wrap);

    const btn = wrap.querySelector('.account-switcher-btn');
    const menu = wrap.querySelector('.account-switcher-menu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    wrap.querySelector('[data-create-account]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      openCreateAccountDialog();
    });

    wrap.querySelectorAll('[data-tenant-id]').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        item.disabled = true;
        try {
          await window.CM_Api.put('/me/active-account', { tenantId: item.dataset.tenantId });
          // The role differs between accounts, so the cached nav is wrong the
          // moment this succeeds.
          cmForgetNavHint();
          // Every page is scoped to one account, and the nav a role can reach
          // differs between them — so start clean rather than patching in place.
          window.location.replace('dashboard.html');
        } catch (err) {
          item.disabled = false;
          console.error('Could not switch account', err);
          window.alert(err.message || 'Could not switch account.');
        }
      });
    });
  });
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
