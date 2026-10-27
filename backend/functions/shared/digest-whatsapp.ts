import { Digest, money } from './digest';
import { serviceLabel } from './service-names';
import { sendTemplate } from './whatsapp';

const TEMPLATE = process.env.WHATSAPP_DIGEST_TEMPLATE ?? 'cloudmeter_daily_digest';
/**
 * The version of the digest template with a sixth body line,
 * "Top services that day: {{6}}". Used only once Meta has approved it and the
 * environment names it; until then the five-variable template above is sent,
 * unchanged, because a parameter count that doesn't match the approved
 * template fails the whole send (#132000).
 */
const TEMPLATE_WITH_SERVICES = (process.env.WHATSAPP_DIGEST_TEMPLATE_WITH_SERVICES ?? '').trim();
/**
 * Versions whose services line names the day — "Top services on {{6}}: {{7}}"
 * — and so take one more body value than v2's "Top services that day: {{6}}".
 */
const DATED_SERVICES_TEMPLATES = new Set(['cloudmeter_daily_digest_v3']);
/**
 * Versions with one service per line — "Top services on {{6}}:", then
 * "• {{7}}", "• {{8}}", "• {{9}}" and a closing "{{10}}" for the rest — because
 * a value itself may not contain a line break.
 */
const LISTED_SERVICES_TEMPLATES = new Set(['cloudmeter_daily_digest_v5']);
const LISTED_SERVICES = 3;
/** Services named on the WhatsApp line; the email carries the full table. */
const WHATSAPP_SERVICES = 5;
const LANGUAGE = process.env.WHATSAPP_DIGEST_LANGUAGE ?? 'en';

/**
 * WhatsApp has no room for the email's tables, and it is read on a lock screen
 * in about two seconds. Each value is therefore a complete phrase rather than a
 * bare number — the template's fixed text supplies almost no context, and
 * "up 12%" reads correctly where "12" would not.
 *
 * Every component's parameter list must match the APPROVED template exactly —
 * Meta rejects the whole send with (#132000) on any mismatch, which is how
 * every WhatsApp digest silently failed while the emails went out fine. The
 * approved template puts the organisation name in a TEXT header and the
 * figures in the body:
 *
 *   HEADER: CloudMeter daily summary for {{1}}
 *   BODY:   Spend on {{1}}: {{2}}
 *           Month to date: {{3}} ({{4}} vs the same point last month)
 *           Biggest mover: {{5}}
 *
 * The header is easy to overlook because it carries no figures, and omitting
 * it fails exactly like a wrong body count.
 */

/**
 * Longest organisation name the header will carry.
 *
 * Meta caps a rendered TEXT header at 60 characters, counting the template's
 * own text towards it. The header reads "CloudMeter daily summary for {{1}}",
 * which leaves 31 characters for the name.
 *
 * One digest hit that ceiling: on 2026-08-25 a send was rejected with
 * (#132005) "Length of the parameters and the template text is 65, which
 * exceeds the allowed length of 60". Sending the same 27-character name
 * through the same template afterwards was accepted and delivered, so the
 * overflow was not the name alone — the counted template text was about four
 * characters longer at the time, meaning the header wording has since been
 * shortened and re-approved. The exact former wording was not recovered.
 *
 * The guard therefore stays, but sized to the real ceiling rather than well
 * inside it: every current tenant name fits whole (the longest is 27), and
 * only a name that genuinely would not fit gets shortened. Editing the
 * template's header text later eats into this budget, so it is deliberately
 * left with a little slack.
 */
const MAX_HEADER_NAME = 30;

const LEGAL_SUFFIX = /[\s,]+(pvt\.?|private|ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|plc|gmbh|s\.?a\.?r\.?l\.?|b\.?v\.?|pty|co\.?)$/i;

