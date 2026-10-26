// CloudMeter marketing site — per-environment config.
//
// This site only ever reads the public plan catalogue (GET /plans, no auth)
// and links out to the portal for sign-in/sign-up — it holds no credentials
// and calls no authenticated route, unlike web/config.js and bms/config.js.

/*
 * The dev, UAT and prod copies in the second AWS account.
 *
 * Matched on exact CloudFront hostnames rather than a prefix: that account
 * does not own cloudmeter.io, so these sites answer on the names CloudFront
 * assigns and there is no `dev.` to look for. Listing them also means a host
 * nobody recognises falls through to prod rather than silently pointing a
 * stray page at the wrong backend.
 *
 * Replace these when the copy moves to real hostnames.
 */
const CM_ACCOUNT_B = {
  'dudojxk6tcmaz.cloudfront.net': {
    env: 'dev',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://dev.portal.cloudmeter.io',
  },
  // Dev's real domain, served from the second account since 2026-10-20.
  // Listed explicitly: the `dev.` check below still points at the first.
  'dev.www.cloudmeter.io': {
    env: 'dev',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://dev.portal.cloudmeter.io',
  },
  'd3l65cs7iejrr9.cloudfront.net': {
    env: 'uat',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://uat.portal.cloudmeter.io',
  },
  // UAT on its own domain. Listed explicitly: it has no `dev.` prefix, so
  // without this entry the host would fall through to prod.
  'uat.www.cloudmeter.io': {
    env: 'uat',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://uat.portal.cloudmeter.io',
  },
  'dxrygqau8xydt.cloudfront.net': {
    env: 'prod',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://portal.cloudmeter.io',
  },
  // Prod's real domains, served from the second account since cutover on
  // 2026-10-20. Listed so they can never fall through to the first account.
  'cloudmeter.io': {
    env: 'prod',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://portal.cloudmeter.io',
  },
  'www.cloudmeter.io': {
    env: 'prod',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
    portalUrl: 'https://portal.cloudmeter.io',
  },
};

window.CM_CONFIG = (function () {
  const host = window.location.hostname;
  if (CM_ACCOUNT_B[host]) return CM_ACCOUNT_B[host];
  const isDev = host.startsWith('dev.') || host === 'localhost' || host === '127.0.0.1';

  return isDev
    ? {
        env: 'dev',
        apiUrl: 'https://7o6ho72f83.execute-api.ap-south-1.amazonaws.com',
        portalUrl: 'https://dev.portal.cloudmeter.io',
      }
    : {
        env: 'prod',
        apiUrl: 'https://7v5gj5jwij.execute-api.ap-south-1.amazonaws.com',
        portalUrl: 'https://portal.cloudmeter.io',
      };
})();
