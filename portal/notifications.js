// CloudMeter — per-member notification preferences, backed by the real
// Notification Prefs API. The WhatsApp "connect" flow still simulates the
// verification code (the Cloud API integration lands once Meta approves our
// templates), but the resulting preference state is genuinely persisted.

const DEFAULT_PREFS = {
  channels: {
    whatsapp: { connected: false, phone: null },
    slack: { connected: false },
  },
  anomaly: { severity: 'critical_serious', threshold: 10, channels: ['email'] },
  digest: { enabled: true, channels: ['email'] },
};

let prefs = DEFAULT_PREFS;

async function savePrefs() {
  await window.CM_Api.put('/me/notification-prefs', prefs);
}

function el(id) { return document.getElementById(id); }

// Country code is a separate field so the user types only their own number.
// The default comes from the account's timezone — captured from this person's
// browser at sign-up — which beats browser language, since plenty of people
// run an en-US machine from Bengaluru.
function initCountryCodes() {
  const select = el('wa-country-code');
  if (!select || !window.CM_DIAL_CODES) return;

  select.innerHTML = window.CM_DIAL_CODES
    .map(c => `<option value="${c.dial}" data-iso="${c.iso}">${c.dial} · ${c.name}</option>`)
    .join('');

  const guess = window.CM_guessCountry(window.CM_ACCOUNT_TIMEZONE);
  const match = window.CM_DIAL_CODES.find(c => c.iso === guess);
  if (match) {
    // Several countries share +1, so match on the option's ISO, not its value.
    const option = Array.from(select.options).find(o => o.dataset.iso === match.iso);
    if (option) select.value = option.value, option.selected = true;
  }

  select.addEventListener('change', renderPhonePreview);
  el('wa-phone-input')?.addEventListener('input', renderPhonePreview);
  renderPhonePreview();

  // Naming the sender up front means an unexpected message from an unknown
  // number doesn't get taken for spam and blocked.
  const from = el('wa-from-note');
  if (from && window.CM_CONFIG?.whatsappFrom) {
    from.innerHTML = `Alerts arrive from <strong>${window.CM_CONFIG.whatsappFrom}</strong>. `
      + `Save it as a contact so they aren't mistaken for spam. `
      + `Verification isn't live yet, so no code is sent.`;
  }
}

/** E.164, which is the only form the WhatsApp API accepts. */
function fullNumber() {
  const dial = el('wa-country-code')?.value ?? '';
  const national = (el('wa-phone-input')?.value ?? '').replace(/[^0-9]/g, '');
  return `${dial}${national}`;
}

function renderPhonePreview() {
  const note = el('wa-phone-preview');
  if (!note) return;
  const national = (el('wa-phone-input')?.value ?? '').replace(/[^0-9]/g, '');
  note.textContent = national ? `We'll message ${fullNumber()}` : '';
}

