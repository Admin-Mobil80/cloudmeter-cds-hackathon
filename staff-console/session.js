// CloudMeter — real Cognito session storage (JWTs in localStorage, so a
// login persists across tabs and survives a tab close, unlike sessionStorage).
(function () {
  // Renew this far ahead of expiry, so a request that starts just under the
  // wire doesn't arrive at the API just over it.
  const RENEW_BEFORE_MS = 5 * 60 * 1000;

  // Shared so parallel callers await one exchange rather than racing.
  let refreshInFlight = null;

  function decodeJwt(token) {
    try {
      const payload = token.split('.')[1];
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (e) {
      return null;
    }
  }

  window.CM_Session = {
    save({ idToken, accessToken, refreshToken, email }) {
      localStorage.setItem('cm_id_token', idToken);
      localStorage.setItem('cm_access_token', accessToken);
      if (refreshToken) localStorage.setItem('cm_refresh_token', refreshToken);
      localStorage.setItem('cm_email', email);
    },

    getIdToken() {
      return localStorage.getItem('cm_id_token');
    },

    getEmail() {
      return localStorage.getItem('cm_email');
    },

    getRefreshToken() {
      return localStorage.getItem('cm_refresh_token');
    },

    /** Milliseconds until the ID token expires; negative once it has. */
    msUntilExpiry() {
      const claims = decodeJwt(this.getIdToken() || '');
      return claims?.exp ? claims.exp * 1000 - Date.now() : -1;
    },

    decodeJwt,

    // Client-side expiry check only, for a fast synchronous pre-paint guard —
    // the API independently verifies the token's signature server-side on
    // every request, so this is a UX check, not a security boundary.
    isValid() {
      const token = this.getIdToken();
      if (!token) return false;
      const claims = decodeJwt(token);
      if (!claims || !claims.exp) return false;
      return claims.exp * 1000 > Date.now();
    },

    /**
     * Guarantees a usable ID token, renewing it if it is expired or close to
     * it.
     *
     * ID tokens last an hour; the refresh token lasts thirty days. Without
     * this, a session that was perfectly valid simply stopped at the hour mark
     * and dumped the user back at the login screen — with the means to renew it
     * sitting unused in localStorage the whole time.
     *
     * Concurrent callers share one in-flight refresh: a page that fires five
     * API calls at once must not attempt five simultaneous token exchanges.
     */
    async ensureFresh() {
      if (this.msUntilExpiry() > RENEW_BEFORE_MS) return true;

      const refreshToken = this.getRefreshToken();
      if (!refreshToken) return false;

      // Loaded by every authenticated page. If it is ever missing, the session
      // silently dies at the one-hour mark with a usable refresh token sitting
      // unused — so say so loudly rather than looking like an expiry.
      if (!window.CM_Cognito) {
        console.error('CM_Cognito is not loaded — cognito-client.js must be included before api-client.js');
        return false;
      }

      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          try {
            const res = await window.CM_Cognito.refreshSession(refreshToken);
            const auth = res?.AuthenticationResult;
            if (!auth?.IdToken) return false;
            localStorage.setItem('cm_id_token', auth.IdToken);
            if (auth.AccessToken) localStorage.setItem('cm_access_token', auth.AccessToken);
            return true;
          } catch (err) {
            // A revoked or expired refresh token is the end of the session —
            // there is nothing left to renew with.
            console.warn('Session refresh failed', err);
            return false;
          } finally {
            refreshInFlight = null;
          }
        })();
      }
      return refreshInFlight;
    },

    /** Renews regardless of how much life the current token appears to have. */
    async forceRefresh() {
      localStorage.setItem('cm_id_token', '');
      return this.ensureFresh();
    },

    clear() {
      localStorage.removeItem('cm_id_token');
      localStorage.removeItem('cm_access_token');
      localStorage.removeItem('cm_refresh_token');
      localStorage.removeItem('cm_email');
    },
  };
})();
