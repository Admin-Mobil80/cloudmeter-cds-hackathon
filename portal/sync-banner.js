// CloudMeter — tells people why the numbers on screen have stopped moving.
//
// When a subscription lapses or a payment fails, the backend stops refreshing
// cost data but keeps everything else working: sign-in, history, alerts, the
// whole portal. Without this banner that reads as an account whose spend
// happens to have flatlined, which is the least helpful possible reading.
//
// Driven by `syncStatus` on GET /me, never by `entitled` — those two disagree
// exactly where it matters. A live trial has entitled:false, and a failed card
// has entitled:true; gating on it would tell every new signup their
// subscription had expired. See the field comment in shared/membership.ts.
//
// Injected rather than shipped as markup on each page, so it reaches every
// page auth-guard runs on — including account-detail, which carries the most
// specific numbers and is therefore the most misleading when frozen.
(function () {
  const COPY = {
    /**
     * A lapsed trial and a lapsed subscription both stop refreshes, but they
     * are fixed differently — one is chosen for the first time, the other
     * renewed. Branching on planId the way expiringCopy() below already does
     * is what stops a trial user who never held a subscription being told to
     * "Renew" one: this used to be a static object with cta:'Renew', so every
     * expired trial was sent to renew something that never existed.
     */
    expired: (me) => ({
      icon: '⏸',
      lead: me.planId
        ? 'Data refreshes are paused — this subscription has expired.'
        : 'Data refreshes are paused — your free trial has ended.',
      // Answers the one question this banner provokes — "have I lost my
      // history?" — and nothing else; the button already says how to fix it.
      rest: me.planId
        ? 'Your existing data is safe — refreshes resume as soon as you renew.'
        : 'Your existing data is safe — refreshes resume as soon as you choose a plan.',
      cta: me.planId ? 'Renew' : 'Choose a plan',
    }),
    payment_failed: () => ({
      icon: '⚠',
      // Only ever reached with a subscription behind it: the status comes from
      // a gateway, and a trial has no gateway to fail a payment.
      lead: 'Data refreshes are paused — the last payment failed.',
      rest: 'Your existing data is safe — refreshes resume once payment succeeds.',
      cta: 'Update payment method',
    }),
  };

  /**
   * Whole calendar days from today until the period ends.
   *
   * Deliberately counted between dates rather than from elapsed milliseconds.
   * A period ending at 18:00 today is nine hours away, and rounding that up
   * the way the server's daysLeft does would announce it as "tomorrow" — true
   * to the arithmetic and wrong to anyone reading a calendar. Comparing
   * midnights makes "today" mean today.
   */
  const DAY_MS = 86400000;
  function calendarDaysUntil(periodEndsAt) {
    if (!periodEndsAt) return null;
    const end = new Date(periodEndsAt);
    if (Number.isNaN(end.getTime())) return null;
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((midnight(end) - midnight(new Date())) / DAY_MS);
  }

  /** Warn from this many days out, inclusive. */
  const WARN_WITHIN_DAYS = 2;

  /**
   * The days before it lapses, in the same slot as the paused notice.
   *
   * Deliberately the same bar rather than a second one: a customer who is
   * about to lose refreshes and one who already has are at two points on the
   * same story, and moving the message would make the change easy to miss.
   * Only the tone and the verb differ.
   *
   * Read from periodEndsAt, which is currentPeriod() on the server — the same
   * date the Billing card and the renewal reminder quote, so the three cannot
   * drift apart.
   */
  function expiringCopy(me) {
    const left = calendarDaysUntil(me.periodEndsAt);
    if (left === null || left > WARN_WITHIN_DAYS || left < 0) return null;

    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    const on = new Date(me.periodEndsAt)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    // A trial and a paid period end the same way but are fixed differently —
    // one is chosen, the other renewed — so the wording follows planId rather
    // than assuming everyone has a subscription to renew.
    const paid = !!me.planId;

    return {
      icon: '⏳',
      lead: paid
        ? `This subscription expires ${when}, on ${on}.`
        : `Your free trial ends ${when}, on ${on}.`,
      rest: paid
        ? 'Renew to keep your cost data refreshing.'
        : 'Choose a plan to keep your cost data refreshing.',
      cta: paid ? 'Renew' : 'Choose a plan',
      variant: 'is-expiring',
    };
  }

  function render(me) {
    if (!me) return;
    // The lapsed states win: once refreshes have actually stopped, a countdown
    // to something that already happened is worse than no banner at all.
    const copy = COPY[me.syncStatus]?.(me) ?? (me.syncStatus === 'active' ? expiringCopy(me) : null);
    if (!copy) return;
    if (document.querySelector('.sync-banner')) return;

    // A Member cannot reach Billing at all, so they get the explanation
    // without a button that would 404 them into someone else's job.
    const canFix = me.role === 'owner' || me.role === 'admin';

    const el = document.createElement('div');
    el.className = `sync-banner${copy.variant ? ` ${copy.variant}` : ''}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `
      <div class="sync-banner-inner">
        <span class="sync-banner-ic" aria-hidden="true">${copy.icon}</span>
        <span class="sync-banner-text"><strong>${copy.lead}</strong> ${copy.rest}</span>
        ${canFix ? `<a href="billing.html" class="btn btn-sm btn-primary">${copy.cta}</a>` : ''}
      </div>`;

    // Above the page content, below the header — the same slot the trial
    // banner occupies, so the two can never overlap or fight for the top.
    const main = document.querySelector('main.content');
    if (main && main.parentNode) main.parentNode.insertBefore(el, main);
    else document.body.insertBefore(el, document.body.firstChild);

    // A frozen account is not on trial, and two stacked banners about billing
    // read as noise. This one is the more urgent of the two.
    document.querySelectorAll('.trial-banner').forEach((t) => { t.hidden = true; });
  }

  // CM_ME is set before cm-me-loaded fires, so a late-loading script still
  // renders; the event covers the ordinary case where /me is still in flight.
  if (window.CM_ME) render(window.CM_ME);
  document.addEventListener('cm-me-loaded', (e) => render(e.detail));
})();