function renderChannelStatuses() {
  const email = window.CM_ME?.email || window.CM_Session.getEmail() || '';
  el('email-status').textContent = `Verified · ${email}`;

  const wa = prefs.channels.whatsapp;
  el('whatsapp-status').textContent = wa.connected
    ? `Connected · ${wa.phone}`
    : (planAllows('whatsapp') ? 'Not connected' : notIncluded('whatsapp'));
  el('whatsapp-status').classList.toggle('connected', wa.connected);
  el('whatsapp-connect-btn').textContent = wa.connected ? 'Disconnect' : 'Connect WhatsApp';
  // Offering Connect on a channel the plan excludes is the tile version of a
  // ticked box that delivers nothing: the server refuses it, so the button
  // should not invite it. Disconnect stays available — see below.
  el('whatsapp-connect-btn').disabled = !wa.connected && !planAllows('whatsapp');

  const sl = prefs.channels.slack || {};
  /*
   * Precedence when not connected: the plan first, then a failed send.
   *
   * A revoked token and an unentitled plan can both be true, and only one of
   * them is worth acting on — reconnecting cannot help a workspace whose plan
   * has no Slack, so saying "CloudMeter's access was removed" would send
   * somebody to fix the wrong thing.
   */
  const stopped = sl.connected ? null : slackStoppedMessage(sl);
  el('slack-status').textContent = sl.connected
    ? 'Connected'
    : (planAllows('slack') ? (stopped || 'Not connected') : notIncluded('slack'));
  el('slack-status').classList.toggle('connected', !!sl.connected);
  el('slack-connect-btn').textContent = sl.connected ? 'Disconnect' : 'Connect Slack';
  /*
   * Connect is blocked, Disconnect never is.
   *
   * Someone already connected on a plan that no longer includes the channel
   * must still be able to switch it off, and the endpoint is built the same
   * way round: it refuses a connect and always honours a disconnect.
   */
  el('slack-connect-btn').disabled = !sl.connected && !planAllows('slack');

  /*
   * The workspace-level install line.
   *
   * Shown to Owners and Admins only, and left alone once something has been
   * written into it — a message from a failed connect, or from coming back
   * from Slack, is more useful than the standing invitation it replaces.
   */
  const note = el('slack-install-note');
  if (note && !note.dataset.claimed) note.hidden = !shouldOfferSlackInstall();
}

/**
 * What to say when a Slack connection was switched off by a failed send.
 *
 * A send that proved the install dead turns the connection off. Left at the
 * bare "Not connected" the reader takes it for their own doing, and never
 * learns their digests had been failing — the silence this exists to end.
 *
 * The reasons are Slack's own codes, and each means something different to
 * whoever has to fix it: an app removed from the workspace needs an admin,
 * a deleted conversation needs only a reconnect.
 */
function slackStoppedMessage(slack) {
  const why = slack && slack.disconnectedReason;
  if (!why) return null;
  const when = slack.disconnectedAt
    ? ` on ${new Date(slack.disconnectedAt).toLocaleDateString()}`
    : '';
  switch (why) {
    case 'token_revoked':
    case 'invalid_auth':
    case 'account_inactive':
      return `Slack stopped working${when} — CloudMeter's access to your Slack was removed. An Owner or Admin needs to install it again.`;
    case 'channel_not_found':
    case 'not_in_channel':
    case 'is_archived':
      return `Slack stopped working${when} — the conversation CloudMeter was posting to is gone. Connect again to start a new one.`;
    default:
      return `Slack stopped working${when} (${why}). Connect again to start receiving messages.`;
  }
}

/**
 * Whether this person may install CloudMeter into the company's Slack.
 *
 * Installing grants posting rights and member-list access for the whole
 * workspace — an organisation decision, not a personal preference — so it is
 * Owners and Admins only. Connecting *yourself* has no such restriction.
 */
function canInstallSlack() {
  const role = window.CM_ME?.role;
  return role === 'owner' || role === 'admin';
}

/**
 * Whether to offer installing CloudMeter into the company's Slack.
 *
 * Only when there is something to install. The first version asked the role
 * and nothing else, so a workspace already using Slack was told "Nobody has
 * set up Slack for this workspace yet" directly beneath a channel row reading
 * "Connected" — two lines flatly contradicting each other.
 *
 * `slackWorkspaceReady` comes from the preferences response and is the
 * backend's answer to "does this tenant have a bot token". Treated as not-
 * ready when absent, so an older response offers the install rather than
 * hiding a workspace's only route to setting Slack up.
 */
function shouldOfferSlackInstall() {
  // No point inviting an Owner to install CloudMeter into their Slack when
  // the plan would withhold every message it could then send.
  if (!planAllows('slack')) return false;
  return canInstallSlack() && prefs.slackWorkspaceReady !== true;
}

/**
 * What CloudMeter says after Slack sends someone back.
 *
 * The install happens on Slack's site and returns here with a query string;
 * without this the person lands on an unchanged page and cannot tell whether
 * anything happened.
 */
