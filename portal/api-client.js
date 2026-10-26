// CloudMeter — thin authenticated fetch() wrapper for the real backend API.
(function () {
  window.CM_Api = {
    async request(path, options = {}, isRetry = false) {
      // Renews the token if it's close to expiring, so a long-lived page keeps
      // working instead of failing the first call made after the hour mark.
      await window.CM_Session.ensureFresh();

      const res = await fetch(`${window.CM_CONFIG.apiUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${window.CM_Session.getIdToken()}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });

      if (res.status === 401) {
        // The clock check said the token was fine but the API disagreed —
        // clock skew, or a token revoked server-side. Try one forced renewal
        // before giving up, since dropping someone to the login screen while
        // they hold a valid refresh token is the bug this whole path exists to
        // prevent.
        if (!isRetry && await window.CM_Session.forceRefresh()) {
          return this.request(path, options, true);
        }
        window.CM_Session.clear();
        window.location.replace('login.html?mode=signin');
        throw new Error('Session expired');
      }

      if (res.status === 204) return null;

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Carry the status and body along: some callers need what the server
        // said, not just that it said no — a 409 can name what's blocking.
        const err = new Error(data?.message || `Request failed: ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },

    get(path) {
      return this.request(path, { method: 'GET' });
    },
    post(path, body) {
      return this.request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    },
    patch(path, body) {
      return this.request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
    },
    put(path, body) {
      return this.request(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
    },
    delete(path) {
      return this.request(path, { method: 'DELETE' });
    },
  };
})();

// Every page paints skeleton placeholders before its data arrives. If that
// fetch fails there's nothing to replace them with, and an endlessly
// shimmering page is a worse lie than an empty one — so say what happened.
window.CM_renderLoadError = function (err, ...containerIds) {
  console.error('Page data failed to load', err);
  const message = (err && err.message) || 'Something went wrong.';
  containerIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.removeAttribute('aria-busy');
    el.innerHTML = `<div class="muted" style="padding:24px;text-align:center">
        Couldn't load this data — ${message}
        <div style="margin-top:10px"><button class="btn btn-sm" onclick="window.location.reload()">Retry</button></div>
      </div>`;
  });
  // Stat tiles are outside those containers and would otherwise shimmer on.
  document.querySelectorAll('.stat-tile .sk').forEach(sk => {
    sk.classList.remove('sk');
    sk.textContent = '—';
  });
};
