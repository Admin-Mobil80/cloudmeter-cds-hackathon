// CloudMeter — Settings page. The organization name, cost-monitoring
// frequency, notification rules and billing address below are genuinely
// persisted via their respective APIs; the payment-method section is still
// mockup-only.

// Shared so the sidebar and the close-account dialog both show the current
// name after a rename, without either re-fetching it.
let currentOrgName = null;

function setOrgName(name) {
  currentOrgName = name;
  document.querySelectorAll('.sidebar-brand .tag').forEach(el => {
    el.textContent = name;
    el.title = name;
  });
}

function showSaveConfirm(id) {
  const confirm = document.getElementById(id);
  if (!confirm) return;
  confirm.classList.add('show');
  clearTimeout(confirm._hideTimer);
  confirm._hideTimer = setTimeout(() => confirm.classList.remove('show'), 2200);
}

function describeInterval(hours) {
  if (hours >= 24) return 'every 24 hours';
  return `every ${hours} hours`;
}


// The browser's own tz database, so the list never drifts out of date and the
// user sees the same zone names their operating system uses.
function supportedTimezones() {
  if (typeof Intl.supportedValuesOf === 'function') {
    try { return Intl.supportedValuesOf('timeZone'); } catch { /* fall through */ }
  }
  // Older browsers don't expose the list; offer the zone they're actually in
  // plus UTC, which is enough to make a real choice.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([local, 'UTC'].filter(Boolean))];
}

/**
 * The engine's own preferred spelling of a zone.
 *
 * IANA keeps aliases forever — Asia/Calcutta and Asia/Kolkata are the same
 * zone, as are US/Eastern and America/New_York — and engines disagree about
 * which name is canonical. Node prefers Asia/Calcutta; browsers generally
 * prefer Asia/Kolkata. That is harmless for scheduling, since both resolve to
 * the same offset, but it is not harmless in a picker: a tenant stored under
 * one spelling got it appended to a list already containing the other, so
 * GMT+05:30 India appeared twice and neither entry looked like the saved one.
 *
 * resolvedOptions() collapses aliases to whichever name this engine prefers,
 * which is all that is needed — the list only has to be self-consistent.
 */
function canonicalZone(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone || tz;
  } catch {
    return tz;
  }
}

