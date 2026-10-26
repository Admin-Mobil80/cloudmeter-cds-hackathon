/**
 * The daily digest, as Slack renders it.
 *
 * Slack sits between the two senders CloudMeter already has. The email can
 * afford tables and a full mover list; WhatsApp gets about two seconds on a
 * lock screen and no layout at all. Slack is read in a scroll of other
 * messages, so it carries the same figures as the email but in the shape
 * WhatsApp uses — the day, the month, and the one thing that moved — with the
 * detail a click away rather than inline.
 *
 * Every figure comes off the shared Digest, so the email, the WhatsApp and the
 * Slack post describing one day cannot disagree with each other.
 */

import { Digest, money } from './digest';
import { postMessage, tokenForTenant, SlackError } from './slack';
import { onProductionData } from './email-redirect';

/**
 * Marks a message as dev's, so it cannot be mistaken for the real thing.
 *
 * Dev and prod share one Slack app and post into the same conversation. A dev
 * digest for ACME has sat directly above a prod digest for Mobil80 with
 * nothing to tell them apart — readable only if you happen to remember which
 * workspaces exist where. Email solved this in September with a "[dev → …]"
 * subject prefix, after a dev message told a real person their subscription
 * had ended; Slack had no equivalent.
 *
 * Harmless while the only reader is us. It stops being harmless the moment a
 * customer connects and their dev workspace messages them.
 *
 * Keyed on the same TABLE_NAME test the email guard uses, deliberately: the
 * table is what the lambda is actually writing customers' data to, so it
 * cannot drift from reality the way a separate ENVIRONMENT flag could.
 */
export function devMark(text: string): string {
  return onProductionData() ? text : `[dev] ${text}`;
}

/**
 * The one-line summary Slack shows in a notification and a sidebar preview.
 *
 * Required on every post. A message with blocks but no text arrives on a phone
 * as a blank line, which is worse than no message at all.
 */
export function digestText(digest: Digest): string {
  return devMark(`${digest.tenantName} — ${money(digest.daySpend, digest.currency)} on ${digest.dayLabel}`);
}

/**
 * "up 12%" or "down 7%", or an honest admission that there is nothing to
 * compare. Phrased to slot into the same sentence WhatsApp uses, so the two
 * read identically: "(down 57% vs the same point last month)".
 */
export function monthTrend(digest: Digest): string {
  if (digest.monthDeltaPct === null) return 'no prior month to compare';
  const dir = digest.monthDeltaPct >= 0 ? 'up' : 'down';
  return `${dir} ${Math.abs(digest.monthDeltaPct).toFixed(0)}%`;
}

/** The biggest unusual move, worded exactly as the WhatsApp template does. */
export function biggestMover(digest: Digest): string {
  const top = digest.movers[0];
  if (!top) return 'nothing moved unusually';
  return `${top.service}, up ${money(top.delta, digest.currency)}`;
}

/**
 * Builds the Block Kit payload.
 *
 * Deliberately the same message WhatsApp sends, line for line — same wording,
 * same order, same figures. The first version was laid out natively for Slack,
 * with the day and the month side by side in a two-column field block and no
 * labels, and it read as thinner than the WhatsApp one even though it carried
 * the same numbers. Two channels describing one day should not feel like two
 * different reports.
 *
 * Two things are added that WhatsApp has no room for, and both only appear
 * when they apply: accounts that are failing to sync, and a note when the data
 * is further behind than the usual one day.
 */
export function digestBlocks(digest: Digest, portalUrl: string): unknown[] {
  const base = portalUrl.replace(/\/$/, '');
  const dashboard = `${base}/dashboard.html`;

  const lines = [
    `Spend on ${digest.dayLabel}: *${money(digest.daySpend, digest.currency)}*`,
    `Month to date: *${money(digest.monthToDate, digest.currency)}*`
      + ` (${monthTrend(digest)} vs the same point last month)`,
    `Biggest mover: ${biggestMover(digest)}`,
  ];

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: devMark(`CloudMeter daily summary for ${digest.tenantName}`),
        emoji: false,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];

  /*
   * Accounts whose sync is failing, named rather than counted.
   *
   * Not in the WhatsApp template, which has no room for a variable-length
   * list. A digest that quietly omits a broken account reports a total that is
   * too low and looks entirely normal — the reader cannot spot it from the
   * figures, so where there is room it is worth saying.
   */
  if (digest.stale.length) {
    const names = digest.stale.map((s) => s.name).join(', ');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Not syncing* — ${names}. These figures are missing their spend.`,
      },
    });
  }

  /*
   * How far behind the day being reported is.
   *
   * Providers report a day late, so a digest is normally about yesterday and
   * nobody needs telling. Beyond that it is worth saying, because a reader
   * seeing today's date on the message will otherwise assume today's numbers.
   */
  if (digest.daysBehind > 1) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Latest complete day available is ${digest.dayLabel}, ${digest.daysBehind} days back.`,
      }],
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `Full breakdown: <${dashboard}|open your dashboard>` },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Manage alerts in CloudMeter → Notifications' }],
  });

  return blocks;
}

/**
 * Sends one person their digest in Slack.
 *
 * The bot token belongs to the tenant, and `dmChannel` is the conversation
 * opened when that person connected — so this posts without a lookup per
 * message.
 *
 * A tenant whose Slack has gone away throws a recognisable error rather than a
 * generic one: the sweep sends to everyone in a `Promise.allSettled`, so this
 * ends up in a log line, and "their workspace uninstalled us" and "Slack is
 * having a bad minute" want different responses from whoever reads it.
 */
export async function sendDigestSlack(
  digest: Digest,
  tenantId: string,
  dmChannel: string,
  portalUrl: string,
): Promise<string> {
  const token = await tokenForTenant(tenantId);
  // Reached when a workspace's token was removed while someone still had the
  // channel ticked. Worth saying plainly; the sweep's email still goes.
  if (!token) throw new SlackError('not_connected', `Tenant ${tenantId} has no Slack token`);

  const { ts } = await postMessage(token, dmChannel, digestText(digest), digestBlocks(digest, portalUrl));
  return ts;
}
