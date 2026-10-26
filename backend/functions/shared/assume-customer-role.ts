import { STSClient, AssumeRoleCommand, type Credentials } from '@aws-sdk/client-sts';

/*
 * Reaching a customer's AWS role.
 *
 * Every customer role trusts one CloudMeter AWS account plus a per-connection
 * External ID. CloudMeter moved accounts on 2026-10-20: connections made since
 * trust the new account, which reaches them directly. Connections made before
 * still trust the old one, and asking every customer to edit their role was
 * not acceptable, so the old account holds a bridge role
 * (CUSTOMER_BRIDGE_ROLE_ARN) that this account may assume, and which may then
 * assume the customer's role exactly as before, External ID and all.
 *
 * So: try directly first, and fall back through the bridge only when the
 * direct attempt is refused. Which path worked is remembered per role for the
 * life of the container, so a sweep over many accounts does not pay for the
 * refused attempt every time.
 *
 * TEMPORARY. Once every customer trusts the new account, delete the bridge
 * role in the old account and remove the fallback here (see
 * MIGRATION-HANDOFF.md).
 */

const sts = new STSClient({});
const BRIDGE_ROLE_ARN = (process.env.CUSTOMER_BRIDGE_ROLE_ARN ?? '').trim();
const SESSION_NAME = 'cloudmeter-cost-ingestion';

const viaBridge = new Map<string, boolean>();
let bridgeCreds: { creds: Credentials; until: number } | undefined;

function isRefusal(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return name === 'AccessDenied' || name === 'AccessDeniedException';
}

async function bridgeClient(): Promise<STSClient> {
  if (!bridgeCreds || bridgeCreds.until < Date.now() + 60_000) {
    const { Credentials } = await sts.send(new AssumeRoleCommand({
      RoleArn: BRIDGE_ROLE_ARN,
      RoleSessionName: 'cloudmeter-customer-bridge',
      DurationSeconds: 3600,
    }));
    if (!Credentials?.AccessKeyId) throw new Error('Bridge AssumeRole returned no credentials');
    bridgeCreds = { creds: Credentials, until: Credentials.Expiration?.getTime() ?? Date.now() + 3_000_000 };
  }
  const c = bridgeCreds.creds;
  return new STSClient({
    credentials: { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! },
  });
}

async function assumeWith(client: STSClient, roleArn: string, externalId: string): Promise<Credentials | undefined> {
  const { Credentials } = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    ExternalId: externalId,
    RoleSessionName: SESSION_NAME,
    DurationSeconds: 900,
  }));
  return Credentials;
}

/**
 * Credentials for a customer's role. Throws the direct attempt's error when
 * neither path works: that is the one a correctly set-up new connection, and
 * the customer guidance built on it, should be judged by.
 */
export async function assumeCustomerRole(roleArn: string, externalId: string): Promise<Credentials | undefined> {
  if (BRIDGE_ROLE_ARN && viaBridge.get(roleArn)) {
    return assumeWith(await bridgeClient(), roleArn, externalId);
  }
  try {
    const creds = await assumeWith(sts, roleArn, externalId);
    viaBridge.set(roleArn, false);
    return creds;
  } catch (direct) {
    if (!BRIDGE_ROLE_ARN || !isRefusal(direct)) throw direct;
    try {
      const creds = await assumeWith(await bridgeClient(), roleArn, externalId);
      viaBridge.set(roleArn, true);
      console.log('Customer role reached through the bridge', { roleArn });
      return creds;
    } catch {
      throw direct;
    }
  }
}
