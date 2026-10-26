/**
 * How many alerts one run may push at a person, per channel.
 *
 * One misconfigured resource trips a dozen service-level anomalies at once.
 * The budgets exist so that a storm cannot bury a channel — and a buried
 * channel gets muted, which is worse than no channel because it looks like it
 * is working.
 *
 * The budget is deliberately per run and shared across recipients, not per
 * person: otherwise a storm is multiplied by the size of the team.
 */

import { newWhatsAppBudget, newSlackBudget } from '../functions/shared/alert-notify';

describe('alert budgets', () => {
  it('gives WhatsApp the tightest allowance', () => {
    // A phone buzzing in a pocket. Two is already a lot.
    expect(newWhatsAppBudget()).toEqual({ left: 2 });
  });

  it('gives Slack more headroom than WhatsApp', () => {
    /*
     * Milder failure mode: Slack is a feed someone scrolls rather than a phone
     * interrupting them, so the cap guards against a muted channel rather than
     * an annoyed person. It is still a cap — a dozen would bury the channel.
     */
    expect(newSlackBudget().left).toBeGreaterThan(newWhatsAppBudget().left);
    expect(newSlackBudget()).toEqual({ left: 5 });
  });

  it('hands out a fresh object each time, not a shared one', () => {
    /*
     * The budget is mutated as alerts are sent. A shared object would carry
     * one run's exhaustion into the next, and the second sweep of the day
     * would silently send nothing.
     */
    const a = newSlackBudget();
    const b = newSlackBudget();
    a.left -= 1;
    expect(b.left).toBe(5);

    const w1 = newWhatsAppBudget();
    w1.left -= 1;
    expect(newWhatsAppBudget().left).toBe(2);
  });

  it('keeps the two channels' + ' budgets independent', () => {
    // Spending Slack's allowance must not silence WhatsApp, or the reverse.
    const slack = newSlackBudget();
    const whatsapp = newWhatsAppBudget();
    slack.left = 0;
    expect(whatsapp.left).toBe(2);
  });
});