function slackReturnMessage(outcome) {
  switch (outcome) {
    case 'installed':
      return { text: 'Slack is set up for this workspace. Connect yourself above to start receiving messages.', good: true };
    case 'cancelled':
      return { text: 'Slack install cancelled — nothing changed.', good: false };
    case 'expired':
      return { text: 'That install link had expired. Start again.', good: false };
    case 'failed':
      return { text: "Slack couldn't complete the install. Try again, or contact support if it keeps failing.", good: false };
    default:
      return null;
  }
}

/**
 * Whether a ticked channel can actually deliver to this person.
 *
 * Email always can. The other two need connecting first, and a tick on a
 * channel that cannot deliver looks covered and is not — which is exactly how
 * eleven people sat verified on WhatsApp and received nothing.
 */
function canDeliver(channel) {
  // A channel the plan withholds cannot deliver however well it is connected:
  // the sweep drops it before sending. Checked first so a row never reports a
  // connected-but-withheld channel as covered.
  if (!planAllows(channel)) return false;
  if (channel === 'email') return true;
  return !!prefs.channels?.[channel]?.connected;
}

/**
 * Whether this workspace's plan includes a channel.
 *
 * The server decides and sends the list; this never works it out from a plan
 * id, so the page cannot disagree with the sweep about who gets what.
 *
 * Absent — an older response, or a tenant the server could not read — means
 * allow. The page then shows what it has always shown, which is the harmless
 * direction to be wrong in: the sweep still enforces, and a page that hid a
 * working channel would be its own bug.
 */
function planAllows(channel) {
  const list = prefs.allowedChannels;
  return !Array.isArray(list) || list.includes(channel);
}

/** The plan that would grant a withheld channel, e.g. 'Scale'. */
function planFor(channel) {
  return (prefs.channelUpgrades || {})[channel] || null;
}

/**
 * What a channel tile says when the plan does not include it.
 *
 * Names the tier where the server sent one, and stays truthful where it did
 * not: an older response carries no plan names, and "available on undefined"
 * is worse than saying nothing.
 */
function notIncluded(channel) {
  const needs = planFor(channel);
  return needs
    ? `Not included on your plan — available on ${needs}`
    : 'Not included on your plan';
}

/** The channel list for one group, defaulted the way the API defaults it. */
function channelsOf(group) {
  const list = prefs[group]?.channels;
  return Array.isArray(list) ? list : ['email'];
}

const GROUP_LABEL = { anomaly: 'Spike alerts', digest: 'The daily digest' };

/**
 * What a row says when it is about to deliver nothing.
 *
 * Silence is allowed — someone who watches the portal may genuinely want it —
 * but it must never be arrived at by accident, so the row says plainly what
 * has just been switched off. Spike alerts get the blunter wording: a digest
 * nobody reads costs a day's awareness, a missed spike costs money.
 */
function warningFor(group) {
  const list = channelsOf(group);
  const LABEL = { email: 'Email', whatsapp: 'WhatsApp', slack: 'Slack' };

  if (list.length > 0) {
    /*
     * Ticked, but nothing ticked can deliver.
     *
     * Checked across every channel rather than WhatsApp alone: with Slack
     * added, someone could tick Slack only, never have connected it, and see a
     * row that looks covered while nothing is sent. That is the WhatsApp
     * failure repeating itself one column over.
     */
    const dead = list.filter((c) => !canDeliver(c));
    if (dead.length === list.length) {
      const names = dead.map((c) => LABEL[c] || c).join(' or ');
      /*
       * Withheld by the plan reads differently from never connected.
       *
       * Telling someone their Slack "isn't connected yet" when it is connected
       * and working sends them to reconnect it, which succeeds and changes
       * nothing. The fix is an upgrade, so the sentence has to say so.
       */
      const blocked = dead.filter((c) => !planAllows(c));
      if (blocked.length === dead.length) {
        const plans = [...new Set(blocked.map(planFor).filter(Boolean))].join(' and ');
        return `${GROUP_LABEL[group]} won't reach you — ${names} `
          + `${blocked.length > 1 ? 'are' : 'is'} not included on your plan`
          + `${plans ? `, which needs ${plans}` : ''}. Tick Email instead.`;
      }
      return `${GROUP_LABEL[group]} won't reach you — ${names} `
        + `${dead.length > 1 ? 'are' : "isn't"} connected yet, so there is nowhere to send them. `
        + 'Connect it above, or tick Email.';
    }
    return null;
  }

  // Nothing ticked at all. Silence is allowed — someone who watches the portal
  // may genuinely want it — but it must never be arrived at by accident.
  const ready = ['whatsapp', 'slack'].filter(canDeliver).map((c) => LABEL[c]);
  const how = ready.length
    ? `Tick Email${ready.map((n) => ` or ${n}`).join('')} to start receiving them again.`
    : 'Tick Email, or connect another channel above, to start receiving them again.';
  return group === 'anomaly'
    ? `No spike alerts will reach you. A cost jump will only show in the portal. ${how}`
    : `The daily digest won't reach you. ${how}`;
}


