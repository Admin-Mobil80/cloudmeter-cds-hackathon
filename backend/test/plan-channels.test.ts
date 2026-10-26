/**
 * Enforcing a limit that was advertised for months and never applied.
 *
 * `Plan.channels` sat in the catalogue unused: Starter's card said "Email
 * only" while the digest sweep sent WhatsApp to everyone who had connected a
 * number. Switching it on is not a neutral act — on prod it would have taken
 * WhatsApp off 54 people overnight, our own team included, so these tests are
 * mostly about who must *not* lose anything.
 */

import {
  allowedChannels, gateChannels, grandfathered, cheapestPlanWith, channelUpgrades,
} from '../functions/shared/plan-channels';

describe('what a plan allows', () => {
  it('holds Starter to email', () => {
    const allowed = allowedChannels({ planId: 'starter' });
    expect([...allowed].sort()).toEqual(['email']);
  });

  it('gives Growth WhatsApp but not Slack', () => {
    // The distinction that matters right now: the dev workspaces were migrated
    // to Growth to save WhatsApp, which does nothing for Slack.
    const allowed = allowedChannels({ planId: 'growth' });
    expect(allowed.has('whatsapp')).toBe(true);
    expect(allowed.has('slack')).toBe(false);
  });

  it('gives Scale all three', () => {
    const allowed = allowedChannels({ planId: 'scale' });
    expect([...allowed].sort()).toEqual(['email', 'slack', 'whatsapp']);
  });
});

describe('a plan we cannot read', () => {
  /*
   * The deliberate fail-open. A missing or unrecognised planId is a gap in our
   * data, not a customer who downgraded — `QA Tester's workspace` on dev has
   * `planId: NULL` today. Failing closed would turn that into a silent
   * delivery outage that looked like working software.
   */
  it('allows everything when there is no plan id', () => {
    for (const tenant of [{}, { planId: null }, { planId: undefined }, { planId: '' }]) {
      expect([...allowedChannels(tenant)].sort()).toEqual(['email', 'slack', 'whatsapp']);
    }
  });

  it('allows everything for a plan id it does not recognise', () => {
    // A renamed or future tier must not silence the people on it.
    expect([...allowedChannels({ planId: 'enterprise' })].sort())
      .toEqual(['email', 'slack', 'whatsapp']);
  });

  it('survives no tenant at all', () => {
    expect([...allowedChannels(undefined)].sort()).toEqual(['email', 'slack', 'whatsapp']);
    expect([...allowedChannels(null)].sort()).toEqual(['email', 'slack', 'whatsapp']);
  });
});

describe('email is never taken away', () => {
  /*
   * Every plan includes email, so in principle this never bites. It is here
   * because the one thing a billing lookup must never be able to do is leave a
   * cost alert with nowhere to go.
   */
  it('is allowed even on the most restrictive plan', () => {
    expect(allowedChannels({ planId: 'starter' }).has('email')).toBe(true);
  });

  it('is kept when it is the only thing ticked', () => {
    const { kept, blocked } = gateChannels(['email'], allowedChannels({ planId: 'starter' }));
    expect(kept).toEqual(['email']);
    expect(blocked).toEqual([]);
  });
});

describe('grandfathering', () => {
  it('keeps a channel the plan does not include', () => {
    // ACME on dev: migrated to Growth, which has no Slack, but somebody is
    // connected and receiving. The plan says no; this says not retroactively.
    const allowed = allowedChannels({ planId: 'growth', grandfatheredChannels: ['slack'] });
    expect(allowed.has('slack')).toBe(true);
  });

  it('saves the 54 people on a Starter workspace', () => {
    const allowed = allowedChannels({ planId: 'starter', grandfatheredChannels: ['whatsapp'] });
    expect([...allowed].sort()).toEqual(['email', 'whatsapp']);
  });

  it('widens nothing on its own', () => {
    // Grandfathering Slack must not also hand them WhatsApp.
    const allowed = allowedChannels({ planId: 'starter', grandfatheredChannels: ['slack'] });
    expect(allowed.has('whatsapp')).toBe(false);
  });

  it('ignores junk rather than trusting a tenant record', () => {
    for (const raw of ['slack', 42, null, { slack: true }, undefined]) {
      expect(grandfathered({ planId: 'starter', grandfatheredChannels: raw })).toEqual([]);
    }
  });

  it('ignores unknown channel names inside the list', () => {
    expect(grandfathered({ grandfatheredChannels: ['slack', 'telegram', ''] })).toEqual(['slack']);
  });

  it('is case and whitespace tolerant', () => {
    // Written by hand in BMS, so " Slack" should not silently fail to apply.
    expect(grandfathered({ grandfatheredChannels: [' Slack', 'WHATSAPP'] }))
      .toEqual(['slack', 'whatsapp']);
  });
});

