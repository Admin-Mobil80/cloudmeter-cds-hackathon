import type { CredentialField, ProviderCredentials } from './providers/types';

/**
 * The part of an External ID that is safe to write down.
 *
 * It is the shared secret guarding assumption of a customer's role, so the
 * whole value does not belong in a log. A prefix is enough for the question
 * support actually asks — "does the one in your trust policy start cm-1a2b?"
 * — which is how an External ID mismatch gets confirmed without either side
 * reading the secret aloud.
 *
 * Anything too short to have a meaningful prefix is reported as present
 * rather than partially shown, since masking four characters of a six
 * character value protects nothing.
 */
export function maskExternalId(value: string | undefined): string {
  if (!value) return '(none)';
  return value.length >= 10 ? `${value.slice(0, 7)}…` : '(set)';
}

/**
 * What can be said about a failed connection without leaking a credential.
 *
 * Derived from the adapter's own field declarations rather than a list kept
 * here: a field the provider marked `secret` is redacted, and a new secret
 * field is therefore protected the day it is added rather than the day
 * somebody remembers to update this file. Values are reported as `(set)` when
 * withheld, because knowing whether a customer filled a field in at all is
 * usually the diagnosis.
 *
 * `externalId` is handled separately — it is injected server-side from the
 * pending record and never appears in credentialFields, so a rule driven by
 * that list alone would print it in full.
 */
export function safeCredentialContext(
  provider: string,
  creds: ProviderCredentials,
  fields: CredentialField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const declared = new Map(fields.map((f) => [f.name, f]));

  for (const [name, value] of Object.entries(creds)) {
    if (name === 'externalId') continue;
    if (!value) { out[name] = '(empty)'; continue; }
    const field = declared.get(name);
    // Unknown fields are treated as secret. A credential that arrived without
    // being declared is exactly the one nobody has decided is safe to print.
    out[name] = !field || field.type === 'secret' ? '(set)' : value;
  }

  if (provider === 'aws' || creds.externalId !== undefined) {
    out.externalId = maskExternalId(creds.externalId);
  }
  return out;
}