/**
 * Paints the delivery grid from the stored preferences.
 *
 * The WhatsApp column is disabled until a number is verified, because ticking
 * it would record a preference that cannot deliver — the senders check the
 * verified number independently of the channel list.
 */
function renderDelivery() {
  const grid = el('delivery');
  if (!grid) return;
  const connected = !!prefs.channels?.whatsapp?.connected;

  grid.querySelectorAll('input[data-group]').forEach((box) => {
    const channel = box.dataset.channel;
    const list = channelsOf(box.dataset.group);

    /*
     * A channel the plan withholds shows as off, and disabled.
     *
     * Shown unticked deliberately. A greyed box that is still ticked reads as
     * "this is on, you just can't change it" — which is the thing that is not
     * true, and the whole reason this column needed touching. Off and
     * unclickable says what is actually happening.
     *
     * The stored preference is left alone: this changes what is drawn, never
     * what is saved. Nothing reads the ticks back — a change event writes to
     * `prefs`, and a disabled box fires none — so moving to a plan that
     * includes the channel brings the original choice back by itself.
     */
    box.checked = list.includes(channel) && planAllows(channel);

    const needs = planAllows(channel) ? null : planFor(channel);
    if (!planAllows(channel)) {
      box.disabled = true;
      box.title = needs ? `Included on the ${needs} plan` : 'Not included on your plan';
    } else if (channel === 'whatsapp') {
      box.disabled = !connected;
      box.title = connected ? '' : 'Connect WhatsApp first';
    } else {
      // Reset explicitly: this runs again after every save, and a box left
      // disabled from a previous render would never come back.
      box.disabled = false;
      box.title = '';
    }
  });

  /*
   * The explanation sits once above the column rather than on each row.
   *
   * Built from text nodes rather than innerHTML — the plan name comes from the
   * server, and this page has been bitten by unescaped interpolation before.
   */
  grid.querySelectorAll('[data-head]').forEach((head) => {
    if (!head.dataset.label) head.dataset.label = head.textContent.trim();
    head.textContent = head.dataset.label;
    const needs = planAllows(head.dataset.head) ? null : planFor(head.dataset.head);
    if (!needs) return;
    const note = document.createElement('span');
    /*
     * Styled here rather than in styles.css on purpose.
     *
     * The header is uppercase, bold and letter-spaced, and `.d` is only given
     * display:block inside .delivery-row — so the note ran into the label and
     * came out as "SLACKSCALE PLAN". A stylesheet rule would have been the
     * tidier home for this, but styles.css is shared by all ten portal pages
     * and touching it means bumping the cache-busting version on every one of
     * them for a three-line fix on this page.
     */
    note.style.display = 'block';
    note.style.textTransform = 'none';
    note.style.fontWeight = '400';
    note.style.letterSpacing = 'normal';
    note.style.fontSize = '10.5px';
    note.style.marginTop = '3px';
    note.style.opacity = '0.85';
    note.textContent = `${needs} plan`;
    head.appendChild(note);
  });

  grid.querySelectorAll('[data-warn]').forEach((note) => {
    const text = warningFor(note.dataset.warn);
    note.hidden = !text;
    note.textContent = text || '';
  });
}

