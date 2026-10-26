// CloudMeter BMS — session guard and identity for the staff console.
//
// Two gates, not one: a valid token from the BMS pool, and an active BMS user
// record behind it. The second is checked on every page load so revoking
// someone takes effect immediately rather than whenever their token expires.
(function () {
  if (!window.CM_Session.isValid() && !window.CM_Session.getRefreshToken()) {
    window.location.replace('index.html');
  }
})();

window.BMS_ME = null;

async function bmsLoadMe() {
  if (!(await window.CM_Session.ensureFresh())) {
    window.CM_Session.clear();
    window.location.replace('index.html');
    return;
  }

  try {
    const me = await window.CM_Api.get('/bms/me');
    window.BMS_ME = me;
    document.documentElement.setAttribute('data-bms-role', me.role);

    const name = me.name || me.email;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('bms-name', name);
    set('bms-role', me.role === 'root' ? 'Solution owner' : 'Staff');
    set('bms-initials', name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('') || 'U');

    document.dispatchEvent(new CustomEvent('bms-me-loaded', { detail: me }));
  } catch (err) {
    // A signed-in address with no access record is a real state, not a glitch:
    // say so instead of leaving every panel spinning.
    if (err.status === 403) {
      document.body.innerHTML = `
        <div class="auth-shell"><div class="auth-card">
          <h1>No BMS access</h1>
          <p class="sub">This sign-in isn't authorised for the Business Management System.
            Ask the solution owner to add ${(window.CM_Session.getEmail() || 'your address')}.</p>
          <button class="btn btn-primary btn-block" onclick="window.CM_Session.clear();location.href='index.html'">Sign out</button>
        </div></div>`;
      return;
    }
    console.error('Failed to load BMS identity', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bmsLoadMe();
  const out = document.getElementById('logout-btn');
  if (out) out.addEventListener('click', () => {
    window.CM_Session.clear();
    window.location.replace('index.html');
  });
});
