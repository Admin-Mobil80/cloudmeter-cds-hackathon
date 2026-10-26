/**
 * Builds the workspace Apple's and Google's reviewers sign into.
 *
 * Every figure here is produced by the product's own sample-data generators —
 * the same ones behind "use sample data" when connecting an account — so what
 * a reviewer sees has the shape real CloudMeter data has: six months of
 * history, per-service and per-tag breakdowns, daily rows behind the charts.
 * Hand-written numbers would look plausible on the dashboard and fall apart
 * the moment a reviewer opened a breakdown.
 *
 * Idempotent. The tenant id is fixed, so re-running refreshes the data in
 * place rather than leaving a second demo workspace behind. Run it again
 * whenever the sample months need to roll forward.
 *
 *   npx tsx scripts/seed-demo-workspace.ts dev
 *   npx tsx scripts/seed-demo-workspace.ts prod
 *
 * Creates no cloud credentials of any kind: every account is dataSource
 * 'seed', so nothing in this workspace can reach a real cloud account.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { baseSpendFor, generateMonthlySnapshots, generateDailySnapshots } from '../functions/shared/seed-cost-data';
import { persistDailySnapshots } from '../functions/shared/persist-cost';

const ENV = (process.argv[2] ?? '').toLowerCase();
if (ENV !== 'dev' && ENV !== 'prod') {
  console.error('usage: tsx scripts/seed-demo-workspace.ts <dev|prod>');
  process.exit(1);
}

// The second account (975138397215), where CloudMeter has run since the
// 2026-10-20 cutover. The first account is frozen and is not seeded.
const REGION = 'us-east-1';
const TABLE = `cloudmeter_${ENV}`;
if (process.env.TABLE_NAME !== TABLE) {
  // shared/persist-cost resolves its table at module load, before this file
  // runs. Writing months to one table and days to another would leave a
  // workspace whose charts silently disagree, so refuse rather than guess.
  console.error(`TABLE_NAME must be set to ${TABLE} before running this script:`);
  console.error(`  TABLE_NAME=${TABLE} npx tsx scripts/seed-demo-workspace.ts ${ENV}`);
  process.exit(1);
}
const POOL = ENV === 'dev' ? 'us-east-1_RS6XKDyOf' : 'us-east-1_MiKIgrEgm';

const DEMO_EMAIL = 'appreview@cloudmeter.io';
const DEMO_NAME = 'App Review';
const TENANT_NAME = 'CloudMeter Demo';
/** Fixed so a re-run updates this workspace instead of creating another. */
const TENANT_ID = ENV === 'dev'
  ? '00000000-dead-4bee-8000-000000000dev'
  : '00000000-dead-4bee-8000-00000000prod';

/** How long the reviewers' subscription stays valid. */
const MONTHS_VALID = 5;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region: REGION });

/*
 * The accounts the reviewer sees.
 *
 * Deliberately a mix: several providers so the dashboard's provider split has
 * something to divide, and both a cloud and an AI provider so the "one ledger
 * for all of it" claim in the store listing is visible rather than asserted.
 */
const ACCOUNTS: Array<{ provider: string; name: string; externalId: string }> = [
  { provider: 'aws', name: 'Production (AWS)', externalId: '112233445566' },
  { provider: 'aws', name: 'Staging (AWS)', externalId: '223344556677' },
  { provider: 'azure', name: 'Corporate (Azure)', externalId: 'a1b2c3d4-0000-4000-8000-demo00000001' },
  { provider: 'gcp', name: 'Analytics (Google Cloud)', externalId: 'demo-analytics-0001' },
  { provider: 'openai', name: 'OpenAI Platform', externalId: 'org-demo0001' },
];