/**
 * Saves, and puts the control back where it was if the server refuses.
 *
 * Every switch here writes the whole preferences object, so a rejected save
 * must not leave the page claiming a setting that was never stored.
 */
async function commit(box, apply) {
  const before = JSON.parse(JSON.stringify(prefs));
  apply();
  box.disabled = true;
  try {
    await savePrefs();
    renderDelivery();
    showConfirm('channels-confirm');
  } catch (err) {
    console.error('Could not save notification preference', err);
    prefs = before;
    renderDelivery();
    window.alert(err.message || "Couldn't save that — try again.");
  } finally {
    box.disabled = false;
  }
}

function wireDelivery() {
  document.querySelectorAll('#delivery input[data-group]').forEach((box) => {
    box.addEventListener('change', () => {
      const { group, channel } = box.dataset;
      const wanted = box.checked;
      commit(box, () => {
        // A group can be absent on an older record — the API defaults it on
        // read, but the object held here may still be missing it, and skipping
        // that is exactly how a preference silently fails to save.
        if (!prefs[group]) prefs[group] = { channels: ['email'] };
        const list = channelsOf(group);
        prefs[group].channels = wanted
          ? (list.includes(channel) ? list : [...list, channel])
          : list.filter((c) => c !== channel);
      });
    });
  });
}

function renderAll() {
  renderChannelStatuses();
  renderDelivery();
}

function showConfirm(id) {
  const c = el(id);
  if (!c) return;
  c.classList.add('show');
  clearTimeout(c._t);
  c._t = setTimeout(() => c.classList.remove('show'), 2200);
}

document.addEventListener('cm-me-loaded', () => {
  renderChannelStatuses();
  renderMemberAccounts();
});

/**
 * Per-account alert switches — the same view for everyone regardless of
 * role. Setting these one account at a time from each account's own page is
 * fine for two and painful for seventeen, which is why they are gathered
 * here. The organisation-wide anomaly rule and digest delivery preferences
 * live in Settings instead, since only an Owner or Admin can change them.
 */
async function renderMemberAccounts() {
  const card = document.getElementById('member-accounts-card');
  const list = document.getElementById('member-accounts-list');
  if (!card || !list) return;
  card.hidden = false;

  let accounts;
  try {
    // Sample accounts (demo data) never generate real alerts or a real
    // digest, so a switch for one here would control nothing — leaving it
    // out avoids implying otherwise.
    accounts = ((await window.CM_Api.get('/accounts')).accounts || [])
      .filter((a) => a.dataSource === 'live');
  } catch (err) {
    list.innerHTML = `<p class="muted" style="padding:12px 0">Couldn't load your cloud accounts — ${escapeHtml(err.message || '')}</p>`;
    return;
  }

  if (accounts.length === 0) {
    list.innerHTML = '<p class="muted" style="padding:12px 0">'
      + 'No live cloud accounts yet — connect one from Cloud Accounts to start monitoring it.</p>';
    return;
  }

  // The list endpoint doesn't carry per-account switches, so read each
  // account's own record — it returns the caller's settings for it.
  const rows = await Promise.all(accounts.map(async (a) => {
    let n = { anomaly: true, digest: true };
    try {
      n = (await window.CM_Api.get(`/accounts/${encodeURIComponent(a.id)}`)).notifications || n;
    } catch { /* default to on rather than claiming a setting we couldn't read */ }
    return { ...a, notifications: n };
  }));

  list.innerHTML = rows.map((a) => `
    <div class="acct-notify-row" data-account="${escapeHtml(a.id)}">
      <span class="a">
        <span class="n">${escapeHtml(a.name)}</span>
        <span class="d">${escapeHtml(a.externalId || '')}</span>
      </span>
      <span class="c"><input type="checkbox" data-kind="anomaly" ${a.notifications.anomaly !== false ? 'checked' : ''}></span>
      <span class="c"><input type="checkbox" data-kind="digest" ${a.notifications.digest !== false ? 'checked' : ''}></span>
    </div>`).join('');

  list.querySelectorAll('input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => saveAccountSwitch(box));
  });

  const bulk = (on) => {
    list.querySelectorAll('input[type=checkbox]').forEach((box) => {
      if (box.checked === on) return;
      box.checked = on;
      saveAccountSwitch(box);
    });
  };
  document.querySelector('[data-notify-all]').addEventListener('click', () => bulk(true));
  document.querySelector('[data-notify-none]').addEventListener('click', () => bulk(false));
}

