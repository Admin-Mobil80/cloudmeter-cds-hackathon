// CloudMeter BMS — per-environment config for the staff console.
//
// A different Cognito pool from the customer portal on purpose: staff and
// customers are separate populations, and a portal token must never satisfy a
// BMS route. Same API host, different authorizer behind /bms/*.

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
  'd2qt2ijh58rc69.cloudfront.net': {
    env: 'dev', region: 'us-east-1',
    userPoolId: 'us-east-1_HkbVTcLZT',
    clientId: '1m2iutfd8pvibp4cq9hevvc0r7',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
  },
  // Dev's real domain, served from the second account since 2026-10-20.
  // Listed explicitly: the `dev.` check below still points at the first.
  'dev.bms.cloudmeter.io': {
    env: 'dev', region: 'us-east-1',
    userPoolId: 'us-east-1_HkbVTcLZT',
    clientId: '1m2iutfd8pvibp4cq9hevvc0r7',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
  },
  'd19zeqh2xa8ikt.cloudfront.net': {
    env: 'uat', region: 'us-east-1',
    userPoolId: 'us-east-1_edRHsMJiT',
    clientId: '1i8sgv06dkelp1jfgb1klb643o',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
  },
  // UAT on its own domain. Listed explicitly: it has no `dev.` prefix, so
  // without this entry the host would fall through to prod.
  'uat.bms.cloudmeter.io': {
    env: 'uat', region: 'us-east-1',
    userPoolId: 'us-east-1_edRHsMJiT',
    clientId: '1i8sgv06dkelp1jfgb1klb643o',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
  },
  'dd30w9jmo7kws.cloudfront.net': {
    env: 'prod', region: 'us-east-1',
    userPoolId: 'us-east-1_A4KjiOeOh',
    clientId: '7frpb2l1co26cjno9s56iqkuak',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
  },
  // Prod's real domain, served from the second account since cutover on
  // 2026-10-20. Listed so it can never fall through to the first account.
  'bms.cloudmeter.io': {
    env: 'prod', region: 'us-east-1',
    userPoolId: 'us-east-1_A4KjiOeOh',
    clientId: '7frpb2l1co26cjno9s56iqkuak',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
  },
};

window.CM_CONFIG = (function () {
  const host = window.location.hostname;
  if (CM_ACCOUNT_B[host]) return CM_ACCOUNT_B[host];
  const isDev = host.startsWith('dev.') || host === 'localhost' || host === '127.0.0.1';

  return isDev
    ? {
        env: 'dev',
        region: 'ap-south-1',
        userPoolId: 'ap-south-1_GNsN49tzB',
        clientId: '4o22ojj9bnp5hhccrbje6dmhu1',
        apiUrl: 'https://7o6ho72f83.execute-api.ap-south-1.amazonaws.com',
      }
    : {
        env: 'prod',
        region: 'ap-south-1',
        userPoolId: 'ap-south-1_ko2mqgvlr',
        clientId: '381ajvcs8fm2pobigsmivuc17k',
        apiUrl: 'https://7v5gj5jwij.execute-api.ap-south-1.amazonaws.com',
      };
})();