export function headerName(name: string, max = MAX_HEADER_NAME): string {
  let out = (name ?? '').trim();

  // A name that already fits is left exactly as the tenant wrote it. Shortening
  // is a fallback for names that cannot be sent, not a house style.
  if (out.length <= max) return out;

  // Legal suffixes go first: "ACME" identifies the organisation to its own
  // staff as well as "ACME Technologies Pvt Ltd" does, and losing "Pvt Ltd"
  // reads far better than a name cut mid-word.
  //
  // Repeated because the suffixes stack: "Pvt Ltd", "Technologies Pvt Ltd".
  // Guarded so stripping can never empty the name — an organisation called
  // "Limited" keeps its name and gets truncated instead.
  for (let i = 0; i < 3; i += 1) {
    const stripped = out.replace(LEGAL_SUFFIX, '').trim();
    if (!stripped || stripped === out) break;
    out = stripped;
  }

  if (out.length <= max) return out;
  // Cut on a word boundary when there is a reasonable one, so the result reads
  // as a name rather than a fragment.
  const cut = out.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
/**
 * "Amazon EC2 ₹1,200 · Amazon S3 ₹800 · …" for the day being reported.
 *
 * One line, because WhatsApp rejects a template parameter containing a new
 * line or a tab. Services with no cost that day are left out; if none had
 * any, it says so rather than sending an empty line.
 *
 * Each row is labelled with its provider and a short name (see serviceLabel),
 * and rows that end up with the same label are added together before ranking:
 * one OpenAI model billed as six usage types is one service here, not six.
 */
export function servicesLine(digest: Digest, limit = WHATSAPP_SERVICES): string {
  const day = rankedServices(digest);
  if (day.length === 0) return 'no service cost reported that day';
  const parts = day.slice(0, limit).map((x) => `${x.service} ${money(x.daySpend, digest.currency)}`);
  const more = day.length - limit;
  return more > 0 ? `${parts.join(' · ')} · +${more} more` : parts.join(' · ');
}

/** The day's services, labelled, merged by label and ranked by cost. */
function rankedServices(digest: Digest): Array<{ service: string; daySpend: number }> {
  const byName = new Map<string, number>();
  for (const x of digest.services ?? []) {
    if (x.daySpend <= 0) continue;
    const name = serviceLabel(x.provider, x.service);
    byName.set(name, (byName.get(name) ?? 0) + x.daySpend);
  }
  return Array.from(byName, ([service, daySpend]) => ({ service, daySpend }))
    .sort((a, b) => b.daySpend - a.daySpend);
}

/**
 * The values for v5's service lines: one per listed service ("—" for an
 * empty slot, since a template value may not be blank), then the rest.
 */
export function listedServiceValues(digest: Digest, slots = LISTED_SERVICES): string[] {
  const day = rankedServices(digest);
  const lines = Array.from({ length: slots }, (_, i) => (day[i]
    ? `${day[i].service} ${serviceMoney(day[i].daySpend, digest.currency)}`
    : '—'));
  const more = day.length - slots;
  if (day.length === 0) return [...lines, 'No service cost reported that day'];
  return [...lines, more > 0 ? `+${more} more in the dashboard` : 'No other services'];
}

/**
 * A service's cost, with cents below 10 of the display currency. Whole units
 * made every small service read "$1", which says nothing about which costs
 * more; the day's totals keep whole units.
 */
export function serviceMoney(n: number, currency?: Digest['currency']): string {
  const usable = currency && Number.isFinite(currency.rate) && currency.rate > 0 ? currency : undefined;
  const converted = n * (usable?.rate ?? 1);
  if (converted >= 10) return money(n, currency);
  const symbol = usable?.symbol ?? '$';
  if (converted < 0.01) return `under ${symbol}0.01`;
  const locale = usable?.code === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${converted.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function sendDigestWhatsApp(digest: Digest, phone: string): Promise<string> {
  const template = TEMPLATE_WITH_SERVICES || TEMPLATE;
  const { messageId } = await sendTemplate(phone, template, LANGUAGE, [
    {
      type: 'header',
      parameters: [{ type: 'text', text: headerName(digest.tenantName) }],
    },
    {
      type: 'body',
      parameters: digestBodyValues(digest, template).map((text) => ({ type: 'text', text })),
    },
  ]);

  return messageId;
}

/**
 * The body values, in order, for whichever digest template is being sent.
 * The count must match that template exactly: five for the original, six for
 * v2 (services), seven for v3 (the day, then services), ten for v5 (the day,
 * three service lines, then the rest).
 */
export function digestBodyValues(digest: Digest, template: string): string[] {
  const monthTrend = digest.monthDeltaPct === null
    ? 'no prior month to compare'
    : `${digest.monthDeltaPct >= 0 ? 'up' : 'down'} ${Math.abs(digest.monthDeltaPct).toFixed(0)}%`;

  const top = digest.movers[0];
  const biggestMover = top
    ? `${serviceLabel(top.provider, top.service)}, up ${money(top.delta, digest.currency)}`
    : 'nothing moved unusually';

  const values = [
    digest.dayLabel,
    money(digest.daySpend, digest.currency),
    money(digest.monthToDate, digest.currency),
    monthTrend,
    biggestMover,
  ];
  if (template === TEMPLATE) return values;
  if (LISTED_SERVICES_TEMPLATES.has(template)) {
    return [...values, shortDay(digest.dayKey), ...listedServiceValues(digest)];
  }
  if (DATED_SERVICES_TEMPLATES.has(template)) values.push(shortDay(digest.dayKey));
  values.push(servicesLine(digest));
  return values;
}

/** "2026-10-24" -> "24 Oct": the year is already on the first line. */
function shortDay(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}
