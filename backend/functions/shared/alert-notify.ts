import { QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddb, TABLE_NAME } from './ddb';
import { Anomaly, anomalyRootCause, anomalyAction, impactPhrase } from './anomaly';
import { sendTemplate } from './whatsapp';
import { postMessage, tokenForTenant } from './slack';
import { slackDmChannel } from './slack-prefs';
import { devMark } from './digest-slack';
import { SlackError } from './slack';
import { withSlackBroken } from './slack-prefs';
import {
  allowedChannels, gateChannels, type Channel, type ChannelPlanInput,
} from './plan-channels';

/**
 * Turns off a Slack connection that a send proved dead.
 *
 * Its own function because both the digest sweep and this file need it and
 * the write must not take the caller down with it: failing to record a dead
 * install is worth a log line, not a failed alert run.
 */
async function markSlackDead(tenantId: string, userId: string, reason: string): Promise<void> {
  try {
    const { Item: prefs } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
    }));
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'NOTIFPREFS' },
      UpdateExpression: 'SET channels = :c, updatedAt = :now',
      ExpressionAttributeValues: {
        ':c': withSlackBroken(prefs?.channels as Record<string, unknown>, tenantId, reason),
        ':now': new Date().toISOString(),
      },
    }));
    console.error(`Slack marked not-connected for user ${userId} in tenant ${tenantId}: ${reason}`);
  } catch (err) {
    console.error('Could not mark Slack as broken', (err as Error).message);
  }
}
import { resolveDisplayCurrency, type DisplayCurrency } from './display-currency';
import { redirectNotification } from './email-redirect';

const ses = new SESClient({});
const TEMPLATE = process.env.WHATSAPP_ANOMALY_TEMPLATE ?? 'cloudmeter_cost_anomaly';
const LANGUAGE = process.env.WHATSAPP_ANOMALY_LANGUAGE ?? 'en';

/**
 * Most a single tenant may be WhatsApped about anomalies in one detection run.
 *
 * One misconfigured resource can trip a dozen service-level anomalies at once.
 * A phone that buzzes twelve times gets muted, and a muted channel is worse
 * than no channel — it looks like it's working. Email carries the full set;
 * WhatsApp carries only what's worth interrupting someone for.
 */
const MAX_WHATSAPP_PER_RUN = 2;

/**
 * The same idea for Slack, with more headroom.
 *
 * A dozen service-level anomalies from one misconfigured resource would bury a
 * channel too, so there is a cap. It is higher than WhatsApp's because the
 * failure is milder: Slack is a feed somebody scrolls, not a phone buzzing in
 * a pocket, and the thing being avoided is a muted channel rather than an
 * annoyed person.
 */
const MAX_SLACK_PER_RUN = 5;

interface AlertRecipient {
  email: string | null;
  whatsapp: string | null;
  /** The DM channel to post in, for someone who connected Slack. */
  slack: string | null;
  /** Who this is, so a dead Slack install can be marked against them. */
  userId: string;
  minSeverity: string;
  minImpact: number;
}

/**
 * Per-account switches anyone sets from Notifications, or the account's page.
 *
 * Absent means on: someone newly given an account should hear about it without
 * having to go and enable anything.
 *
 * These used to apply to Members alone, on the reasoning that Owners and
 * Admins manage notifications for the whole organisation. The page offered
 * them to everyone regardless, so an Owner could untick an account, watch the
 * setting save, see it still unticked on reload — and keep receiving every
 * alert from it. A switch that stores a preference nobody honours is worse
 * than no switch. One noisy account is a reason to mute it whatever the role.
 */
function accountNotificationsOn(
  prefs: Record<string, unknown> | undefined,
  accountId: string,
  kind: 'anomaly' | 'digest',
): boolean {
  const perAccount = (prefs?.accounts as Record<string, Record<string, { enabled?: boolean }>> | undefined);
  const entry = perAccount?.[accountId]?.[kind];
  return entry?.enabled !== false;
}

