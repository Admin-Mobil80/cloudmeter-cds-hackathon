/**
 * One HTML shell for every transactional email CloudMeter sends, so they look
 * like they come from the same product rather than from whichever handler
 * happened to write them.
 */

export interface EmailBody {
  /** Shown as the heading. Usually the same sentence as the subject. */
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** Small print under the button — addresses, opt-outs, caveats. */
  footnote?: string;
}

export function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * A person's display name, for use in a sentence.
 *
 * Falls back to the local-part of their address rather than the whole address:
 * "mohan invited you" still reads as a person, where
 * "mohan@mobil80.com invited you" reads as a machine.
 */
export function displayName(name: string | null | undefined, email: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return titleCaseIfUnformatted(trimmed);

  const local = (email ?? '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!local) return email;
  return titleCaseIfUnformatted(local);
}

/**
 * Capitalises a name only when it carries no capitals of its own.
 *
 * People sign up typing "mohan", and "mohan invited you" reads as a username
 * rather than a person. But a name that already has capitals has been written
 * deliberately — "van der Berg" and "McDonald" must survive untouched, so this
 * only acts when there is nothing to preserve.
 */
function titleCaseIfUnformatted(value: string): string {
  if (/[A-Z]/.test(value)) return value;
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'an Admin', member: 'a Member' };

/** "admin" -> "an Admin", for dropping into a sentence. */
export function rolePhrase(role: string): string {
  return ROLE_LABEL[role] ?? `a ${role}`;
}

export function renderEmailHtml(body: EmailBody): string {
  const paragraphs = body.paragraphs
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`)
    .join('');

  const cta = body.cta
    ? `<a href="${escapeHtml(body.cta.url)}" style="display:inline-block;margin-top:8px;
        padding:11px 20px;background:#2a78d6;color:#ffffff;border-radius:8px;font-size:14px;
        font-weight:600;text-decoration:none">${escapeHtml(body.cta.label)}</a>`
    : '';

  const footnote = body.footnote
    ? `<p style="margin:18px 0 0;font-size:12.5px;line-height:1.5;color:#898781">${escapeHtml(body.footnote)}</p>`
    : '';

  // Inline styles and a table-free single column: every mail client strips
  // <style> blocks, and anything cleverer breaks in Outlook.
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f4;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0b0b0b">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;
      padding:28px;border:1px solid rgba(11,11,11,0.10)">
      <div style="font-size:13px;font-weight:700;color:#2a78d6;margin-bottom:18px;
        letter-spacing:-0.01em">CloudMeter</div>
      <h1 style="font-size:17px;font-weight:650;margin:0 0 16px;line-height:1.35">${escapeHtml(body.title)}</h1>
      <div style="font-size:14.5px;line-height:1.55;color:#52514e">${paragraphs}</div>
      ${cta}
      ${footnote}
    </div>
  </body></html>`;
}

/** The same content as plain text, for clients that won't render HTML. */
export function renderEmailText(body: EmailBody): string {
  const lines = [body.title, '', ...body.paragraphs.filter(Boolean)];
  if (body.cta) lines.push('', `${body.cta.label}: ${body.cta.url}`);
  if (body.footnote) lines.push('', body.footnote);
  return lines.join('\n');
}
