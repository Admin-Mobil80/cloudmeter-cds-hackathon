/**
 * Which notification channels a workspace's plan actually entitles it to.
 *
 * `Plan.channels` has existed in the catalogue since the plans were written
 * and has never been imported by any notification code: the marketing page
 * said "Email only" on Starter while the digest sweep cheerfully sent WhatsApp
 * to everybody. This is the file that makes the advertised limit the enforced
 * one.
 *
 * Enforcement here is a billing rule applied to people who did nothing wrong,
 * so two things are deliberate and neither is a detail.
 *
 * **Email is never gated.** Every plan includes it, so in principle the floor
 * never bites — but a plan id that is missing, misspelled or new would
 * otherwise reduce someone to no channels at all, and a billing lookup should
 * not be able to silence a cost alert. It is cheap insurance against the one
 * failure that nobody would notice.
 *
 * **An unreadable plan allows everything.** A tenant whose `planId` is absent
 * or unrecognised is a gap in our own data, not a customer who downgraded —
 * `QA Tester's workspace` on dev has `planId: NULL` today. Treating "we don't
 * know" as "they get nothing" would turn a data problem into a delivery
 * outage, and it would look exactly like working software. Same reasoning as
 * the BMS Slack column saying `unknown` rather than `—`, and the email
 * redirect refusing to divert production mail.
 *
 * Nothing here reads or writes: the callers own their data, and a rule this
 * consequential should be testable without a table.
 */

import { PLANS, planById, type Plan } from './plans';

export type Channel = 'email' | 'whatsapp' | 'slack';

const ALL: Channel[] = ['email', 'whatsapp', 'slack'];
const KNOWN = new Set<string>(ALL);

/** The channel every plan includes, and the one a lookup may never remove. */
export const FLOOR: Channel = 'email';

/** Just the tenant fields this decision needs. */
export interface ChannelPlanInput {
  planId?: string | null;
  /**
   * Channels this workspace keeps regardless of its plan.
   *
   * Enforcement arrived years after people connected, and on prod it would
   * have taken WhatsApp off 54 people overnight — our own team among them —
   * for a limit that had never once been applied. A plan change is a decision
   * somebody makes; this is how it stops being a thing that happens to them.
   *
   * Set per workspace rather than per person: the entitlement belongs to the
   * subscription, and a list of individuals would quietly rot as members come
   * and go.
   */
  grandfatheredChannels?: unknown;
}

/**
 * The channels this workspace may use.
 *
 * Returns a Set because every caller asks "is this one allowed?" rather than
 * wanting the list.
 */
export function allowedChannels(tenant: ChannelPlanInput | null | undefined): Set<Channel> {
  const plan = planById(tenant?.planId);

  // Unknown or missing plan: allow everything rather than silence them. See
  // the header — this is the deliberate fail-open.
  const base: Channel[] = plan ? plan.channels : ALL;

  const allowed = new Set<Channel>(base);
  allowed.add(FLOOR);
  for (const extra of grandfathered(tenant)) allowed.add(extra);
  return allowed;
}

/**
 * The stored grandfather list, ignoring anything that is not a channel we know.
 *
 * Validated rather than trusted: this is read straight off a tenant record
 * that BMS writes, and a typo should narrow nobody's delivery and widen
 * nothing either.
 */
export function grandfathered(tenant: ChannelPlanInput | null | undefined): Channel[] {
  const raw = tenant?.grandfatheredChannels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => String(c ?? '').trim().toLowerCase())
    .filter((c): c is Channel => KNOWN.has(c));
}

/**
 * The cheapest plan that includes this channel, or null if none does.
 *
 * So that "Slack is included on the Scale plan" is derived from the catalogue
 * rather than typed into a message and a page. A sentence naming a tier is a
 * product fact with a price attached; two hand-written copies of it is how the
 * app ends up telling somebody to buy the wrong thing.
 *
 * `PLANS` is ordered cheapest first, so the first match is the cheapest.
 */
export function cheapestPlanWith(channel: Channel): Plan | null {
  return PLANS.find((p) => p.channels.includes(channel)) ?? null;
}

/**
 * For each channel this workspace may not use, the plan that would grant it.
 *
 * Shaped for a page: `{ slack: 'Scale' }` is enough to grey a column and say
 * why. A channel no plan offers is left out rather than named with a blank,
 * since there is nothing to upgrade to.
 */
export function channelUpgrades(allowed: Set<Channel>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const channel of ALL) {
    if (allowed.has(channel)) continue;
    const plan = cheapestPlanWith(channel);
    if (plan) out[channel] = plan.name;
  }
  return out;
}

export interface Gated {
  /** The channels this person ticked that the plan permits. */
  kept: Channel[];
  /**
   * The channels the plan took away.
   *
   * Returned rather than discarded so a caller can count and log them. A
   * channel that vanishes with no trace is how the WhatsApp digest looked
   * connected for eleven people and delivered nothing for weeks.
   */
  blocked: Channel[];
}

/**
 * Splits what someone asked for into what they may have and what the plan
 * withheld.
 *
 * Order and duplicates in the stored preference are preserved and collapsed
 * respectively, so the result can be compared in a test without sorting.
 */
export function gateChannels(
  ticked: readonly string[] | undefined,
  allowed: Set<Channel>,
): Gated {
  const kept: Channel[] = [];
  const blocked: Channel[] = [];
  const seen = new Set<string>();

  for (const raw of ticked ?? []) {
    const c = String(raw ?? '').trim().toLowerCase();
    // Not a channel at all: neither delivered nor reported as withheld, since
    // no plan could have granted it.
    if (!KNOWN.has(c) || seen.has(c)) continue;
    seen.add(c);
    (allowed.has(c as Channel) ? kept : blocked).push(c as Channel);
  }

  return { kept, blocked };
}