describe('gating what someone ticked', () => {
  it('keeps the permitted and reports the withheld', () => {
    const { kept, blocked } = gateChannels(
      ['email', 'whatsapp', 'slack'],
      allowedChannels({ planId: 'growth' }),
    );
    expect(kept).toEqual(['email', 'whatsapp']);
    expect(blocked).toEqual(['slack']);
  });

  it('reports a blocked channel rather than dropping it quietly', () => {
    /*
     * The whole reason `blocked` exists. The ACME user on dev has ticked
     * Slack and nothing else: gating leaves them with no channels at all, and
     * that must reach a log rather than simply resulting in no message.
     */
    const { kept, blocked } = gateChannels(['slack'], allowedChannels({ planId: 'growth' }));
    expect(kept).toEqual([]);
    expect(blocked).toEqual(['slack']);
  });

  it('withholds nothing when the plan covers everything', () => {
    const { kept, blocked } = gateChannels(
      ['email', 'whatsapp', 'slack'],
      allowedChannels({ planId: 'scale' }),
    );
    expect(kept).toEqual(['email', 'whatsapp', 'slack']);
    expect(blocked).toEqual([]);
  });

  it('collapses duplicates', () => {
    const { kept } = gateChannels(['email', 'email'], allowedChannels({ planId: 'starter' }));
    expect(kept).toEqual(['email']);
  });

  it('ignores a value that is not a channel', () => {
    // Neither delivered nor reported as withheld: no plan could have granted
    // it, so calling it "blocked by your plan" would be a lie.
    const { kept, blocked } = gateChannels(['email', 'pigeon'], allowedChannels({ planId: 'starter' }));
    expect(kept).toEqual(['email']);
    expect(blocked).toEqual([]);
  });

  it('handles nothing ticked', () => {
    expect(gateChannels(undefined, allowedChannels({ planId: 'growth' })))
      .toEqual({ kept: [], blocked: [] });
    expect(gateChannels([], allowedChannels({ planId: 'growth' })))
      .toEqual({ kept: [], blocked: [] });
  });
});

describe('naming the plan that would grant a channel', () => {
  /*
   * "Slack is included on the Scale plan" is a product fact with a price
   * attached, and it has to appear in a refusal message and on the
   * Notifications page. Derived from the catalogue in both places rather than
   * typed twice, so neither can end up recommending a tier that no longer
   * includes it.
   */
  it('names Scale for Slack', () => {
    expect(cheapestPlanWith('slack')?.name).toBe('Scale');
  });

  it('names the cheapest plan, not the first that happens to match', () => {
    // Growth and Scale both carry WhatsApp; telling someone to buy Scale for
    // it would be upselling them with wrong information.
    expect(cheapestPlanWith('whatsapp')?.name).toBe('Growth');
    expect(cheapestPlanWith('email')?.name).toBe('Starter');
  });

  it('describes only what is missing', () => {
    // On Growth, Slack is the one thing to explain; email and WhatsApp work.
    expect(channelUpgrades(allowedChannels({ planId: 'growth' }))).toEqual({ slack: 'Scale' });
  });

  it('says nothing when the plan covers everything', () => {
    expect(channelUpgrades(allowedChannels({ planId: 'scale' }))).toEqual({});
  });

  it('says nothing for a grandfathered channel', () => {
    // It works, so there is nothing to upgrade for — offering an upgrade here
    // would be selling something they already have.
    const allowed = allowedChannels({ planId: 'growth', grandfatheredChannels: ['slack'] });
    expect(channelUpgrades(allowed)).toEqual({});
  });

  it('explains both missing channels on Starter', () => {
    expect(channelUpgrades(allowedChannels({ planId: 'starter' })))
      .toEqual({ whatsapp: 'Growth', slack: 'Scale' });
  });

  it('says nothing when the plan is unreadable, since nothing is withheld', () => {
    expect(channelUpgrades(allowedChannels({ planId: null }))).toEqual({});
  });
});
