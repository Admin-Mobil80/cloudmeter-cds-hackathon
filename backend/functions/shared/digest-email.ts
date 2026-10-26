import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Digest, DigestService, money } from './digest';
import { redirectNotification } from './email-redirect';

const ses = new SESClient({});

export interface EmailTarget {
  email: string;
  /** Where "view the full breakdown" points — env-specific. */
  portalUrl: string;
  fromEmail: string;
}

/**
 * The subject line is the message for most readers — a phone shows it and
 * nothing else. So it leads with the two numbers that matter and names the day,
 * because the day we can report isn't always yesterday.
 */
export function digestSubject(d: Digest): string {
  const trend = d.monthDeltaPct === null
    ? ''
    : ` · MTD ${d.monthDeltaPct >= 0 ? 'up' : 'down'} ${Math.abs(d.monthDeltaPct).toFixed(0)}%`;
  return `${d.tenantName}: ${money(d.daySpend, d.currency)} on ${d.dayLabel}${trend}`;
}

export function digestText(d: Digest): string {
  const lines = [
    `CloudMeter daily summary for ${d.tenantName}`,
    '',
    `Spend on ${d.dayLabel}: ${money(d.daySpend, d.currency)}`,
    `Month to date: ${money(d.monthToDate, d.currency)}${monthComparison(d)}`,
    `Across ${d.accountCount} cloud account${d.accountCount === 1 ? '' : 's'}`,
  ];

  const byDay = topServices(d.services, 'day');
  if (byDay.shown.length) {
    lines.push('', `Top services on ${d.dayLabel}:`);
    byDay.shown.forEach((x) => lines.push(`  - ${x.service}: ${money(x.daySpend, d.currency)}`));
    if (byDay.rest) lines.push(`  - ${byDay.rest.count} other service${byDay.rest.count === 1 ? '' : 's'}: ${money(byDay.rest.daySpend, d.currency)}`);
  }
  const byMonth = topServices(d.services, 'month');
  if (byMonth.shown.length) {
    lines.push('', 'Top services this month:');
    byMonth.shown.forEach((x) => lines.push(`  - ${x.service}: ${money(x.monthToDate, d.currency)}`));
    if (byMonth.rest) lines.push(`  - ${byMonth.rest.count} other service${byMonth.rest.count === 1 ? '' : 's'}: ${money(byMonth.rest.monthToDate, d.currency)}`);
  }

  if (d.movers.length) {
    lines.push('', 'Notable movements:');
    d.movers.forEach((m) => {
      lines.push(`  - ${m.service} (${m.accountName}): ${money(m.spend, d.currency)}, `
        + `${money(m.delta, d.currency)} above its ${money(m.baseline, d.currency)} daily average`);
    });
  } else {
    lines.push('', 'No service moved materially against its recent average.');
  }

  if (d.stale.length) {
    lines.push('', 'Needs attention — CloudMeter can no longer read these accounts:');
    d.stale.forEach((s) => lines.push(`  - ${s.name} (${s.provider.toUpperCase()})`));
  }

  if (d.daysBehind > 1) {
    lines.push('', `Note: ${d.dayLabel} is the most recent day your providers have `
      + `finished reporting. Cost data arrives a day or so behind.`);
  }

  return lines.join('\n');
}

