// CloudMeter — shared cloud account data, backed by the real Accounts API.

// How many of the tenant's accounts the caller isn't mapped to. Set by
// loadAllAccounts so the empty state can tell "none connected" apart from
// "none shared with you".
window.CM_ACCOUNTS_HIDDEN = 0;

async function loadAllAccounts() {
  const data = await window.CM_Api.get('/accounts');
  window.CM_ACCOUNTS_HIDDEN = data.hiddenByScope || 0;
  return data.accounts;
}

async function findAccountById(accountId) {
  return window.CM_Api.get(`/accounts/${encodeURIComponent(accountId)}`);
}

async function createAccount(providerKey, { name, id, owner, connectionToken, credentials, useSampleData }) {
  return window.CM_Api.post('/accounts', {
    provider: providerKey, name, id, owner, connectionToken, credentials, useSampleData,
  });
}

async function updateAccountOwner(accountId, owner) {
  return window.CM_Api.patch(`/accounts/${encodeURIComponent(accountId)}`, { owner });
}

// The display label only — never the provider's own account identifier, which
// is what the credentials are tied to and so is not ours to rewrite.
async function renameAccount(accountId, name) {
  return window.CM_Api.patch(`/accounts/${encodeURIComponent(accountId)}`, { name });
}

// Hands an account to another teammate. The server decides who's allowed to
// and who's a valid target; this just carries the request.
async function reassignAccount(accountId, userId) {
  return window.CM_Api.patch(`/accounts/${encodeURIComponent(accountId)}`, { createdBy: userId });
}

let teamCache = null;
async function fetchTeam() {
  if (!teamCache) teamCache = (await window.CM_Api.get('/team')).members;
  return teamCache;
}

let providerMetaCache = null;
async function fetchProviderMeta() {
  if (!providerMetaCache) {
    const { providers } = await window.CM_Api.get('/providers');
    providerMetaCache = Object.fromEntries(providers.map(p => [p.key, p]));
  }
  return providerMetaCache;
}

async function fetchConnectParams() {
  return window.CM_Api.post('/accounts/connect-params');
}

async function refreshAccount(accountId, { force = false } = {}) {
  return window.CM_Api.post(`/accounts/${encodeURIComponent(accountId)}/refresh`, { force });
}

async function deleteAccount(accountId) {
  return window.CM_Api.delete(`/accounts/${encodeURIComponent(accountId)}`);
}

// Base implementation — available on every page that loads this file (the
// "Add cloud account" modal is reachable from more than just accounts.html).
// accounts.js overrides this with a version that also updates its own list.
window.CM_addAccount = async function (providerKey, accountData) {
  return createAccount(providerKey, accountData);
};