async function seed() {
  const now = new Date().toISOString();
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + MONTHS_VALID);

  // ---- the reviewer's login -------------------------------------------
  let userId: string;
  try {
    const created = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: POOL,
      Username: DEMO_EMAIL,
      // No welcome mail: the address has no mailbox, and the sign-in code is
      // fixed in create-auth-challenge rather than emailed.
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: DEMO_EMAIL },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: DEMO_NAME },
      ],
    }));
    userId = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? '';
    console.log('created Cognito user');
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;
    const found = await cognito.send(new AdminGetUserCommand({
      UserPoolId: POOL, Username: DEMO_EMAIL,
    }));
    userId = found.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? '';
    console.log('Cognito user already existed');
  }
  if (!userId) throw new Error('could not resolve the demo user id');

  // ---- clear any previous run, so months roll forward cleanly ----------
  const { Items: existing } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p',
    ExpressionAttributeValues: { ':p': `TENANT#${TENANT_ID}` },
  }));
  for (const row of existing ?? []) {
    if (!String(row.SK).startsWith('ACCOUNT#')) continue;
    const accountId = String(row.SK).slice('ACCOUNT#'.length);
    const { Items: cost } = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p',
      ExpressionAttributeValues: { ':p': `ACCOUNT#${accountId}` },
    }));
    for (const c of cost ?? []) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: c.PK, SK: c.SK } }));
    }
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: row.PK, SK: row.SK } }));
  }
  if ((existing ?? []).length) console.log('cleared the previous demo data');

  // ---- the workspace ---------------------------------------------------
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `TENANT#${TENANT_ID}`,
      SK: `TENANT#${TENANT_ID}`,
      tenantId: TENANT_ID,
      name: TENANT_NAME,
      ownerId: userId,
      createdAt: now,
      createdBy: DEMO_EMAIL,
      createdVia: 'demo-seed',
      // Billed in USD so the reviewer sees dollars, which is what both stores'
      // reviewers expect and what the screenshots show.
      currency: 'USD',
      displayCurrency: 'USD',
      billingAddress: { country: 'United States' },
      planId: 'growth',
      subscriptionStatus: 'active',
      subscriptionSource: 'demo-seed',
      subscriptionSetBy: 'demo-seed',
      subscriptionUpdatedAt: now,
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
      // No gateway: this subscription was never bought, and naming one would
      // send anybody reconciling it to a dashboard that has never heard of it.
      settingsUpdatedAt: now,
      // Its login is published (README, store review notes), so it can look at
      // everything and change nothing. See requireNotDemo in shared/authz.ts.
      readOnlyDemo: true,
    },
  }));

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `TENANT#${TENANT_ID}`,
      SK: `MEMBER#${userId}`,
      GSI1PK: `USER#${userId}`,
      GSI1SK: `TENANT#${TENANT_ID}`,
      userId,
      email: DEMO_EMAIL,
      name: DEMO_NAME,
      role: 'owner',
      status: 'active',
      invitedAt: now,
      joinedAt: now,
    },
  }));
  console.log(`workspace "${TENANT_NAME}" ready, plan active until ${periodEnd.toISOString().slice(0, 10)}`);

  // ---- the accounts and their cost history -----------------------------
  for (const a of ACCOUNTS) {
    const accountId = randomUUID();
    const spend = baseSpendFor(a.provider, a.name);
    const monthly = generateMonthlySnapshots(a.provider, a.name, spend);
    const daily = generateDailySnapshots(a.provider, a.name, spend, 60);

    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `TENANT#${TENANT_ID}`,
        SK: `ACCOUNT#${accountId}`,
        accountId,
        provider: a.provider,
        name: a.name,
        externalId: a.externalId,
        dataSource: 'seed',
        status: 'connected',
        spend,
        sync: now,
        createdAt: now,
        createdBy: userId,
        createdByEmail: DEMO_EMAIL,
      },
    }));

    for (const s of monthly) {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { PK: `ACCOUNT#${accountId}`, SK: `MONTHLY#${s.monthKey}`, ...s },
      }));
    }
    await persistDailySnapshots(accountId, daily);

    console.log(`  ${a.name.padEnd(26)} $${spend.toLocaleString('en-US')}  ${monthly.length} months, ${daily.length} days`);
  }

  console.log('\ndone.');
}

seed().catch((err) => { console.error(err); process.exit(1); });