async function saveAccountSwitch(box) {
  const row = box.closest('.acct-notify-row');
  const kind = box.dataset.kind;
  box.disabled = true;
  try {
    await window.CM_Api.put(
      `/accounts/${encodeURIComponent(row.dataset.account)}/notifications`,
      { [kind]: box.checked },
    );
    showConfirm('member-accounts-confirm');
  } catch (err) {
    // Put it back: a switch left flipped claims a setting that was never saved.
    box.checked = !box.checked;
    window.alert(err.message || "Couldn't save that — try again.");
  } finally {
    box.disabled = false;
  }
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// The account's timezone and send hour are set in Settings, not here — a
// digest is built once per account per day, so per-person send times would
// mean different people quoting different "as of" dates for the same team.
// Showing the real value here makes that concrete instead of asking the
// reader to go and look.
async function showDigestTiming() {
  const note = el('digest-timing');
  if (!note) return;
  try {
    const s = await window.CM_Api.get('/tenant/settings');
    // Also the best signal for guessing the WhatsApp country code.
    window.CM_ACCOUNT_TIMEZONE = s.timezone || null;
    const hour = s.digestHour ?? 19;
    const suffix = hour < 12 ? 'am' : 'pm';
    const display = hour % 12 === 0 ? 12 : hour % 12;
    const where = (s.timezone || 'UTC').replace(/_/g, ' ');
    note.innerHTML = `Sent at <strong>${display}:00 ${suffix}</strong> in ${where}, once per day for the `
      + `whole account — so everyone sees the same figures for the same day.`
      + (s.canEdit ? ` <a href="settings.html" style="color:var(--brand)">Change it in Settings</a>.` : '');
  } catch (err) {
    console.error('Failed to load digest timing', err);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  prefs = await window.CM_Api.get('/me/notification-prefs');
  renderAll();
  wireDelivery();
  // Awaited: it resolves the account timezone, which is what the country-code
  // guess keys off. Without it the guess falls back to the browser's zone —
  // still reasonable, just less likely to match the business.
  await showDigestTiming();
  initCountryCodes();

  // --- WhatsApp connect ---
  const waOverlay = el('whatsapp-overlay');
  const waStepPhone = el('wa-step-phone');
  const waStepOtp = el('wa-step-otp');
  el('whatsapp-connect-btn').addEventListener('click', async () => {
    if (prefs.channels.whatsapp.connected) {
      prefs.channels.whatsapp = { connected: false, phone: null };
      prefs.anomaly.channels = prefs.anomaly.channels.filter(c => c !== 'whatsapp');
      prefs.digest.channels = prefs.digest.channels.filter(c => c !== 'whatsapp');
      await savePrefs();
      renderAll();
      return;
    }
    waStepPhone.style.display = 'block';
    waStepOtp.style.display = 'none';
    el('wa-phone-input').value = '';
    el('wa-phone-error').classList.remove('show');
    waOverlay.classList.add('show');
  });
  // --- Slack: installing it for the whole workspace ---
  const installNote = el('slack-install-note');
  const installText = el('slack-install-text');

  /** Writes a sentence into the install line and stops render() resetting it. */
  function sayInstall(text, good) {
    if (!installNote) return;
    installNote.dataset.claimed = '1';
    installNote.hidden = false;
    installNote.classList.toggle('is-good', !!good);
    installText.textContent = text;
  }

  /*
   * Coming back from Slack's consent screen.
   *
   * The callback redirects here with ?slack=… — without this the person lands
   * on an unchanged page with no idea whether the install worked. The
   * parameter is cleared afterwards so a refresh does not keep re-announcing
   * an install from ten minutes ago.
   */
  const outcome = new URLSearchParams(window.location.search).get('slack');
  const returned = slackReturnMessage(outcome);
  if (returned) {
    sayInstall(returned.text, returned.good);
    // Only the Install button is role-gated; the message is for whoever
    // Slack just sent back, whatever their role.
    el('slack-install-btn').hidden = !canInstallSlack() || returned.good;
    const url = new URL(window.location.href);
    url.searchParams.delete('slack');
    window.history.replaceState({}, '', url);
  }

  el('slack-install-btn')?.addEventListener('click', async () => {
    const btn = el('slack-install-btn');
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Opening Slack…';
    try {
      const res = await window.CM_Api.post('/slack/oauth/start', {});
      // A full navigation, not a popup: Slack's consent screen is its own page
      // and the callback brings the person back here.
      window.location.href = res.url;
    } catch (err) {
      sayInstall(err.message || 'Could not start the Slack install.', false);
      btn.textContent = was;
      btn.disabled = false;
    }
  });

  // --- Slack connect ---
  //
  // No dialog, unlike WhatsApp: there is no code to verify. The workspace has
  // already installed CloudMeter, and the server asks Slack to match this
  // person's own verified email to an account in it.
  el('slack-connect-btn').addEventListener('click', async () => {
    const btn = el('slack-connect-btn');
    const status = el('slack-status');
    const connected = !!prefs.channels?.slack?.connected;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = connected ? 'Disconnecting…' : 'Connecting…';
    try {
      const res = await window.CM_Api.post('/notifications/slack/connect', { connected: !connected });
      prefs.channels.slack = res.connected
        ? { connected: true, slackUserId: res.slackUserId }
        : { connected: false };
      /*
       * Mirrors what the server just did, rather than re-fetching.
       *
       * Connecting ticks the digest server-side — someone who clicked Connect
       * Slack does not expect to hunt for a second switch — and disconnecting
       * unticks both groups, because a tick on a channel that is gone looks
       * covered and is not.
       */
      if (res.connected) {
        if (!prefs.digest.channels.includes('slack')) prefs.digest.channels.push('slack');
        prefs.digest.enabled = true;
      } else {
        prefs.anomaly.channels = prefs.anomaly.channels.filter(c => c !== 'slack');
        prefs.digest.channels = prefs.digest.channels.filter(c => c !== 'slack');
      }
      renderAll();
    } catch (err) {
      /*
       * Said on the row rather than in an alert box.
       *
       * The two failures worth distinguishing are "nobody has installed
       * CloudMeter in your Slack yet" and "no Slack account uses your email",
       * and the server words both. Showing them here keeps the explanation
       * next to the thing that failed.
       */
      status.textContent = err.message || 'Could not connect Slack.';
      status.classList.remove('connected');
      /*
       * Nobody has installed CloudMeter in this workspace's Slack yet.
       *
       * An Owner or Admin can fix it here and now, so they are shown the
       * install line. Anyone else is told who to ask — a 409 with no route
       * forward reads as a broken button.
       */
      if (/install/i.test(err.message || '')) {
        sayInstall(canInstallSlack()
          ? 'Slack is not set up for this workspace yet.'
          : 'Slack is not set up for this workspace yet — ask an Owner or Admin to install it.', false);
        el('slack-install-btn').hidden = !canInstallSlack();
      }
      btn.textContent = was;
    } finally {
      btn.disabled = false;
    }
  });

  el('whatsapp-close').addEventListener('click', () => waOverlay.classList.remove('show'));
  waOverlay.addEventListener('click', e => { if (e.target === waOverlay) waOverlay.classList.remove('show'); });

  const waSendBtn = el('wa-send-code-btn');
  waSendBtn.addEventListener('click', async () => {
    const national = el('wa-phone-input').value.replace(/[^0-9]/g, '');
    // Seven digits is the shortest national number in real use; the country
    // code is chosen from a list, so it can't be wrong.
    if (national.length < 7) {
      el('wa-phone-error').textContent = 'Enter a valid phone number.';
      el('wa-phone-error').classList.add('show');
      return;
    }
    const phone = fullNumber();
    waSendBtn.disabled = true;
    waSendBtn.textContent = 'Sending…';
    try {
      await window.CM_Api.post('/notifications/whatsapp/start', { phone });
      el('wa-phone-target').textContent = phone;
      waStepPhone.style.display = 'none';
      waStepOtp.style.display = 'block';
      document.querySelectorAll('#wa-step-otp .otp-box').forEach(b => (b.value = ''));
      document.querySelector('#wa-step-otp .otp-box').focus();
    } catch (err) {
      // WhatsApp's own reasons are actionable — "not a WhatsApp number",
      // "template not approved" — so show them rather than a generic failure.
      el('wa-phone-error').textContent = err.message;
      el('wa-phone-error').classList.add('show');
    }
    waSendBtn.disabled = false;
    waSendBtn.textContent = 'Send code';
  });

  const waBoxes = Array.from(document.querySelectorAll('#wa-step-otp .otp-box'));
  waBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      el('wa-otp-error').classList.remove('show');
      if (box.value && i < waBoxes.length - 1) waBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) waBoxes[i - 1].focus();
    });
  });

  el('wa-verify-btn').addEventListener('click', async () => {
    const code = waBoxes.map(b => b.value).join('');
    if (code.length !== 6) {
      el('wa-otp-error').textContent = 'Enter all 6 digits.';
      el('wa-otp-error').classList.add('show');
      return;
    }
    try {
      // The server records the verified number itself, so the client never
      // decides which number got confirmed — a tampered request can't
      // subscribe a number that never received a code.
      const res = await window.CM_Api.post('/notifications/whatsapp/verify', { code });
      prefs.channels.whatsapp = { connected: true, phone: res.phone };

      // Connecting a number is the only WhatsApp control on this page, so
      // people read it as "send me WhatsApp" — but delivery also needs the
      // channel listed in digest.channels/anomaly.channels, and nothing here
      // ever added it. The result was a verified number that received nothing:
      // 11 of 16 verified users were in that state. Mirrors the disconnect
      // handler above, which strips WhatsApp from these same two lists.
      for (const group of ['digest', 'anomaly']) {
        // Create the group rather than skipping it. `continue` here meant a
        // record with no stored anomaly block came out of verification with
        // WhatsApp on the digest and nothing on alerts — the exact split found
        // across nine production users.
        if (!prefs[group]) prefs[group] = { channels: ['email'] };
        const list = Array.isArray(prefs[group].channels) ? prefs[group].channels : ['email'];
        if (!list.includes('whatsapp')) list.push('whatsapp');
        prefs[group].channels = list;
      }

      // The verify endpoint writes channels.whatsapp server-side but never
      // touches digest/anomaly, so this has to be saved explicitly or the tick
      // lives only in this tab. Kept out of the outer try: verification has
      // already succeeded by now, and a failed save must not surface as "that
      // code didn't match" — the number stays connected either way.
      try {
        await savePrefs();
      } catch (saveErr) {
        console.error('WhatsApp verified, but saving channel preferences failed', saveErr);
      }

      waOverlay.classList.remove('show');
      renderAll();
    } catch (err) {
      el('wa-otp-error').textContent = err.message;
      el('wa-otp-error').classList.add('show');
      waBoxes.forEach(b => (b.value = ''));
      waBoxes[0].focus();
    }
  });

});
