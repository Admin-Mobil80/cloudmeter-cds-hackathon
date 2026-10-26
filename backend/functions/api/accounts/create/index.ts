import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';
import { baseSpendFor, generateMonthlySnapshots, generateDailySnapshots } from '../../../shared/seed-cost-data';
import { storeCredentials, deleteCredentials } from '../../../shared/secrets';
import { persistDailySnapshots } from '../../../shared/persist-cost';
import { safeCredentialContext } from '../../../shared/connect-diagnostics';
import { adhocSnapshots } from '../../../shared/adhoc';
import {
  getAdapter,
  ProviderAuthError,
  ProviderPermissionError,
  ProviderCredentials,
} from '../../../shared/providers';

const MONTHS = 6;
const DAYS = 90;

/** Matches the rename route and every other named entity in this API. */
const MAX_NAME_LENGTH = 80;

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  let body: {
    provider?: string;
    name?: string;
    id?: string;
    connectionToken?: string;
    credentials?: ProviderCredentials;
    useSampleData?: boolean;
    owner?: string;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const { provider, id: externalAccountId, connectionToken, credentials, useSampleData } = body;
  const owner = typeof body.owner === 'string' ? body.owner.trim().slice(0, 120) : '';
  if (!provider || !body.name || !externalAccountId) {
    return json(400, { message: 'provider, name, and id are required' });
  }

  /*
   * Connecting a cloud bill stays an Owner/Admin act: it hands over
   * credentials and decides what the organisation is charged for monitoring.
   *
   * Adhoc Spend is neither. It holds what people already pay for Claude or
   * ChatGPT out of their own budget, and a Member is exactly who knows that.
   * Before this, a workspace with no accounts left a Member looking at an
   * empty page inviting them to connect AWS — which their role forbids — with
   * no way to record the one thing they could.
   *
   * Any number of tools, because an adhoc account *is* one tool — Claude,
   * ChatGPT, Cursor — with each plan a line inside it. A Member who pays for
   * a tool nobody has added yet has to be able to add it, or the record is
   * simply missing.
   */
  if (caller.membership.role === 'member') {
    if (provider !== 'adhoc') {
      return json(403, { message: 'Only an Owner or an Admin can connect a cloud account.' });
    }
  } else {
    const forbidden = requireRole(caller, ['owner', 'admin']);
    if (forbidden) return forbidden;
  }

  /*
   * One account per tool, whoever is asking.
   *
   * A second "Claude" splits one shared ledger in two: half the workspace's
   * plans in one account, half in the other, and every roll-up, digest and
   * chart quietly reporting a fraction. Nothing downstream can detect it,
   * because both accounts are perfectly valid on their own.
   *
   * Applied to Owners and Admins as well as Members. It was Members only at
   * first, on the reasoning that an Owner can delete a mistake — true, but it
   * left the duplicate easy to make and easy to miss, and two "Claude" rows
   * appeared in a real workspace within the hour. A cloud provider is exempt:
   * two AWS accounts are two genuinely separate bills.
   */
  if (provider === 'adhoc') {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ProjectionExpression: 'accountId, provider, #n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: {
        ':pk': `TENANT#${caller.membership.tenantId}`, ':sk': 'ACCOUNT#',
      },
    }));
    const wanted = String(body.name ?? '').trim().toLowerCase();
    const clash = (Items ?? []).find((a) => a.provider === 'adhoc'
      && String(a.name ?? '').trim().toLowerCase() === wanted);
    if (clash) {
      return json(409, {
        message: `${String(body.name).trim()} is already here — open it and add your subscription `
          + 'to it, so everyone\'s plans for that tool stay in one place.',
        // Named so the portal can offer the way in the message asks for,
        // rather than a retry that would fail on the same name.
        existingAccountId: clash.accountId,
        existingName: clash.name,
      });
    }
  }

  // Same checks the rename route already applies. This path had none: `name`
  // was taken straight from the body, stored raw, and rendered by the portal —
  // so an unbounded string, or one carrying markup, arrived intact. Rename
  // validated and create did not, which is the kind of gap that only shows up
  // when someone goes looking for it.
  if (typeof body.name !== 'string') return json(400, { message: 'name must be text' });
  const name = body.name.trim();
  if (!name) return json(400, { message: 'Give the account a name.' });
  if (name.length > MAX_NAME_LENGTH) {
    return json(400, { message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  const adapter = getAdapter(provider);
  if (!adapter) return json(400, { message: `Unknown provider: ${provider}` });

  const tenantId = caller.membership.tenantId;
  const accountId = randomUUID();
  const now = new Date().toISOString();

  /**
   * Adhoc spend has nothing to connect to: no credentials, no secret, no
   * external call. The account is created empty and its subscriptions are
   * added afterwards, each edit recomputing the snapshots.
   *
   * `dataSource: 'adhoc'` is what keeps it out of the sweep, which only
   * processes 'live' — so nothing ever tries to poll a provider that does not
   * exist.
   */
  if (provider === 'adhoc') {
    const snapshots = adhocSnapshots([], MONTHS);
    await persistAccount({
      tenantId, accountId, provider, name, externalAccountId, now,
      dataSource: 'adhoc', spend: 0, snapshots, owner,
      createdBy: caller.userId, createdByEmail: caller.email,
    });
    return json(201, {
      id: accountId, provider, name, externalId: externalAccountId,
      dataSource: 'adhoc', status: 'connected', spend: 0, sync: now, hasDaily: false,
    });
  }

  // Sample data stays available for demos and for providers a customer isn't
  // ready to connect for real yet.
  if (useSampleData) {
    const currentMonthSpend = baseSpendFor(provider, name);
    const snapshots = generateMonthlySnapshots(provider, name, currentMonthSpend);
    await persistAccount({
      tenantId, accountId, provider, name, externalAccountId, now,
      dataSource: 'seed', spend: currentMonthSpend, snapshots, owner,
      createdBy: caller.userId, createdByEmail: caller.email,
    });
    await persistDailySnapshots(accountId, generateDailySnapshots(provider, name, currentMonthSpend, DAYS));
    return json(201, {
      id: accountId, provider, name, externalId: externalAccountId,
      dataSource: 'seed', status: 'connected', spend: currentMonthSpend, sync: now,
      hasDaily: true,
    });
  }

  // Assemble the credentials this provider declared it needs. AWS is special:
  // its External ID is issued by the connect-params flow and read back from
  // the server-side pending record, never accepted from the client.
  const creds: ProviderCredentials = { ...(credentials ?? {}) };
  let pendingKey: { PK: string; SK: string } | null = null;

  if (provider === 'aws') {
    if (!connectionToken) {
      return json(400, { message: 'connectionToken is required to connect an AWS account' });
    }
    pendingKey = { PK: `TENANT#${tenantId}`, SK: `PENDINGCONN#${connectionToken}` };
    const { Item: pending } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: pendingKey }));
    if (!pending) {
      return json(400, { message: 'That connection request expired — close and reopen the Add Account dialog.' });
    }
    creds.externalId = pending.externalId as string;
  }

  for (const field of adapter.credentialFields) {
    if (field.required !== false && !creds[field.name]) {
      return json(400, { message: `${field.label} is required` });
    }
  }

  try {
    await adapter.verifyAccess(creds);
  } catch (err) {
    /*
     * Say why, in the log as well as to the customer.
     *
     * This path used to return a 400 and record nothing. A customer would
     * report "it won't connect" and the only evidence was that the function
     * had been invoked — not which account, not which role, not whether the
     * role was unreachable or merely under-permissioned. Reconstructing one
     * such report took longer than the fix.
     *
     * The failure class is the most useful single field: ProviderAuthError
     * means we never got in, which is the customer's trust policy;
     * ProviderPermissionError means we did get in and the role is missing a
     * ce: action, which is their permission policy. Two different fixes, and
     * the message alone does not separate them.
     */
    console.warn('Account connect failed', {
      tenantId,
      provider,
      externalAccountId,
      failure: (err as Error).name || 'Error',
      reason: (err as Error).message,
      ...safeCredentialContext(provider, creds, adapter.credentialFields),
    });
    if (err instanceof ProviderAuthError || err instanceof ProviderPermissionError) {
      return json(400, { message: err.message });
    }
    return json(400, { message: `Couldn't verify access: ${(err as Error).message}` });
  }

  let snapshots;
  try {
    snapshots = await adapter.fetchMonthlySnapshots(creds, MONTHS);
  } catch (err) {
    return json(400, { message: `Connected, but couldn't read cost data: ${(err as Error).message}` });
  }

  const credentialsSecretArn = await storeCredentials(tenantId, accountId, creds);

  try {
    const currentMonthSpend = snapshots.find((s) => s.isCurrent)?.totalSpend ?? 0;
    await persistAccount({
      tenantId, accountId, provider, name, externalAccountId, now,
      dataSource: 'live', spend: currentMonthSpend, snapshots, credentialsSecretArn, owner,
      createdBy: caller.userId, createdByEmail: caller.email,
    });

    // Daily data is a bonus, not a precondition: a provider without daily
    // resolution (or a daily pull that fails) must not block the connection,
    // since the monthly data is already stored and useful.
    let hasDaily = false;
    if (adapter.fetchDailySnapshots) {
      try {
        const daily = await adapter.fetchDailySnapshots(creds, DAYS);
        await persistDailySnapshots(accountId, daily);
        hasDaily = daily.length > 0;
      } catch (err) {
        console.error('Daily cost pull failed', (err as Error).message);
      }
    }

    // No fabricated alert here any more. Alerts come from the detector in the
    // hourly sweep, which compares real daily spend against a real baseline —
    // a sample account inventing a spike made every alert in the list suspect,
    // including the true ones.

    if (pendingKey) {
      await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: pendingKey }));
    }

    return json(201, {
      id: accountId, provider, name, externalId: externalAccountId,
      dataSource: 'live', status: 'connected', spend: currentMonthSpend, sync: now,
      providerVerified: adapter.verified,
      hasDaily,
    });
  } catch (err) {
    // Don't leave an orphaned secret behind if persistence fails.
    await deleteCredentials(credentialsSecretArn);
    throw err;
  }
};

