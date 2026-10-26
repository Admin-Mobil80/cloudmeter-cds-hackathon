import { safeCredentialContext, maskExternalId } from '../functions/shared/connect-diagnostics';
import { ProviderAuthError, ProviderPermissionError } from '../functions/shared/providers/types';
import type { CredentialField } from '../functions/shared/providers/types';

/**
 * What a failed connection is allowed to write down.
 *
 * The connect path used to log nothing at all: a customer reported "couldn't
 * connect that account" and the evidence was an invocation record with no
 * account, no role and no reason. Diagnosing one such report meant reading
 * the handler to work out which branch could even produce that message.
 *
 * Logging it is easy; logging it without putting a client secret or a service
 * account key into CloudWatch is the part worth testing, so most of what
 * follows is about what must NOT appear.
 */

const AWS_FIELDS: CredentialField[] = [
  { name: 'roleArn', label: 'Role ARN', type: 'text' },
];
const AZURE_FIELDS: CredentialField[] = [
  { name: 'tenant_id', label: 'Directory (tenant) ID', type: 'text' },
  { name: 'client_id', label: 'Application (client) ID', type: 'text' },
  { name: 'client_secret', label: 'Client secret', type: 'secret' },
  { name: 'subscription_id', label: 'Subscription ID', type: 'text' },
];

describe('what gets logged for a failed AWS connect', () => {
  const creds = {
    roleArn: 'arn:aws:iam::159042233894:role/CloudMeterReadOnly',
    externalId: 'cm-1a2b3c4d5e6f7a8b',
  };

  it('keeps the role ARN, which is the whole point', () => {
    // Without it the log cannot say which role was refused, and the ARN is
    // not a secret — the customer pasted it into a form.
    const out = safeCredentialContext('aws', creds, AWS_FIELDS);
    expect(out.roleArn).toBe('arn:aws:iam::159042233894:role/CloudMeterReadOnly');
  });

  it('never writes the External ID in full', () => {
    const out = safeCredentialContext('aws', creds, AWS_FIELDS);
    expect(out.externalId).not.toContain('3c4d5e6f7a8b');
    expect(JSON.stringify(out)).not.toContain(creds.externalId);
  });

  it('keeps enough of it to confirm a mismatch', () => {
    // The support question is "does the one in your trust policy start
    // cm-1a2b?" — answerable without either side reading the secret out.
    expect(safeCredentialContext('aws', creds, AWS_FIELDS).externalId).toBe('cm-1a2b…');
  });

  it('says when there is no External ID at all', () => {
    const out = safeCredentialContext('aws', { roleArn: 'arn:x' }, AWS_FIELDS);
    expect(out.externalId).toBe('(none)');
  });
});

describe('secrets from other providers', () => {
  it('redacts a field the adapter declared secret', () => {
    const out = safeCredentialContext('azure', {
      tenant_id: 'aaaa-bbbb',
      client_id: 'cccc-dddd',
      client_secret: 'REAL~SECRET~VALUE',
      subscription_id: 'eeee-ffff',
    }, AZURE_FIELDS);

    expect(out.client_secret).toBe('(set)');
    expect(JSON.stringify(out)).not.toContain('REAL~SECRET~VALUE');
    // The non-secret ones survive, or the log says nothing useful.
    expect(out.tenant_id).toBe('aaaa-bbbb');
    expect(out.subscription_id).toBe('eeee-ffff');
  });

  it('redacts a field no adapter declared', () => {
    /*
     * The important default. A credential that arrives without being declared
     * is precisely the one nobody has decided is safe to print — a denylist
     * would have leaked it until someone noticed.
     */
    const out = safeCredentialContext('gcp', {
      project: 'demo-project',
      service_account_json: '{"private_key":"-----BEGIN PRIVATE KEY-----"}',
    }, [{ name: 'project', label: 'Project ID', type: 'text' }]);

    expect(out.service_account_json).toBe('(set)');
    expect(JSON.stringify(out)).not.toContain('PRIVATE KEY');
  });

  it('distinguishes an empty field from a withheld one', () => {
    // "They left it blank" and "they filled it in and we are not printing it"
    // are different diagnoses, and the blank one is usually the answer.
    const out = safeCredentialContext('azure', {
      client_secret: '', tenant_id: 'aaaa',
    }, AZURE_FIELDS);
    expect(out.client_secret).toBe('(empty)');
  });

  it('adds no External ID line for a provider that has none', () => {
    const out = safeCredentialContext('azure', { tenant_id: 'aaaa' }, AZURE_FIELDS);
    expect('externalId' in out).toBe(false);
  });
});

describe('maskExternalId', () => {
  it('shows a prefix for a full-length id', () => {
    expect(maskExternalId('cm-1a2b3c4d5e6f7a8b')).toBe('cm-1a2b…');
  });

  it('shows nothing from a value too short to mask meaningfully', () => {
    // Masking four characters of a six character value protects nothing, so
    // report presence instead of leaking most of it.
    expect(maskExternalId('cm-12')).toBe('(set)');
  });

  it('reports absence plainly', () => {
    expect(maskExternalId(undefined)).toBe('(none)');
    expect(maskExternalId('')).toBe('(none)');
  });
});

describe('the failure class in the log', () => {
  it('names which of the two it was', () => {
    /*
     * The field support reads first. A bare `extends Error {}` leaves name as
     * "Error" for both, which is how the first real diagnosis of this logged
     * failure: 'Error' and told nobody anything.
     */
    expect(new ProviderAuthError('x').name).toBe('ProviderAuthError');
    expect(new ProviderPermissionError('x').name).toBe('ProviderPermissionError');
  });

  it('still behaves as an Error, so existing instanceof checks hold', () => {
    const err = new ProviderAuthError('cannot assume');
    expect(err instanceof Error).toBe(true);
    expect(err.message).toBe('cannot assume');
  });
});