/**
 * The accounts an unrestricted reader still wants in their roll-up.
 *
 * Owners and Admins get one digest covering the organisation, so a muted
 * account has to be dropped from that figure rather than costing them the
 * digest outright — silencing one noisy account is not the same as asking
 * for silence. An empty result means every account is muted, which is the
 * one case where nothing should be sent.
 */
function unmutedAccounts(
  prefs: Record<string, unknown> | undefined,
  accountIds: string[],
  kind: 'anomaly' | 'digest',
): string[] {
  return accountIds.filter((id) => accountNotificationsOn(prefs, id, kind));
}

export { accountNotificationsOn, unmutedAccounts };

const SEVERITY_RANK: Record<string, number> = { warning: 1, serious: 2, critical: 3 };

function passesPreference(anomaly: Anomaly, r: AlertRecipient): boolean {
  const floor = r.minSeverity === 'critical' ? 3 : r.minSeverity === 'critical_serious' ? 2 : 1;
  if ((SEVERITY_RANK[anomaly.severity] ?? 1) < floor) return false;
  // A one-off charge has no projection, so the threshold is applied to the
  // money that actually moved. Skipping those entirely would silence exactly
  // the surprise charges people most want to hear about.
  return (anomaly.impact ?? anomaly.deltaPerDay) >= r.minImpact;
}

export interface NotifyResult {
  emailed: number;
  whatsapped: number;
  slacked: number;
  channels: string[];
  recipients: string[];
  /** Channels withheld because the workspace's plan does not include them. */
  planBlocked: number;
}

/**
 * Tells the team about a newly raised anomaly, honouring each person's own
 * severity and impact thresholds.
 */
export async function notifyAnomaly(
  tenantId: string,
  tenantName: string,
  anomaly: Anomaly,
  portalUrl: string,
  fromEmail: string,
  whatsappBudget: { left: number },
  slackBudget: { left: number } = newSlackBudget(),
): Promise<NotifyResult> {
  // Scoped to the anomaly's own account: an alert names a service, an account
  // and its spend, so it may only reach people who can already see that
  // account. Without this a Member mapped to one account heard about every
  // other one — the exact roll-up the dashboard withholds from them.
  /*
   * The tenant record, read once and used twice: for the display currency and
   * for the plan that decides which channels may be used.
   *
   * An unreadable record leaves `tenant` empty, which means no plan id, which
   * `allowedChannels` deliberately treats as "allow everything". A failure to
   * look up a subscription must not be able to suppress a cost alert.
   */
  let tenant: Record<string, unknown> = {};
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantId}`, SK: `TENANT#${tenantId}` },
    }));
    tenant = Item ?? {};
  } catch (err) {
    console.error(
      `Tenant ${tenantId} unreadable; quoting USD and applying no plan limit`, err,
    );
  }

  // Every stored figure is USD; without this an alert quotes dollars to a
  // tenant whose dashboard and digest both show rupees. A failure here must not
  // suppress the alert itself — the numbers stay true, only the label differs.
  let currency: DisplayCurrency | undefined;
  try {
    currency = await resolveDisplayCurrency(tenant);
  } catch (err) {
    console.error(`Display currency unresolved for tenant ${tenantId}; quoting USD`, err);
  }

  const result: NotifyResult = {
    emailed: 0, whatsapped: 0, slacked: 0, channels: [], recipients: [], planBlocked: 0,
  };

  const recipients = await alertRecipients(
    tenantId, anomaly.accountId, allowedChannels(tenant as ChannelPlanInput), tenantName, result,
  );

  for (const r of recipients) {
    if (!passesPreference(anomaly, r)) continue;

    if (r.email) {
      try {
        await sendAnomalyEmail(anomaly, tenantName, r.email, portalUrl, fromEmail, currency);
        result.emailed += 1;
        result.recipients.push(r.email);
      } catch (err) {
        console.error(`Anomaly email to ${r.email} failed`, (err as Error).message);
      }
    }

    // Budget is shared across every anomaly in this run, not per person, so a
    // storm of alerts can't be multiplied by the size of the team.
    if (r.whatsapp && whatsappBudget.left > 0) {
      try {
        await sendAnomalyWhatsApp(anomaly, tenantName, r.whatsapp, currency);
        whatsappBudget.left -= 1;
        result.whatsapped += 1;
        result.recipients.push(r.whatsapp);
      } catch (err) {
        console.error(`Anomaly WhatsApp to ${r.whatsapp} failed`, (err as Error).message);
      }
    }

    // Shared across the run for the same reason as WhatsApp's: a storm of
    // alerts must not be multiplied by the size of the team.
    if (r.slack && slackBudget.left > 0) {
      try {
        await sendAnomalySlack(anomaly, tenantId, tenantName, r.slack, portalUrl, currency);
        slackBudget.left -= 1;
        result.slacked += 1;
        result.recipients.push(r.slack);
      } catch (err) {
        console.error(`Anomaly Slack to ${r.slack} failed`, (err as Error).message);
        /*
         * The install is gone rather than having a bad minute.
         *
         * Marked not-connected so the person's Notifications page says so and
         * offers a Connect button. Without this the alert fails into this log
         * line alone, the page keeps claiming Slack works, and every later
         * alert fails the same silent way.
         *
         * Only for failures a person must fix; a rate limit or an outage
         * retries and must never disconnect anybody.
         */
        if (err instanceof SlackError && err.needsReconnect) {
          await markSlackDead(tenantId, r.userId, err.code);
        }
      }
    }
  }

  if (result.emailed > 0) result.channels.push('email');
  if (result.whatsapped > 0) result.channels.push('whatsapp');
  if (result.slacked > 0) result.channels.push('slack');
  return result;
}