/** Minutes a zone is ahead of UTC right now, DST included. */
function zoneOffsetMinutes(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const asUtc = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour % 24, +parts.minute, +parts.second,
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function offsetLabel(tz) {
  const mins = zoneOffsetMinutes(tz);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `(GMT${sign}${hh}:${mm}) ${tz.replace(/_/g, ' ')}`;
}

function hourLabel(h) {
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

async function initTimezone() {
  const tzSelect = document.getElementById('tenant-timezone');
  const hourSelect = document.getElementById('digest-hour');
  const note = document.getElementById('digest-timing-note');
  const saveBtn = document.getElementById('timezone-save-btn');
  if (!tzSelect || !hourSelect) return;

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let saved = null;
  let canEdit = true;
  let savedHour = null;
  try {
    const s = await window.CM_Api.get('/tenant/settings');
    saved = s.timezoneSet ? s.timezone : null;
    canEdit = s.canEdit !== false;
    savedHour = s.digestHour;
  } catch (err) {
    console.error('Failed to load timezone settings', err);
  }

  // The stored zone may not appear in this browser's list: IANA aliases differ
  // by engine, and Safari lists Asia/Calcutta where others list Asia/Kolkata.
  // Without adding it the select renders blank, and saving then posts an empty
  // timezone — which is exactly how this broke.
  //
  // Everything is folded to this engine's spelling first, so adding the saved
  // zone re-adds an entry that is already there instead of a duplicate of it.
  const zones = Array.from(new Set([
    ...supportedTimezones(),
    ...(browserZone ? [browserZone] : []),
    ...(saved ? [saved] : []),
  ].map(canonicalZone)));

  // Grouped by offset so neighbours sit together — scanning 400 alphabetical
  // names for your own city is miserable.
  zones.sort((a, b) => zoneOffsetMinutes(a) - zoneOffsetMinutes(b) || a.localeCompare(b));

  tzSelect.innerHTML = zones
    .map(z => `<option value="${z}">${offsetLabel(z)}</option>`).join('');
  hourSelect.innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}">${hourLabel(h)}</option>`).join('');
  // Set only once the <option>s above exist — a <select> silently drops a
  // .value assignment made before it has any children, which is why a saved
  // hour never stuck.
  hourSelect.value = String(savedHour ?? 19);

  // Saved choice wins; otherwise the zone this browser is in, which is right
  // far more often than any default we could pick. Matched on the canonical
  // spelling so a tenant stored as Asia/Calcutta selects this engine's
  // Asia/Kolkata entry rather than falling through to the browser default.
  const savedCanonical = saved ? canonicalZone(saved) : null;
  tzSelect.value = savedCanonical && zones.includes(savedCanonical)
    ? savedCanonical
    : canonicalZone(browserZone || 'UTC');

  function describeTiming() {
    const tz = tzSelect.value;
    const hour = Number(hourSelect.value);
    if (!note) return;
    if (!tz) { note.textContent = ''; return; }
    // The equivalent UTC time is the only way to sanity-check when a message
    // actually goes out for a team spread across zones.
    const utcMinutes = (hour * 60) - zoneOffsetMinutes(tz);
    const utcHour = ((Math.floor(utcMinutes / 60) % 24) + 24) % 24;
    const utcMin = ((utcMinutes % 60) + 60) % 60;
    note.textContent = `Digests are sent at ${hourLabel(hour)} in ${tz.replace(/_/g, ' ')} `
      + `— that's ${String(utcHour).padStart(2, '0')}:${String(utcMin).padStart(2, '0')} UTC.`;
  }

  if (!canEdit) {
    tzSelect.disabled = true;
    hourSelect.disabled = true;
    saveBtn.disabled = true;
    saveBtn.title = 'Only an Admin or the account owner can change notification timing';
  }

  describeTiming();
  tzSelect.addEventListener('change', describeTiming);
  hourSelect.addEventListener('change', describeTiming);

  saveBtn.addEventListener('click', async () => {
    if (!tzSelect.value) {
      window.alert('Pick a timezone before saving.');
      return;
    }
    saveBtn.disabled = true;
    try {
      await window.CM_Api.put('/tenant/settings', {
        timezone: tzSelect.value,
        digestHour: Number(hourSelect.value),
      });
      showSaveConfirm('timezone-confirm');
    } catch (err) {
      window.alert(err.message);
    }
    saveBtn.disabled = false;
  });
}

async function initMonitoringFrequency() {
  const select = document.getElementById('monitor-frequency');
  const intervalEl = document.getElementById('monitor-interval');
  const saveBtn = document.getElementById('monitor-save-btn');
  if (!select) return;

  function reflect(frequency, minIntervalHours) {
    select.value = String(frequency);
    intervalEl.value = describeInterval(minIntervalHours);
  }

  try {
    const s = await window.CM_Api.get('/tenant/settings');
    reflect(s.monitoringFrequency, s.minIntervalHours);
    if (!s.canEdit) {
      select.disabled = true;
      saveBtn.disabled = true;
      saveBtn.title = 'Only an Admin or the account owner can change monitoring frequency';
    }
  } catch (err) {
    intervalEl.value = 'Unavailable';
    console.error('Failed to load tenant settings', err);
  }

  // Preview the resulting gap as the selection changes, before saving.
  select.addEventListener('change', () => {
    intervalEl.value = describeInterval(24 / Number(select.value));
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const res = await window.CM_Api.put('/tenant/settings', {
        monitoringFrequency: Number(select.value),
      });
      reflect(res.monitoringFrequency, res.minIntervalHours);
      showSaveConfirm('monitor-confirm');
    } catch (err) {
      window.alert(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// The organization name is real, persisted account state — it labels every
// page's sidebar. The other fields in that card are still mockup-only.
async function initOrgName() {
  const input = document.getElementById('org-name');
  const btn = document.getElementById('org-save-btn');
  if (!input || !btn) return;

  try {
    const s = await window.CM_Api.get('/tenant/settings');
    if (s.name) {
      input.value = s.name;
      setOrgName(s.name);
    }
    if (!s.canEdit) {
      input.disabled = true;
      btn.disabled = true;
      btn.title = 'Only an Admin or the account owner can change the organization name';
    }
  } catch (err) {
    console.error('Failed to load organization name', err);
  }

  btn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      window.alert('Enter an organization name.');
      input.focus();
      return;
    }
    btn.disabled = true;
    try {
      const res = await window.CM_Api.put('/tenant/settings', { name });
      setOrgName(res.name ?? name);
      showSaveConfirm('org-confirm');
    } catch (err) {
      window.alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'zip', 'country'];

async function initBillingAddress() {
  const btn = document.getElementById('address-save-btn');
  if (!btn) return;

  const fieldEl = (field) => document.getElementById(`addr-${field}`);

  try {
    const s = await window.CM_Api.get('/tenant/settings');
    if (s.billingAddress) {
      ADDRESS_FIELDS.forEach((field) => {
        const el = fieldEl(field);
        if (el && s.billingAddress[field]) el.value = s.billingAddress[field];
      });
    }
    if (!s.canEdit) {
      ADDRESS_FIELDS.forEach((field) => { const el = fieldEl(field); if (el) el.disabled = true; });
      btn.disabled = true;
      btn.title = 'Only an Admin or the account owner can change the billing address';
    }
  } catch (err) {
    console.error('Failed to load billing address', err);
  }

  btn.addEventListener('click', async () => {
    const billingAddress = Object.fromEntries(
      ADDRESS_FIELDS.map((field) => [field, fieldEl(field)?.value.trim() ?? '']),
    );
    btn.disabled = true;
    try {
      await window.CM_Api.put('/tenant/settings', { billingAddress });
      showSaveConfirm('address-confirm');
    } catch (err) {
      window.alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * The organisation-wide anomaly rule — one severity floor, one impact
 * threshold, for whoever holds Owner/Admin. This used to live on the
 * Notifications page behind a role check, which meant the page looked
 * different depending on who was looking at it and duplicated the
 * "per-account" idea in a second, contradictory form. Notifications is now
 * the same for everyone (per-account switches only); this is where an
 * Owner/Admin sets the account-wide rule instead. Delivery channel isn't
 * configured here — that's set per person, on their own Notifications page.
 * The daily digest has no on/off switch; it's always sent.
 */
async function initNotificationRules() {
  const severitySelect = document.getElementById('anomaly-severity');
  const thresholdInput = document.getElementById('anomaly-threshold');
  if (!severitySelect) return;

  let prefs;
  try {
    prefs = await window.CM_Api.get('/me/notification-prefs');
  } catch (err) {
    console.error('Failed to load notification preferences', err);
    return;
  }

  severitySelect.value = prefs.anomaly.severity;
  thresholdInput.value = prefs.anomaly.threshold;

  document.getElementById('anomaly-save-btn').addEventListener('click', async () => {
    prefs.anomaly.severity = severitySelect.value;
    prefs.anomaly.threshold = Number(thresholdInput.value) || 0;
    await window.CM_Api.put('/me/notification-prefs', prefs);
    showSaveConfirm('anomaly-confirm');
  });
}

// Closing a CloudMeter account is immediate and unrecoverable, so the button
// stays disabled until DELETE is typed — deliberate enough that it can't be
// armed by accident, without making someone go and look up the exact current
// spelling of their own organization name.
const CLOSE_CONFIRM_WORD = 'DELETE';
async function initCloseAccount() {
  const input = document.getElementById('close-confirm');
  const btn = document.getElementById('close-account-btn');
  const errorEl = document.getElementById('close-error');
  if (!input || !btn) return;

  // Still needed for the final confirm dialog, which names what's being closed
  // even though the typed word no longer has to match it.
  if (!currentOrgName) {
    try {
      const me = await window.CM_Api.get('/me');
      if (me.tenantName) setOrgName(me.tenantName);
    } catch (err) {
      console.error('Failed to load the organization name', err);
    }
  }

  input.addEventListener('input', () => {
    errorEl.classList.remove('show');
    btn.disabled = input.value.trim().toUpperCase() !== CLOSE_CONFIRM_WORD;
  });

  btn.addEventListener('click', async () => {
    if (!window.confirm(
      `Permanently close ${currentOrgName ? `"${currentOrgName}"` : 'this CloudMeter account'}?\n\n` +
      'All cloud accounts, stored credentials, cost history and team access will be ' +
      'destroyed immediately. This cannot be undone.'
    )) return;

    btn.disabled = true;
    btn.textContent = 'Closing account…';
    try {
      const res = await window.CM_Api.post('/tenant/close', { confirm: input.value.trim() });
      const warn = res.warnings?.length ? `\n\nNote:\n• ${res.warnings.join('\n• ')}` : '';
      window.alert(
        `Account closed.\n\n` +
        `Removed ${res.deleted.cloudAccounts} cloud account(s), ` +
        `${res.deleted.records} record(s) and ${res.deleted.logins} login(s).${warn}`
      );
      window.CM_Session.clear();
      // The marketing home page lives on its own site now, not in this app.
      window.location.href = window.CM_CONFIG.marketingUrl;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Close account permanently';
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initMonitoringFrequency();
  initTimezone();
  initNotificationRules();
  initCurrency();
  initBillingAddress();
  // Sequential: the org-name loader populates the shared organization name that
  // the close-account confirmation checks against.
  await initOrgName();
  initCloseAccount();
});

/**
 * Display currency.
 *
 * Only the presentation changes — costs are collected and stored in USD, and
 * this converts at render time. Stated on the page too, because "change
 * currency" reads like it might rewrite history, and it doesn't.
 */
async function initCurrency() {
  const mode = document.getElementById('display-currency');
  const sourceWrap = document.getElementById('fx-source-wrap');
  const note = document.getElementById('currency-note');
  const btn = document.getElementById('currency-save-btn');
  if (!mode) return;

  let current = null;
  try {
    const s = await window.CM_Api.get('/tenant/settings');
    current = s.currency;
    mode.value = current.mode;
    if (!s.canEdit) {
      [mode, btn].forEach(el => { el.disabled = true; });
      btn.title = 'Only an Admin or the account owner can change this';
    }
  } catch (err) {
    console.error('Failed to load currency settings', err);
    return;
  }

  function describe() {
    const local = current.localCode;
    const showing = mode.value === 'USD' ? 'USD' : local;

    // Nothing is being converted in USD, so a rate shown beside "US Dollars"
    // invited the obvious question of which rate applied — when the answer is
    // none. The whole field goes rather than being greyed out.
    sourceWrap.style.display = showing === 'USD' ? 'none' : '';

    if (showing === 'USD') {
      note.textContent = 'Spend is shown in USD, exactly as collected — no conversion applied.';
      return;
    }
    // localRate, not rate. When USD is the saved mode the server short-circuits
    // and reports rate: 1 — correct for USD, but quoting it here the moment
    // someone toggled the dropdown produced "1 USD = 1.00 INR". localRate is
    // what converting would actually use, whatever is saved.
    const rate = current.localRate ?? current.rate;
    const rateAsOf = current.localRateAsOf ?? current.rateAsOf;
    const asOf = rateAsOf
      ? new Date(rateAsOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'today';
    note.textContent = `Spend is converted to ${local} at the live rate `
      + `(1 USD = ${Number(rate).toFixed(2)} ${local}, updated ${asOf}).`;
  }
  describe();
  mode.addEventListener('change', describe);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await window.CM_Api.put('/tenant/settings', {
        displayCurrency: mode.value,
        // The only source on offer since the manual option was removed. Sent
        // explicitly rather than read off the field, which is now a read-only
        // label showing prose, not a value the API would understand.
        fxSource: 'auto',
        // Always the live rate now that the manual option is gone from
        // the UI; the API still accepts a value if it is ever restored.
        fxRateManual: null,
      });
      current = res.currency;
      describe();
      showSaveConfirm('currency-confirm');
      // Every figure on every page is formatted from this, so a reload is the
      // honest way to apply it rather than leaving stale numbers around.
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      window.alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}
