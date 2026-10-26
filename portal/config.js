// CloudMeter — per-environment backend config. Dev is served from
// dev.portal.cloudmeter.io / dev.bms.cloudmeter.io (and localhost, for local
// testing); everything else (portal.cloudmeter.io, bms.cloudmeter.io) is prod.
// The WhatsApp sender is public information, not a credential — it's the number
// alerts arrive from, and people should recognise it before it messages them.
// Same number in both environments; only the API keys behind it differ.
const CM_WHATSAPP_FROM = '+91 81058 23737';


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
  'd3bftr1tn29m8e.cloudfront.net': {
    env: 'dev', region: 'us-east-1',
    userPoolId: 'us-east-1_RS6XKDyOf',
    clientId: '31ud3lhc17tm5omargj94qsja2',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://ls3qlgqworaedfqze3x47avpta.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://dudojxk6tcmaz.cloudfront.net',
  },
  // Dev's real domain, served from the second account since 2026-10-20.
  // Listed explicitly: the `dev.` check below still points at the first.
  'dev.portal.cloudmeter.io': {
    env: 'dev', region: 'us-east-1',
    userPoolId: 'us-east-1_RS6XKDyOf',
    clientId: '31ud3lhc17tm5omargj94qsja2',
    apiUrl: 'https://bai5yei6jf.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://ls3qlgqworaedfqze3x47avpta.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://dev.www.cloudmeter.io',
  },
  'dd97yrjdyk3yc.cloudfront.net': {
    env: 'uat', region: 'us-east-1',
    userPoolId: 'us-east-1_eXoeKlfSv',
    clientId: '2jlh4s1t0hat698f7b4ljbc32u',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://v63h3qcp7zdaxa267mktaqmivm.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://uat.www.cloudmeter.io',
  },
  // UAT on its own domain. Listed explicitly: it has no `dev.` prefix, so
  // without this entry the host would fall through to prod.
  'uat.portal.cloudmeter.io': {
    env: 'uat', region: 'us-east-1',
    userPoolId: 'us-east-1_eXoeKlfSv',
    clientId: '2jlh4s1t0hat698f7b4ljbc32u',
    apiUrl: 'https://9iuet1n0s4.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://v63h3qcp7zdaxa267mktaqmivm.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://uat.www.cloudmeter.io',
  },
  'd32g8qr7r645lh.cloudfront.net': {
    env: 'prod', region: 'us-east-1',
    userPoolId: 'us-east-1_MiKIgrEgm',
    clientId: '7uunp84t7hi9u5djv2fh4728lc',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://6v4yzr2k7fgypprqrh64mwbq2e.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://dxrygqau8xydt.cloudfront.net',
  },
  // Prod's real domain, served from the second account since cutover on
  // 2026-10-20. Listed so it can never fall through to the first account.
  'portal.cloudmeter.io': {
    env: 'prod', region: 'us-east-1',
    userPoolId: 'us-east-1_MiKIgrEgm',
    clientId: '7uunp84t7hi9u5djv2fh4728lc',
    apiUrl: 'https://tqp9u8spyh.execute-api.us-east-1.amazonaws.com',
    graphqlUrl: 'https://6v4yzr2k7fgypprqrh64mwbq2e.appsync-api.us-east-1.amazonaws.com/graphql',
    whatsappFrom: CM_WHATSAPP_FROM,
    marketingUrl: 'https://cloudmeter.io',
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
        userPoolId: 'ap-south-1_TEnbyMuYh',
        clientId: '65e3oecue399gd5vm1mdp3cepu',
        apiUrl: 'https://7o6ho72f83.execute-api.ap-south-1.amazonaws.com',
        graphqlUrl: 'https://r6ixovdj5zb43cwi4dqypyeuay.appsync-api.ap-south-1.amazonaws.com/graphql',
        whatsappFrom: CM_WHATSAPP_FROM,
        // The marketing home page moved to its own site — the portal no
        // longer serves one — so anywhere the portal needs to link back to
        // "home" (the sign-in page's brand link, a closed-account redirect)
        // points here instead.
        marketingUrl: 'https://dev.www.cloudmeter.io',
      }
    : {
        env: 'prod',
        region: 'ap-south-1',
        userPoolId: 'ap-south-1_OFIG31ZmO',
        clientId: '14ikl91k40e00vhu1dj6f5d2d6',
        apiUrl: 'https://7v5gj5jwij.execute-api.ap-south-1.amazonaws.com',
        graphqlUrl: 'https://h622lv5ptfapndv4nm2ot2s6pe.appsync-api.ap-south-1.amazonaws.com/graphql',
        whatsappFrom: CM_WHATSAPP_FROM,
        marketingUrl: 'https://www.cloudmeter.io',
      };
})();