export function newWhatsAppBudget(): { left: number } {
  return { left: MAX_WHATSAPP_PER_RUN };
}

export function newSlackBudget(): { left: number } {
  return { left: MAX_SLACK_PER_RUN };
}

/**
 * "Mobil80 OpenAI · Rehearse RevenueCat" — the project beside the account
 * wherever the account is named. It is the first thing anyone asks and the
 * one thing the account alone cannot answer.
 *
 * One helper for every channel, so the email cannot say more than the
 * WhatsApp message about the same spike. The WhatsApp template has a fixed
 * slot for the account; this is what goes in it, and it stays a single line
 * with no characters the template rules forbid.
 */
export function whereOf(anomaly: Anomaly): string {
  return anomaly.project
    ? `${anomaly.accountName} · ${anomaly.project.label}`
    : anomaly.accountName;
}

async function sendAnomalyWhatsApp(anomaly: Anomaly, tenantName: string, phone: string, currency?: DisplayCurrency): Promise<void> {
  const current = anomaly.isNew
    ? `newly running at ${money(anomaly.current, currency)}/day`
    : `running at ${money(anomaly.current, currency)}/day`;
  const baseline = anomaly.isNew ? 'nothing at all' : `${money(anomaly.baseline, currency)}/day`;

  await sendTemplate(phone, TEMPLATE, LANGUAGE, [
    {
      type: 'body',
      parameters: [
        tenantName,
        anomaly.service,
        whereOf(anomaly),
        current,
        baseline,
        anomaly.impact === null
          ? `${money(anomaly.current, currency)} one-off`
          : `${money(anomaly.impact, currency)} extra`,
      ].map((text) => ({ type: 'text', text })),
    },
  ]);
}

/**
 * A spike, in Slack.
 *
 * The same facts as the WhatsApp alert — what, where, now against before, and
 * what it costs — because two channels describing one spike should not differ
 * about it. Built from the raw figures with this file's own `money`, so the
 * currency matches the email and the WhatsApp message rather than being
 * resolved again here.
 *
 * Severity leads the message. Someone scrolling a channel decides in a glance
 * whether to stop, and "critical" earns that stop where the service name
 * alone does not.
 */