async function persistAccount(a: {
  tenantId: string; accountId: string; provider: string; name: string;
  externalAccountId: string; now: string; dataSource: 'live' | 'seed' | 'adhoc';
  spend: number; snapshots: Array<{ monthKey: string }>; credentialsSecretArn?: string;
  owner?: string;
  // Recorded so an Admin can remove what they connected and nothing else. The
  // email is stored alongside the id purely so a refusal can name the person
  // to go and ask.
  createdBy: string; createdByEmail: string;
}) {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${a.tenantId}`,
      SK: `ACCOUNT#${a.accountId}`,
      accountId: a.accountId,
      provider: a.provider,
      name: a.name,
      externalId: a.externalAccountId,
      dataSource: a.dataSource,
      ...(a.credentialsSecretArn ? { credentialsSecretArn: a.credentialsSecretArn } : {}),
      status: 'connected',
      spend: a.spend,
      sync: a.now,
      createdAt: a.now,
      createdBy: a.createdBy,
      createdByEmail: a.createdByEmail,
      // Omitted rather than stored empty, so "never set" and "set to blank"
      // don't become the same thing.
      ...(a.owner ? { owner: a.owner } : {}),
    },
  }));

  await Promise.all(a.snapshots.map((s) =>
    ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: `ACCOUNT#${a.accountId}`, SK: `MONTHLY#${s.monthKey}`, ...s },
    })),
  ));
}