export function digestHtml(d: Digest, portalUrl: string): string {
  const moverRows = d.movers.length
    ? d.movers.map((m) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9">
          <div style="font-weight:600">${escapeHtml(m.service)}</div>
          <div style="font-size:12px;color:#898781">${escapeHtml(m.accountName)}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #e1e0d9;text-align:right;white-space:nowrap">
          <div style="font-weight:600">${money(m.spend, d.currency)}</div>
          <div style="font-size:12px;color:#d03b3b">+${money(m.delta, d.currency)} vs ${money(m.baseline, d.currency)} avg</div>
        </td>
      </tr>`).join('')
    : `<tr><td style="padding:8px 0;color:#898781;font-size:13px">
         No service moved materially against its recent average.
       </td></tr>`;

  const serviceBlock = serviceTable(d, 'day') + serviceTable(d, 'month');

  const staleBlock = d.stale.length ? `
    <div style="margin-top:20px;padding:12px 14px;background:#fdf2f2;border:1px solid rgba(208,59,59,0.25);border-radius:8px">
      <div style="font-weight:650;color:#d03b3b;font-size:13px">Needs attention</div>
      <div style="font-size:13px;color:#52514e;margin-top:4px">
        CloudMeter can no longer read cost data for
        ${d.stale.map((s) => escapeHtml(s.name)).join(', ')}.
        Reconnect ${d.stale.length === 1 ? 'it' : 'them'} to keep this summary accurate.
      </div>
    </div>` : '';

  const lagNote = d.daysBehind > 1 ? `
    <p style="font-size:12px;color:#898781;margin:18px 0 0">
      ${d.dayLabel} is the most recent day your providers have finished reporting —
      cost data arrives a day or so behind.
    </p>` : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#0b0b0b">
    <div style="font-size:13px;color:#898781">CloudMeter daily summary</div>
    <div style="font-size:18px;font-weight:650;margin-top:2px">${escapeHtml(d.tenantName)}</div>

    <div style="margin-top:20px;padding:16px 18px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:12px">
      <div style="font-size:13px;color:#52514e">Spend on ${d.dayLabel}</div>
      <div style="font-size:28px;font-weight:650;margin-top:2px">${money(d.daySpend, d.currency)}</div>
      <div style="font-size:13px;color:#52514e;margin-top:10px">
        Month to date <strong>${money(d.monthToDate, d.currency)}</strong>${monthComparisonHtml(d)}
      </div>
      <div style="font-size:12px;color:#898781;margin-top:4px">
        Across ${d.accountCount} cloud account${d.accountCount === 1 ? '' : 's'}
      </div>
    </div>

    ${serviceBlock}

    <div style="margin-top:22px;font-size:13px;font-weight:650">Notable movements</div>
    <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:13px">${moverRows}</table>

    ${staleBlock}

    <p style="margin-top:24px">
      <a href="${portalUrl}/dashboard.html"
         style="display:inline-block;background:#2a78d6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:13.5px">
        View the full breakdown
      </a>
    </p>
    ${lagNote}
    <p style="font-size:12px;color:#898781;margin-top:18px;border-top:1px solid #e1e0d9;padding-top:12px">
      You're receiving this because daily digests are on for your CloudMeter account.
      Change it under <a href="${portalUrl}/notifications.html" style="color:#2a78d6">Notifications</a>.
    </p>
  </div>`;
}

/** How many services each email table lists before folding the rest into one row. */
const SERVICES_SHOWN = 6;

type Period = 'day' | 'month';
const amount = (x: DigestService, p: Period) => (p === 'day' ? x.daySpend : x.monthToDate);

/**
 * The largest services for the reported day or for the month to date, with
 * everything after the limit summed into one row so each table still adds up
 * to the total above it. Two tables, because the two questions differ: what
 * did yesterday cost, and where is this month's money going — a large monthly
 * fee can be the month's biggest line and absent from yesterday entirely.
 */
export function topServices(services: DigestService[] = [], period: Period = 'day', limit = SERVICES_SHOWN): {
  shown: DigestService[];
  rest: { count: number; daySpend: number; monthToDate: number } | null;
} {
  const ranked = services.filter((x) => amount(x, period) > 0).sort((a, b) => amount(b, period) - amount(a, period));
  const shown = ranked.slice(0, limit);
  const others = ranked.slice(limit);
  return {
    shown,
    rest: others.length ? {
      count: others.length,
      daySpend: others.reduce((t, x) => t + x.daySpend, 0),
      monthToDate: others.reduce((t, x) => t + x.monthToDate, 0),
    } : null,
  };
}

function serviceTable(d: Digest, period: Period): string {
  const { shown, rest } = topServices(d.services, period);
  if (!shown.length) return '';
  const cell = 'padding:7px 0;border-bottom:1px solid #e1e0d9';
  const title = period === 'day' ? `Top services on ${d.dayLabel}` : 'Top services this month';
  const rows = shown.map((x) => `
      <tr>
        <td style="${cell}">${escapeHtml(x.service)}</td>
        <td style="${cell};text-align:right;white-space:nowrap;font-weight:600">${money(amount(x, period), d.currency)}</td>
      </tr>`).join('') + (rest ? `
      <tr>
        <td style="${cell};color:#898781">${rest.count} other service${rest.count === 1 ? '' : 's'}</td>
        <td style="${cell};text-align:right;white-space:nowrap;color:#898781">${money(period === 'day' ? rest.daySpend : rest.monthToDate, d.currency)}</td>
      </tr>` : '');
  return `
    <div style="margin-top:22px;font-size:13px;font-weight:650">${title}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:13px">${rows}
    </table>`;
}

function monthComparison(d: Digest): string {
  if (d.monthDeltaPct === null) return '';
  const dir = d.monthDeltaPct >= 0 ? 'up' : 'down';
  return ` (${dir} ${Math.abs(d.monthDeltaPct).toFixed(0)}% vs the same point last month)`;
}

function monthComparisonHtml(d: Digest): string {
  if (d.monthDeltaPct === null) return '';
  const up = d.monthDeltaPct >= 0;
  return ` <span style="color:${up ? '#d03b3b' : '#006300'}">`
    + `${up ? '▲' : '▼'} ${Math.abs(d.monthDeltaPct).toFixed(0)}%</span>`
    + ` <span style="color:#898781">vs same point last month</span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export async function sendDigestEmail(d: Digest, target: EmailTarget): Promise<void> {
  const route = redirectNotification(target.email, digestSubject(d));
  if (route.redirected) {
    console.log('Digest redirected', { intendedFor: route.intendedFor, to: route.to });
  }

  await ses.send(new SendEmailCommand({
    Source: `CloudMeter <${target.fromEmail}>`,
    Destination: { ToAddresses: [route.to] },
    Message: {
      Subject: { Data: route.subject },
      Body: {
        Text: { Data: digestText(d) },
        Html: { Data: digestHtml(d, target.portalUrl) },
      },
    },
  }));
}
