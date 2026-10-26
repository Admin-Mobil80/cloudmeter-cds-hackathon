// CloudMeter — right-click and devtools-shortcut guard.
//
// NOT A SECURITY CONTROL, and nothing here should be counted as one. It is
// trivially bypassed: the browser's own menu opens devtools without touching
// the page, shortcuts vary by platform and build, view-source: needs no
// keypress, disabling JavaScript removes every handler below, and curl or an
// intercepting proxy never involves a browser at all. Anything shipped to a
// browser is readable by whoever receives it.
//
// The real protections are server-side and unaffected by any of this:
// credentials live in Secrets Manager and are never sent to a client, tokens
// are per-user and expire in an hour, every authorization decision is made in
// the API, and the CSP set on the CloudFront distribution stops injected
// script executing.
//
// This exists because it was asked for as a deterrent against casual copying.
// Kept deliberately narrow so it cannot break real use: no devtools-detection
// polling, no debugger traps, no window resizing heuristics — those produce
// false positives, burn CPU, and break legitimate tooling.
(function () {
  // Copy, paste and select stay working: blocking them punishes customers
  // reading their own cost data and stops nobody.
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  document.addEventListener('keydown', function (e) {
    const key = (e.key || '').toLowerCase();

    // F12
    if (key === 'f12') { e.preventDefault(); return; }

    // Ctrl/Cmd+Shift+I / J / C — devtools, console, element picker
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(key)) {
      e.preventDefault();
      return;
    }

    // Ctrl/Cmd+U — view source
    if ((e.ctrlKey || e.metaKey) && key === 'u') {
      e.preventDefault();
    }
  });
}());
