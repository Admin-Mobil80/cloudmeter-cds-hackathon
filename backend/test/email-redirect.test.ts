import { redirectNotification, isRedirecting } from '../functions/shared/email-redirect';

/**
 * Keeping dev's automated mail out of other people's inboxes.
 *
 * SES has production access on this account with no sandbox, so dev reaches
 * real addresses exactly as production does. On 2026-09-27 dev's renewal sweep
 * emailed a real person "your CloudMeter subscription has ended" — true of a
 * dev workspace whose plan had been typed into BMS and never bought, and
 * indistinguishable from a genuine billing email. He read it as his real
 * subscription lapsing.
 *
 * The first block below matters more than the rest: an environment that has
 * not configured a redirect must deliver to the address it was given, because
 * that environment is production and those are customers' billing emails.
 */

const ORIGINAL = process.env.NOTIFICATION_REDIRECT_TO;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NOTIFICATION_REDIRECT_TO;
  else process.env.NOTIFICATION_REDIRECT_TO = ORIGINAL;
});

describe('production, where nothing is configured', () => {
  it('delivers to the customer, untouched', () => {
    delete process.env.NOTIFICATION_REDIRECT_TO;
    const r = redirectNotification('customer@example.com', 'Your daily CloudMeter digest');

    expect(r.to).toBe('customer@example.com');
    expect(r.subject).toBe('Your daily CloudMeter digest');
    expect(r.redirected).toBe(false);
  });

  it('treats an empty or blank setting as not configured', () => {
    // A variable set to '' by a stack that passes a default, and one set to
    // whitespace by a careless edit, must both mean "send normally".
    for (const value of ['', '   ']) {
      process.env.NOTIFICATION_REDIRECT_TO = value;
      const r = redirectNotification('customer@example.com', 'Cost anomaly detected');
      expect(r.to).toBe('customer@example.com');
      expect(r.redirected).toBe(false);
    }
  });

  it('reports that it is not redirecting', () => {
    delete process.env.NOTIFICATION_REDIRECT_TO;
    expect(isRedirecting()).toBe(false);
  });
});

describe('dev, where a catch-all is configured', () => {
  beforeEach(() => { process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com'; });

  it('sends the customer nothing and the catch-all everything', () => {
    // The exact email that caused this.
    const r = redirectNotification('rohan@mobil80.com', 'Your CloudMeter subscription has ended');

    expect(r.to).toBe('neeta@mobil80.com');
    expect(r.redirected).toBe(true);
  });

  it('marks the subject so it cannot be mistaken for the real thing', () => {
    /*
     * The whole failure was that dev's mail looked genuine. A recipient must
     * be able to tell from the subject line alone, without opening it, that
     * this is dev's email about somebody else.
     */
    const r = redirectNotification('rohan@mobil80.com', 'Your CloudMeter subscription has ended');
    expect(r.subject).toBe('[dev → rohan@mobil80.com] Your CloudMeter subscription has ended');
  });

  it('names who it was for, so the log can say', () => {
    const r = redirectNotification('someone@customer.com', 'Cost anomaly detected');
    expect(r.intendedFor).toBe('someone@customer.com');
  });

  it('leaves mail already bound for the catch-all unmarked', () => {
    // It is going where it was always going; the prefix would be noise.
    const r = redirectNotification('neeta@mobil80.com', 'Your daily CloudMeter digest');
    expect(r.to).toBe('neeta@mobil80.com');
    expect(r.subject).toBe('Your daily CloudMeter digest');
    expect(r.redirected).toBe(false);
  });

  it('matches the catch-all regardless of case or padding', () => {
    // Addresses arrive from DynamoDB as people typed them.
    const r = redirectNotification('  Neeta@Mobil80.com ', 'Your daily CloudMeter digest');
    expect(r.redirected).toBe(false);
  });

  it('reports that it is redirecting', () => {
    expect(isRedirecting()).toBe(true);
  });
});

describe('the production safeguard', () => {
  /*
   * Configuration alone must not be able to divert customer mail.
   *
   * A redirect on production is silent and severe: renewal warnings, failed
   * payment notices and anomaly alerts stop arriving, nothing errors, and it
   * surfaces weeks later as "why was I never told". So the code refuses when
   * it is writing to production data, whatever it has been configured with.
   */
  const ORIGINAL_TABLE = process.env.TABLE_NAME;
  afterEach(() => {
    if (ORIGINAL_TABLE === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = ORIGINAL_TABLE;
  });

  it('refuses to redirect when the lambda writes to production data', () => {
    // The mistake being guarded against: somebody adds the dev address to the
    // production stack. It is ignored.
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    process.env.TABLE_NAME = 'cloudmeter_prod';

    const r = redirectNotification('rohan@mobil80.com', 'Your CloudMeter subscription renews in 3 days');
    expect(r.to).toBe('rohan@mobil80.com');
    expect(r.redirected).toBe(false);
    expect(r.subject).toBe('Your CloudMeter subscription renews in 3 days');
  });

  it('says so loudly, because prod is carrying a dev setting', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    process.env.TABLE_NAME = 'cloudmeter_prod';

    redirectNotification('rohan@mobil80.com', 'Cost anomaly detected');
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain('Refusing to redirect production email');
    spy.mockRestore();
  });

  it('reports that it is not redirecting, so callers agree with it', () => {
    // isRedirecting drives the log lines at the call sites; it must not claim
    // a redirect the send path is about to refuse.
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    process.env.TABLE_NAME = 'cloudmeter_prod';
    expect(isRedirecting()).toBe(false);
  });

  it('still redirects on dev, which is the whole point', () => {
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    process.env.TABLE_NAME = 'cloudmeter_dev';
    expect(redirectNotification('rohan@mobil80.com', 'x').redirected).toBe(true);
  });

  it('matches a hyphenated or capitalised production table too', () => {
    // The guard must not be defeated by a naming convention nobody told it
    // about; erring toward "this is production" is the safe direction.
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    for (const table of ['cloudmeter-prod', 'CloudMeter_PROD', ' cloudmeter_prod ']) {
      process.env.TABLE_NAME = table;
      expect(redirectNotification('rohan@mobil80.com', 'x').redirected).toBe(false);
    }
  });

  it('does not block a table that merely contains the word', () => {
    // "prod" inside a name is not a production table — a dev table called
    // cloudmeter_prodtest must still redirect, or dev silently stops being
    // protected.
    process.env.NOTIFICATION_REDIRECT_TO = 'neeta@mobil80.com';
    process.env.TABLE_NAME = 'cloudmeter_prodtest_dev';
    expect(redirectNotification('rohan@mobil80.com', 'x').redirected).toBe(true);
  });
});
