// The payments page moved to plans.html. This was an inline <script> in
// payments.html; it lives in its own file so the site's Content-Security-Policy
// can keep script-src 'self' rather than allowing inline script everywhere to
// accommodate one redirect.
window.location.replace('plans.html');