async function sendAnomalySlack(
  anomaly: Anomaly,
  tenantId: string,
  tenantName: string,
  dmChannel: string,
  portalUrl: string,
  currency?: DisplayCurrency,
): Promise<void> {
  const token = await tokenForTenant(tenantId);
  // The channel was ticked but the workspace's token is gone. The email still
  // went; this is worth a log line, not a thrown sweep.
  if (!token) throw new Error(`Tenant ${tenantId} has no Slack token`);

  const now = anomaly.isNew
    ? `newly running at *${money(anomaly.current, currency)}/day*`
    : `running at *${money(anomaly.current, currency)}/day*`;
  const before = anomaly.isNew ? 'nothing at all' : `${money(anomaly.baseline, currency)}/day`;
  const cost = anomaly.impact === null
    ? `${money(anomaly.current, currency)} one-off`
    : `${money(anomaly.impact, currency)} extra`;

  const severity = String(anomaly.severity ?? '').toLowerCase();
  const mark = severity === 'critical' ? ':rotating_light:' : ':warning:';
  const heading = `${mark} ${severity ? severity.toUpperCase() : 'COST'} — ${anomaly.service}`;

  const text = devMark(`${tenantName}: ${anomaly.service} ${anomaly.isNew ? 'started' : 'is up'}, ${cost}`);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${devMark(heading)}*\n${whereOf(anomaly)}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Now ${now}, against ${before}.\nImpact: *${cost}*.`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `<${portalUrl.replace(/\/$/, '')}/alerts.html|See it in CloudMeter> · ${tenantName}`,
      }],
    },
  ];

  await postMessage(token, dmChannel, text, blocks);
}

// Exported for one-off delivery checks (e.g. a new account's SES), which must
// reach one inbox and nothing else. notifyAnomaly fans out to every member on
// every channel, including Slack.
export async function sendAnomalyEmail(
  anomaly: Anomaly,
  tenantName: string,
  email: string,
  portalUrl: string,
  fromEmail: string,
  currency?: DisplayCurrency,
): Promise<void> {
  const where = whereOf(anomaly);

  const subject = `${tenantName}: ${anomaly.service} up ${money(anomaly.deltaPerDay, currency)}/day on ${where}`;

  const text = [
    `${anomaly.severity.toUpperCase()} — ${anomaly.service} on ${where}`,
    '',
    anomalyRootCause(anomaly),
    '',
    impactPhrase(anomaly),
    '',
    anomalyAction(anomaly),
    '',
    `${portalUrl}/alerts.html`,
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#0b0b0b">
    <div style="font-size:13px;color:#898781">CloudMeter · ${escapeHtml(tenantName)}</div>
    <div style="font-size:18px;font-weight:650;margin-top:2px">${escapeHtml(anomaly.service)} on ${escapeHtml(where)}</div>
    <div style="margin-top:18px;padding:16px 18px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:12px">
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div><div style="font-size:12px;color:#52514e">Now</div>
          <div style="font-size:20px;font-weight:650">${money(anomaly.current, currency)}<span style="font-size:12px;color:#898781">/day</span></div></div>
        <div><div style="font-size:12px;color:#52514e">Normal</div>
          <div style="font-size:20px;font-weight:650">${money(anomaly.baseline, currency)}<span style="font-size:12px;color:#898781">/day</span></div></div>
        <div><div style="font-size:12px;color:#52514e">${anomaly.impact === null ? 'Charged' : 'Impact this month'}</div>
          <div style="font-size:20px;font-weight:650;color:#d03b3b">${money(anomaly.impact ?? anomaly.current, currency)}</div>
          ${anomaly.impact === null ? '<div style="font-size:11px;color:#898781">one-off — not projected</div>' : ''}</div>
      </div>
    </div>
    <p style="font-size:13.5px;color:#52514e;margin-top:18px">${escapeHtml(anomalyRootCause(anomaly))}</p>
    <p style="font-size:13.5px;color:#52514e">${escapeHtml(anomalyAction(anomaly))}</p>
    <p style="margin-top:22px">
      <a href="${portalUrl}/alerts.html" style="display:inline-block;background:#2a78d6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:13.5px">Review in CloudMeter</a>
    </p>
    <p style="font-size:12px;color:#898781;margin-top:18px;border-top:1px solid #e1e0d9;padding-top:12px">
      Change which alerts reach you under
      <a href="${portalUrl}/notifications.html" style="color:#2a78d6">Notifications</a>.
    </p>
  </div>`;

  const route = redirectNotification(email, subject);
  if (route.redirected) {
    console.log('Anomaly alert redirected', { intendedFor: route.intendedFor, to: route.to });
  }

  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${fromEmail}>`,
    Destination: { ToAddresses: [route.to] },
    Message: { Subject: { Data: route.subject }, Body: { Text: { Data: text }, Html: { Data: html } } },
  }));
}

async function alertRecipients(
  tenantId: string,
  accountId: string,
  allowed: Set<Channel>,
  tenantName: string,
  result: NotifyResult,
): Promise<AlertRecipient[]> {
  const { Items: members } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MEMBER#' },
  }));

  const out = await Promise.all((members ?? []).map(async (m): Promise<AlertRecipient | null> => {
    const email = m.email as string | undefined;
    if (!email || m.status !== 'active') return null;

    // Members see only the accounts they are mapped to.
    if (m.role === 'member') {
      const mapped = Array.isArray(m.accountIds) ? (m.accountIds as string[]) : [];
      if (!mapped.includes(accountId)) return null;
    }

    const { Item: prefs } = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${m.userId}`, SK: 'NOTIFPREFS' },
    }));

    // Anyone can silence one account without silencing the rest.
    if (!accountNotificationsOn(prefs, accountId, 'anomaly')) return null;

    const anomaly = prefs?.anomaly as { severity?: string; threshold?: number; channels?: string[] } | undefined;
    const ticked = Array.isArray(anomaly?.channels) ? anomaly!.channels : ['email'];

    // The plan decides which of those may actually be used. Withheld channels
    // are logged against the person, since nothing else about this produces an
    // error: a channel they ticked just stops carrying alerts.
    const { kept: channels, blocked } = gateChannels(ticked, allowed);
    if (blocked.length) {
      result.planBlocked += blocked.length;
      console.warn(
        `Anomaly channels withheld by plan for ${email} in ${tenantName}: `
        + `${blocked.join(', ')}${channels.length === 0 ? ' — no channel left for this alert' : ''}`,
      );
    }

    const wa = (prefs?.channels as { whatsapp?: { connected?: boolean; phone?: string } } | undefined)?.whatsapp;
    // Per workspace: a DM channel belongs to one Slack and is meaningless in
    // another, and this person may be in several CloudMeter workspaces.
    const slackDm = slackDmChannel(prefs as Record<string, unknown> | undefined, tenantId);

    return {
      email: channels.includes('email') ? email : null,
      whatsapp: channels.includes('whatsapp') && wa?.connected && wa.phone ? wa.phone : null,
      slack: channels.includes('slack') ? slackDm : null,
      userId: m.userId as string,
      minSeverity: anomaly?.severity ?? 'critical_serious',
      minImpact: typeof anomaly?.threshold === 'number' ? anomaly.threshold : 10,
    };
  }));

  return out.filter((r): r is AlertRecipient => !!r && (!!r.email || !!r.whatsapp || !!r.slack));
}

/**
 * Alert amounts in the tenant's display currency.
 *
 * Separate from the digest's formatter because an alert keeps two decimals
 * below ten — a service moving $2.40 a day is the whole point of the alert and
 * rounding it to $2 loses that. Omitting the currency keeps dollars.
 */
function money(n: number, currency?: Pick<DisplayCurrency, 'symbol' | 'rate' | 'code'>): string {
  // See the digest formatter: an unusable rate drops the symbol too, rather
  // than labelling an unconverted dollar figure as rupees.
  const usable = currency && Number.isFinite(currency.rate) && currency.rate > 0 ? currency : undefined;
  const symbol = usable?.symbol ?? '$';
  const locale = usable?.code === 'INR' ? 'en-IN' : 'en-US';
  const v = n * (usable?.rate ?? 1);
  return `${symbol}${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString(locale)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
