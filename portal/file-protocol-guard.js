// CloudMeter — file:// guard
// Browsers don't reliably share sessionStorage across separate file:// pages
// (Safari/Firefox give every local file its own origin; Chrome is inconsistent too),
// which silently breaks sign-in and navigation. Fail loudly instead of confusingly.
(function () {
  if (window.location.protocol !== 'file:') return;

  function takeover() {
    document.documentElement.innerHTML = `
      <head><meta charset="UTF-8"><title>CloudMeter — needs a local server</title></head>
      <body style="margin:0"></body>`;
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1420;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;box-sizing:border-box;">
        <div style="max-width:460px;background:#16233a;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;">
          <div style="font-size:28px;margin-bottom:12px">⚠️</div>
          <h1 style="font-size:18px;margin:0 0 10px;font-weight:700;">This needs a local server, not a direct file open</h1>
          <p style="font-size:13.5px;line-height:1.6;color:#c7cedb;margin:0 0 18px;">Opening these files by double-clicking (file://) breaks sign-in and navigation — browsers don't reliably share storage across local files, so your session gets lost between pages.</p>
          <p style="font-size:12.5px;color:#9aa7bd;margin:0 0 6px;">From this folder, run:</p>
          <code style="display:block;background:#0d1420;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px 12px;font-size:12.5px;color:#9ec5f4;margin-bottom:14px;">python3 -m http.server 8000</code>
          <p style="font-size:12.5px;color:#9aa7bd;margin:0;">Then open <strong style="color:#fff">http://localhost:8000</strong> instead.</p>
        </div>
      </div>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', takeover);
  } else {
    takeover();
  }
})();
