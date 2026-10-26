import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import type { ProviderCredentials } from './providers/types';

const client = new SecretsManagerClient({});
const PREFIX = process.env.SECRET_PREFIX ?? 'cloudmeter';

// Customer cloud credentials live in Secrets Manager rather than alongside
// application data in DynamoDB, so a bug or overly-broad read on the main
// table can't expose them.
function secretName(tenantId: string, accountId: string): string {
  return `${PREFIX}/tenant/${tenantId}/account/${accountId}`;
}

export async function storeCredentials(
  tenantId: string,
  accountId: string,
  creds: ProviderCredentials,
): Promise<string> {
  const Name = secretName(tenantId, accountId);
  const SecretString = JSON.stringify(creds);

  try {
    const res = await client.send(new CreateSecretCommand({
      Name,
      SecretString,
      Description: `CloudMeter cloud credentials for account ${accountId}`,
    }));
    return res.ARN!;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      // A prior attempt created it (or the name was reused) — overwrite.
      const res = await client.send(new PutSecretValueCommand({ SecretId: Name, SecretString }));
      return res.ARN!;
    }
    throw err;
  }
}

export async function loadCredentials(secretRef: string): Promise<ProviderCredentials> {
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretRef }));
  if (!res.SecretString) throw new Error('Stored credentials are empty');
  return JSON.parse(res.SecretString) as ProviderCredentials;
}

export async function deleteCredentials(secretRef: string): Promise<void> {
  try {
    await client.send(new DeleteSecretCommand({
      SecretId: secretRef,
      // Keep a short recovery window rather than force-deleting, in case an
      // account is removed by mistake.
      RecoveryWindowInDays: 7,
    }));
  } catch {
    // Never let credential cleanup block account deletion.
  }
}
