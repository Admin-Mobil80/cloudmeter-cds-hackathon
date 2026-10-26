// CloudMeter marketing site — points every sign-in/sign-up link at the portal.
//
// This site and the portal are different origins (www vs portal), so a plain
// relative href like "login.html" would 404 here. Every such link instead
// carries data-portal-path, and this fills in the real target from config —
// dev.www links to dev.portal, www links to portal, and the two can never
// drift since there is exactly one place (config.js) that says which is which.
(function () {
  document.querySelectorAll('[data-portal-path]').forEach((el) => {
    el.href = `${window.CM_CONFIG.portalUrl}/${el.dataset.portalPath}`;
  });
})();
