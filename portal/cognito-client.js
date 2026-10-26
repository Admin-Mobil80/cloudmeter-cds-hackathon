// CloudMeter — thin fetch()-based client for Cognito's public unauthenticated
// JSON API (SignUp / InitiateAuth / RespondToAuthChallenge). No AWS SDK/CDN
// dependency, matching the rest of this app's no-build-step approach.
(function () {
  const ENDPOINT = `https://cognito-idp.${window.CM_CONFIG.region}.amazonaws.com/`;

  async function request(target, body) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.message || data.__type || 'Request failed');
      err.code = (data.__type || '').split('#').pop();
      throw err;
    }
    return data;
  }

  // Cognito's SignUp API requires *a* password meeting the pool's policy,
  // even though this app only ever authenticates via CUSTOM_AUTH (OTP) —
  // this value is generated and immediately discarded, never stored or reused.
  function throwawayPassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return 'Aa1!' + Array.from(bytes, (b) => b.toString(36)).join('').slice(0, 20);
  }

  window.CM_Cognito = {
    async signUp(email, name) {
      return request('SignUp', {
        ClientId: window.CM_CONFIG.clientId,
        Username: email,
        Password: throwawayPassword(),
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
      });
    },

    async initiateAuth(email) {
      return request('InitiateAuth', {
        AuthFlow: 'CUSTOM_AUTH',
        ClientId: window.CM_CONFIG.clientId,
        AuthParameters: { USERNAME: email },
      });
    },

    // Exchanges the long-lived refresh token for fresh ID and access tokens.
    // Cognito does not return a new refresh token here (rotation is off), so
    // the stored one keeps working until it reaches its own 30-day expiry.
    async refreshSession(refreshToken) {
      return request('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: window.CM_CONFIG.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
    },

    async respondToChallenge(email, session, code) {
      return request('RespondToAuthChallenge', {
        ClientId: window.CM_CONFIG.clientId,
        ChallengeName: 'CUSTOM_CHALLENGE',
        Session: session,
        ChallengeResponses: { USERNAME: email, ANSWER: code },
      });
    },
  };
})();
