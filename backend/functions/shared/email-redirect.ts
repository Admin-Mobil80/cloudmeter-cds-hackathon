/**
 * Keeps dev's unprompted email out of other people's inboxes.
 *
 * SES has production access in this account with no sandbox, so anything any
 * environment sends reaches a real address. On 2026-09-27 dev's renewal sweep
 * emailed a real person "your CloudMeter subscription has ended" about a plan
 * that had been set by hand in BMS and never bought. The mail was correct
 * about dev and alarming about nothing.
 *
 * Scoped to the *automated* senders — the renewal sweep, the digest sweep and
 * anomaly alerts. Those fire on a schedule at whoever happens to be in a dev
 * workspace, which is the whole problem. Email that a person triggered by
 * clicking something in dev — an invite, a role change, a sign-in code — is
 * email they are waiting for, and redirecting it would quietly break testing
 * the flows it belongs to.
 *
 * Unset in production, where redirecting anything would be a serious bug: an
 * empty NOTIFICATION_REDIRECT_TO leaves every recipient exactly as given.
 */

/** Where dev's automated mail goes instead. Empty means "do not redirect". */
function configuredTarget(): string {
  return (process.env.NOTIFICATION_REDIRECT_TO ?? '').trim();
}

/**
 * Whether this lambda is operating on production data.
 *
 * Exported so the Slack sender can mark dev's messages with the same test
 * rather than keeping a second copy of it. Two copies of a safety check are
 * two things to keep in step, and the one that drifts is the one nobody is
 * watching.
 *
 * Read from TABLE_NAME rather than a flag of its own, deliberately. The table
 * is what the lambda is actually writing customers' data to, so it cannot
 * drift from reality: a lambda pointed at cloudmeter_prod *is* production,
 * whatever any other variable claims. A separate ENVIRONMENT flag could be
 * wrong while everything still appeared to work, which is the failure mode
 * this whole guard exists to prevent.
 */
export function onProductionData(): boolean {
  const table = (process.env.TABLE_NAME ?? '').trim().toLowerCase();
  return table.endsWith('_prod') || table.endsWith('-prod');
}

/**
 * The target, after refusing to divert production mail.
 *
 * A redirect on production is silent and severe: customers stop receiving
 * renewal warnings, failed-payment notices and anomaly alerts, nothing errors,
 * and it surfaces weeks later as "why was I never told". Configuration alone
 * should not be able to cause that, so the code refuses regardless of what it
 * is told.
 *
 * Logged at error level when it does refuse, because reaching this branch
 * means production is carrying a setting that was meant for dev — harmless
 * now, and worth someone finding out about today rather than the next time
 * somebody edits that file.
 */
function redirectTarget(): string {
  const target = configuredTarget();
  if (target && onProductionData()) {
    console.error(
      'Refusing to redirect production email. NOTIFICATION_REDIRECT_TO is set on a '
      + 'lambda writing to production data; customer mail is being delivered normally. '
      + 'Remove the setting from the production stack.',
      { table: process.env.TABLE_NAME },
    );
    return '';
  }
  return target;
}

export interface Redirected {
  /** The address to actually send to. */
  to: string;
  /**
   * Subject, prefixed when redirected so the recipient can tell at a glance
   * that it is dev's mail about somebody else. Without the marker these are
   * indistinguishable from the real thing, which is how one got reported as a
   * genuine expiry.
   */
  subject: string;
  /** True when this was rerouted, for the log line. */
  redirected: boolean;
  /** Who it would have gone to, for the log line. */
  intendedFor?: string;
}

export function redirectNotification(to: string, subject: string): Redirected {
  const target = redirectTarget();
  if (!target) return { to, subject, redirected: false };
  // Mail already addressed to the catch-all needs no marker: it is going where
  // it was always going, and the prefix would only be noise.
  if (to.trim().toLowerCase() === target.toLowerCase()) {
    return { to: target, subject, redirected: false };
  }
  return {
    to: target,
    subject: `[dev → ${to}] ${subject}`,
    redirected: true,
    intendedFor: to,
  };
}

/** True when this environment reroutes automated mail. */
export function isRedirecting(): boolean {
  return redirectTarget().length > 0;
}
