// CloudMeter — dynamic trial countdown, driven by the real trial end date once
// GET /me resolves (falls back to a demo baseline until then).
(function () {
  /**
   * Assumed trial length, used only when the server hasn't told us the real
   * end date — the pre-/me demo baseline, and an account too old to carry one.
   *
   * It used to be the whole calculation: the end date was tenantCreatedAt plus
   * this constant, which is wrong for every trial that isn't seven days. A
   * one-day trial set in BMS still rendered a week, so an account that had
   * already lapsed was told it had days left.
   */
  const TRIAL_DAYS = 7;
  const DAY_MS = 86400000;

  /**
   * `trialEnd` is /me's periodEndsAt — currentPeriod() on the server, the same
   * clock the renewal reminder and BMS read. Passing it in is what keeps this
   * card, the renewal email and the staff console quoting one date.
   */
  function compute(trialStart, trialEnd) {
    const end = trialEnd ?? trialStart + TRIAL_DAYS * DAY_MS;
    // Round up, matching currentPeriod() on the server: "0 days left" should
    // mean today rather than some time in the last 24 hours.
    const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
    // A trial's real length, not an assumed one — at least 1, so a same-day
    // trial reads "Day 1 of 1" instead of dividing by zero.
    const days = Math.max(1, Math.round((end - trialStart) / DAY_MS));
    const daysElapsed = Math.max(0, Math.floor((Date.now() - trialStart) / DAY_MS));
    const dayOf = Math.min(daysElapsed + 1, days);
    const endDateStr = new Date(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const pct = Math.min(100, Math.round((daysElapsed / days) * 100));
    return { dayOf, daysLeft, endDateStr, pct, days };
  }

  function render(trial) {
    document.querySelectorAll('[data-trial="days-left"]').forEach(el => {
      el.textContent = trial.daysLeft === 1 ? '1 day left' : `${trial.daysLeft} days left`;
    });
    document.querySelectorAll('[data-trial="day-of"]').forEach(el => {
      el.textContent = `Day ${trial.dayOf} of ${trial.days}`;
    });
    document.querySelectorAll('[data-trial="end-date"]').forEach(el => {
      el.textContent = trial.endDateStr;
    });
    document.querySelectorAll('[data-trial="progress"]').forEach(el => {
      el.style.width = trial.pct + '%';
    });
  }

  // Demo baseline (mid-way through trial) until the real tenantCreatedAt loads.
  window.CM_TRIAL = compute(Date.now() - 3 * DAY_MS);

  document.addEventListener('DOMContentLoaded', () => render(window.CM_TRIAL));

  /**
   * A lapsed account is not "on trial with N days left".
   *
   * The countdown is derived from the account's creation date, so for an
   * expired tenant it happily counted forward past the end and contradicted
   * the banner directly above it — "2 days left" beside "this subscription
   * has expired". What matters once it has lapsed is the single fact of when,
   * so the card is replaced by that rather than corrected.
   *
   * The date comes from /me's periodEndsAt, which is currentPeriod() on the
   * server — the same clock the renewal sweep and BMS read, and the reason
   * this cannot drift from whichever of the trial or paid period governs.
   */
  function renderExpired(me) {
    const main = document.querySelector('.trial-card-main');
    if (!main) return false;

    const ends = me.periodEndsAt ? new Date(me.periodEndsAt) : null;
    const when = ends && !isNaN(ends)
      ? ends.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

    // Same split as sync-banner.js: someone who never held a subscription has
    // not had one expire, and this card sits on Billing directly below that
    // banner — wording them differently reads as two contradictory states.
    const failed = me.syncStatus === 'payment_failed';
    const headline = failed ? 'Payment failed' : me.planId ? 'Subscription expired' : 'Free trial ended';

    main.innerHTML = `
      <span class="trial-badge is-expired">${failed ? 'Payment failed' : me.planId ? 'Expired' : 'Trial ended'}</span>
      <div class="trial-days">${headline}</div>
      <div class="trial-sub">${when ? `on <strong>${when}</strong>` : 'Choose a plan to resume data refreshes.'}</div>`;
    return true;
  }

  document.addEventListener('cm-me-loaded', (e) => {
    // Checked before `entitled`, which is false for a lapsed trial too and
    // would otherwise fall through to the countdown below.
    if (e.detail.syncStatus && e.detail.syncStatus !== 'active') {
      renderExpired(e.detail);
      document.querySelectorAll('.trial-banner').forEach((el) => { el.hidden = true; });
      return;
    }

    // An account that already has a plan is not on trial. Without this the
    // banner tells a paying customer their data is about to stop flowing
    // unless they pick a plan they have already picked — true whether the
    // subscription came from Stripe or was set by hand in BMS.
    if (e.detail.entitled) {
      // .trial-banner (accounts/alerts/dashboard) ships hidden and is only
      // ever revealed below, so simply never reaching that line already
      // keeps it hidden for a paying customer. Billing's own .trial-card is
      // different: it renders visible by default with placeholder demo
      // numbers (see the DOMContentLoaded call above), so an entitled
      // customer who reaches this early return never got real numbers *or*
      // had it hidden — confirmed live, a customer who had just paid still
      // saw "Free trial — 4 days left" days after their trial was moot.
      document.querySelectorAll('.trial-card').forEach((el) => { el.hidden = true; });
      return;
    }

    // Choosing a plan is the Owner's decision and an Admin's concern. A Member
    // can't reach Billing at all, so nagging them to pick a plan is asking for
    // something they have no way to do.
    if (e.detail.role === 'member') return;

    if (!e.detail.tenantCreatedAt) return;
    const ends = e.detail.periodEndsAt ? new Date(e.detail.periodEndsAt).getTime() : null;
    window.CM_TRIAL = compute(
      new Date(e.detail.tenantCreatedAt).getTime(),
      Number.isFinite(ends) ? ends : null,
    );
    render(window.CM_TRIAL);
    // Revealed only now that the real trial state is known — the markup ships
    // hidden so a subscriber never sees "Free trial" flash before /me lands.
    document.querySelectorAll('.trial-banner').forEach(el => { el.hidden = false; });
  });
})();
