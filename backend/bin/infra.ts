#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { AppSyncStack } from '../lib/appsync-stack';
import { DnsStack } from '../lib/dns-stack';
import { CertStack } from '../lib/cert-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { RedirectStack } from '../lib/redirect-stack';
import { NotificationsStack } from '../lib/notifications-stack';
import { AssistantStack } from '../lib/assistant-stack';
import { BmsAuthStack } from '../lib/bms-auth-stack';
import { CiDeployStack } from '../lib/ci-deploy-stack';
import { EnvName } from '../lib/env-config';
import { ServiceNameTagger } from '../lib/service-tags';

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

/**
 * The AWS account that owns cloudmeter.io.
 *
 * Everything DNS-shaped — the hosted zone, the certificates, the redirect
 * distribution, the alias records on each site — only means anything in the
 * account holding the domain. A second account running its own copy reaches
 * the sites on their CloudFront hostnames instead.
 *
 * An unset account (a bare `cdk synth`, or the tests) is treated as the owner,
 * so nothing about the existing deployment changes shape when CDK is run
 * without credentials.
 */
const DOMAIN_OWNER_ACCOUNT = '231427841372';
const ownsDomain = !account || account === DOMAIN_OWNER_ACCOUNT;

/**
 * Accounts where CloudMeter brings its own CDK bootstrap.
 *
 * A qualifier is a short string stamped into the names of the scaffolding CDK
 * needs in an account — the asset bucket and the deploy roles — and everything
 * sharing a qualifier shares one `CDKToolkit` stack. The default (`hnb659fds`)
 * is what every CDK app uses unless told otherwise, so two unrelated teams in
 * one account end up on the same scaffolding without either knowing.
 *
 * That is fine until one of them re-bootstraps: a newer bootstrap version or
 * different deploy permissions silently changes what the other depends on, and
 * the first symptom is a failed deploy with nothing obviously connecting it to
 * the cause.
 *
 * 975138397215 is a busy, shared company account where CloudMeter is a guest,
 * so it gets a qualifier of its own. It has never been bootstrapped at all
 * today, which is exactly why this is cheap to decide now rather than after
 * somebody else arrives.
 *
 * Deliberately keyed by account rather than set globally: the original account
 * is already bootstrapped under the default qualifier, and applying this one
 * there would point every deploy at scaffolding that does not exist.
 */
const BOOTSTRAP_QUALIFIERS: Record<string, string> = {
  // Ten characters exactly, which is CDK's limit ([A-Za-z0-9_-]{1,10}). The
  // longest name it produces is the image-publishing role at 59 of its 64
  // characters, so spelling it out costs nothing and an abbreviation would
  // only make the resources harder to recognise in a shared account.
  '975138397215': 'cloudmeter',
};
const qualifier = account ? BOOTSTRAP_QUALIFIERS[account] : undefined;

/**
 * Accounts that also carry a UAT environment, alongside dev and prod.
 *
 * Keyed by account, like the qualifier above, so the original account's app
 * keeps exactly the shape it has today: building UAT there would add a dozen
 * never-deployed stacks to every diff and drift report in an account that is
 * being copied away from, not grown.
 */
const UAT_ACCOUNTS = new Set(['975138397215']);
const envNames: EnvName[] = account && UAT_ACCOUNTS.has(account)
  ? ['dev', 'uat', 'prod']
  : ['dev', 'prod'];

/**
 * Environments whose digest, renewal and sync schedules are built switched off.
 *
 * The cutover is a clean switch: one account's prod runs the schedules, never
 * both. Two live sets would sync every customer twice and send every digest
 * twice. Cutover was 2026-10-20: the second account's prod runs them, and the
 * first account's prod is paused. Its rules were disabled by hand that day,
 * and this entry keeps any later deploy there from switching them back on.
 *
 * Written into the code rather than passed as a flag on purpose: a flag left
 * off one later prod deploy would switch the schedules back on, silently.
 *
 * UAT is paused too: it holds a copy of production data for rehearsal, and
 * its sync would otherwise call real customers' clouds with their copied
 * credentials, and its digests would reach them on Slack.
 */
const PAUSED_SCHEDULES: Record<string, EnvName[]> = {
  '231427841372': ['prod'],
  '975138397215': ['uat'],
};
const schedulesPaused = (envName: EnvName) =>
  !!account && (PAUSED_SCHEDULES[account] ?? []).includes(envName);

// Set through context, not by handing the App a synthesizer instance. One
// instance shared by every stack also shares its list of files to upload, so
// each stack's manifest carried every other stack's Lambda code. Deploying a
// single stack then zipped the whole repo once per foreign function (bundling
// only runs for the stacks being deployed, and an unbundled function's source
// is the project root) and stalled on 2 GB uploads.
const app = new cdk.App({
  ...(qualifier ? { context: { '@aws-cdk/core:bootstrapQualifier': qualifier } } : {}),
});

// Every taggable resource in every stack carries these, so CloudMeter's own
// running cost can be told apart from anything else in this AWS account. An
// App-level aspect is the only way to get complete coverage — tagging stack by
// stack guarantees something new gets missed later.
//
// Note that a tag alone doesn't produce cost data: the key has to be activated
// as a cost allocation tag in Billing before it appears in Cost Explorer, and
// it only applies from that point onward — activation is not retroactive.
cdk.Tags.of(app).add('Application', 'CLOUDMETER');

// A third tag naming the AWS service each resource belongs to — cloudmeter=lambda,
// cloudmeter=dynamodb — so spend can be broken down by service as well as by
// application. It needs an aspect rather than another Tags.of() line because the
// value differs per resource; see lib/service-tags.ts.
cdk.Aspects.of(app).add(new ServiceNameTagger());

const env = { account, region };
const usEast1Env = { account, region: 'us-east-1' };

// Set via `cdk deploy --context otpFromEmail=you@yourdomain.com`, or leave the
// default — either way the address's domain must have SES DKIM verification
// complete (see DnsStack) before OTP emails can actually send.
const otpFromEmail = app.node.tryGetContext('otpFromEmail') ?? 'no-reply@cloudmeter.io';

/*
 * The hostnames an environment is really served on, when they are not its
 * domain names.
 *
 * A copy running without a domain answers on the names CloudFront assigns it,
 * and those do not exist until the frontend stacks have been deployed once —
 * so they cannot be derived here and have to be supplied afterwards:
 *
 *   --context siteOrigins=https://aaa.cloudfront.net,https://bbb.cloudfront.net
 *   --context portalUrl=https://aaa.cloudfront.net
 *   --context bmsUrl=https://bbb.cloudfront.net
 *
 * This is not cosmetic. The same site list feeds the API's allowed origins, so
 * a browser on an unlisted host has every request refused before it is sent —
 * which is exactly how the first sign-up attempt in the second account failed,
 * with a bare "Failed to fetch" and no clue in any server log, because the
 * request never reached the server.
 *
 * Empty for the account that owns the domain, where the site list is already
 * the truth.
 */
const siteOrigins: string[] = (app.node.tryGetContext('siteOrigins') ?? '')
  .split(',').map((o: string) => o.trim()).filter(Boolean);
const portalUrlOverride: string | undefined = app.node.tryGetContext('portalUrl');
const bmsUrlOverride: string | undefined = app.node.tryGetContext('bmsUrl');

/*
 * Shared across both environments: one hosted zone, one SES domain identity.
 *
 * Only in the account that owns the domain. This stack *creates* the
 * cloudmeter.io zone rather than importing one, so running it anywhere else
 * would stand up a second, competing copy of the zone — and the account it
 * would run in holds the company's main website and two dozen other zones.
 * Not building it at all is a stronger guarantee than building it carefully.
 */
const dnsStack = ownsDomain
  ? new DnsStack(app, 'CloudMeterDnsStack', { env, crossRegionReferences: true })
  : undefined;

/*
 * The second account's cloudmeter.io certificates, made by hand.
 *
 * Its zone (Z05994191AWS9MWELL4ML) was copied by hand from the first account's
 * and has served the domain since 2026-10-20. Its deploy role is denied Route 53
 * and has no ACM, by design, so certificates, the SES identity and every DNS
 * record there are made outside CDK. CDK only puts the domain and certificate
 * on each distribution; see FrontendStack's certificateArn.
 */
const IMPORTED_CERTIFICATES: Record<string, Partial<Record<EnvName, string>>> = {
  '975138397215': {
    prod: 'arn:aws:acm:us-east-1:975138397215:certificate/407fbce2-74ec-4740-ac32-2c5bd7514377',
    dev: 'arn:aws:acm:us-east-1:975138397215:certificate/79488124-0875-4a4a-b318-49ebb4074f7b',
    uat: 'arn:aws:acm:us-east-1:975138397215:certificate/09f5fda7-b58c-446a-b127-7aba423b8f5a',
  },
};

/*
 * Environments in an account that does not own the domain whose sites answer
 * on their cloudmeter.io names anyway.
 *
 * CloudFront allows a hostname on only one distribution in all of AWS, so an
 * environment joins this list only once its hostnames are free. UAT's never
 * existed in the first account. Prod's and dev's were released from the first
 * account's distributions on 2026-10-20 and moved here.
 */
const DOMAIN_ENVS: Record<string, EnvName[]> = {
  '975138397215': ['dev', 'uat', 'prod'],
};
/*
 * TEMPORARY. Customer roles connected before the move to the second account
 * still trust the first. This role in the first account bridges to them, so
 * no customer had to edit anything. Remove once every customer trusts the
 * second account; see MIGRATION-HANDOFF.md.
 */
const CUSTOMER_BRIDGE_ROLES: Record<string, string> = {
  '975138397215': 'arn:aws:iam::231427841372:role/cloudmeter-customer-bridge',
};
const customerBridgeRoleArn = account ? CUSTOMER_BRIDGE_ROLES[account] : undefined;

/*
 * WhatsApp numbers linked to AWS End User Messaging Social, per account and
 * environment. Listed environments send WhatsApp through AWS (no Meta token);
 * the rest keep using Meta's API. UAT is left out on purpose: it holds real
 * customers' numbers, and its empty Meta secret is what stops it messaging
 * them. Linked 2026-10-21; templates copied to the linked WhatsApp account.
 */
const WHATSAPP_AWS_PHONES: Record<string, Partial<Record<EnvName, string>>> = {
  '975138397215': {
    dev: 'phone-number-id-fff203cf061549b79b6b5b950addfbf4',
    prod: 'phone-number-id-fff203cf061549b79b6b5b950addfbf4',
  },
};
const whatsappAwsPhone = (envName: EnvName) =>
  account ? WHATSAPP_AWS_PHONES[account]?.[envName] : undefined;

/**
 * Environments that run the WhatsApp AI cost assistant (Bedrock AgentCore,
 * with incoming WhatsApp messages arriving through SNS).
 *
 * One WhatsApp number serves dev and prod, and a WhatsApp Business Account
 * sends its events to one destination, so only one environment can answer at
 * a time — whichever topic the account is pointed at. Tested in dev, released
 * to prod 2026-10-23; the WhatsApp account now points at prod's topic, so dev's
 * stack stays deployed but receives nothing until it is pointed back.
 */
const ASSISTANT_ENVS: Record<string, EnvName[]> = {
  '975138397215': ['dev', 'prod'],
};
const runsAssistant = (envName: EnvName) =>
  !!account && (ASSISTANT_ENVS[account] ?? []).includes(envName) && !!whatsappAwsPhone(envName);

const usesDomain = (envName: EnvName) =>
  ownsDomain || (!!account && (DOMAIN_ENVS[account] ?? []).includes(envName));

// www = the public marketing site (home page, pricing); portal = the signed-in
// customer app; bms = the internal Business Management System. Three separate
// apps, three separate distributions — they just happen to share a hosted
// zone and cert.
//
// The portal used to double as the marketing site, serving index.html at its
// root. That moved to www so the portal host is only ever the app: its root
// serves login.html instead (see defaultRootObject below), and it carries no
// marketing content of its own any more.
//
// In prod the app lives on the bare domain — cloudmeter.io — and the old
// portal.cloudmeter.io host is kept alive purely as a 301 to it. Every alert
// digest, renewal reminder and handover email already sent carries a
// portal.cloudmeter.io link, and those have to keep working; retiring the
// hostname outright would break them for no gain, since the app is no longer
// served there either way. dev keeps the sub-domain layout unchanged.
// portal stays first in each list deliberately: CertStack takes
// domainNames[0] as the certificate's primary DomainName, and adding www as a
// second entry makes the diff "add a SAN" — first would make it "replace the
// primary domain," a bigger and entirely avoidable change for the same
// resulting certificate.
interface SiteDef {
  siteName: string;
  domainName: string;
  defaultRootObject?: string;
  /** Additional hostnames the same distribution answers on. */
  extraDomainNames?: string[];
}
const sitesByEnv: Record<EnvName, SiteDef[]> = {
  dev: [
    { siteName: 'portal', domainName: 'dev.portal.cloudmeter.io', defaultRootObject: 'login.html' },
    { siteName: 'bms', domainName: 'dev.bms.cloudmeter.io' },
    { siteName: 'www', domainName: 'dev.www.cloudmeter.io' },
  ],
  // Laid out like dev. Until cloudmeter.io moves to the account running UAT,
  // these names only feed the API's allowed origins; the sites themselves
  // answer on their CloudFront hostnames.
  uat: [
    { siteName: 'portal', domainName: 'uat.portal.cloudmeter.io', defaultRootObject: 'login.html' },
    { siteName: 'bms', domainName: 'uat.bms.cloudmeter.io' },
    { siteName: 'www', domainName: 'uat.www.cloudmeter.io' },
  ],
  prod: [
    { siteName: 'portal', domainName: 'portal.cloudmeter.io', defaultRootObject: 'login.html' },
    { siteName: 'bms', domainName: 'bms.cloudmeter.io' },
    // The bare domain serves the marketing site itself rather than bouncing to
    // www. A visitor who types cloudmeter.io is the commonest arrival there is,
    // and a redirect costs them a round trip to see the same page; one
    // distribution answering on both names has one cache and one deploy.
    // Sign-in and sign-up from here link out to the portal, which keeps its own
    // host — the app is not served on the bare domain.
    { siteName: 'www', domainName: 'www.cloudmeter.io', extraDomainNames: ['cloudmeter.io'] },
  ],
};

// Populated by the per-env loop below (portal and bms only — the two sites
// CiDeployStack grants GitHub Actions access to); read after the loop.
const frontendStacksByEnv: Record<EnvName, { portal?: FrontendStack; bms?: FrontendStack }> = {
  dev: {},
  uat: {},
  prod: {},
};

for (const envName of envNames) {
  const suffix = envName.charAt(0).toUpperCase() + envName.slice(1);
  const sites = sitesByEnv[envName];
  // The redirect-only distribution, and what it points at, differ by env.
  //
  // prod: the app now answers on the bare domain, so the thing needing a
  // redirect is the *old* host — portal.cloudmeter.io — which forwards to it.
  // dev:  the bare dev domain still redirects to dev's www, as before.
  // Feeds the cert's SAN list either way. In dev it's also the redirect
  // stack's own domain; in prod the apex is instead an alias on the www
  // distribution (see extraDomainNames above), added by hand to avoid a
  // second cert replacement — this repo's cert-stack change is the one
  // change here already proven to hang (see CLAUDE.md / memory).
  const redirectDomain = envName === 'prod' ? 'cloudmeter.io' : `${envName}.cloudmeter.io`;
  // The certificate's primary DomainName is domainNames[0], and changing it
  // forces a replacement by itself — on top of the replacement any SAN edit
  // already causes. portal.cloudmeter.io was the primary and is still in use
  // as prod's redirect host, so it stays first and the bare domain joins as a
  // SAN. dev is unchanged: its primary was already dev.portal.
  const domainNames = [...sites.map((s) => s.domainName), redirectDomain];

  // A certificate exists to put a domain on a distribution, so it follows the
  // zone: no zone, no custom hostnames, nothing for a certificate to cover.
  const certStack = dnsStack
    ? new CertStack(app, `CloudMeterCertStack${suffix}`, {
      env: usEast1Env,
      crossRegionReferences: true,
      hostedZone: dnsStack.hostedZone,
      domainNames,
    })
    : undefined;
  const certificateArn = account ? IMPORTED_CERTIFICATES[account]?.[envName] : undefined;

  // Collected so every stack in this environment also gets an Environment tag —
  // dev and prod share one AWS account, and without it their costs are
  // indistinguishable.
  // certStack is absent where CloudMeter does not own the domain.
  const envStacks: cdk.Stack[] = certStack ? [certStack] : [];

  const dataStack = new DataStack(app, `CloudMeterDataStack${suffix}`, { env, envName });
  envStacks.push(dataStack);

  const authStack = new AuthStack(app, `CloudMeterAuthStack${suffix}`, {
    env,
    envName,
    table: dataStack.table,
    otpFromEmail,
    /*
     * The app-store review login, in both environments.
     *
     * The mobile app ships pointing at prod, so Apple's and Google's reviewers
     * sign in against prod — a dev-only login would not help them. Dev carries
     * the same values so the flow can be exercised without touching prod.
     *
     * Deleting these two lines removes the login from both.
     */
    demoLoginEmail: 'appreview@cloudmeter.io',
    demoLoginCode: '061628',
  });
  envStacks.push(authStack);

  const bmsAuthStack = new BmsAuthStack(app, `CloudMeterBmsAuthStack${suffix}`, {
    env,
    envName,
    table: dataStack.table,
    otpFromEmail,
  });
  envStacks.push(bmsAuthStack);

  const notificationsStack = new NotificationsStack(app, `CloudMeterNotificationsStack${suffix}`, {
    env,
    envName,
    table: dataStack.table,
    otpFromEmail,
    portalUrl: portalUrlOverride ?? `https://${sites.find((s) => s.siteName === 'portal')!.domainName}`,
    /*
     * Dev's automated mail goes to one inbox instead of the customer's.
     *
     * SES has production access here with no sandbox, so dev reaches real
     * addresses exactly as prod does. On 2026-09-27 dev's renewal sweep told a
     * real person their CloudMeter subscription had ended — true of a dev
     * workspace whose plan had been typed into BMS and never bought, and
     * indistinguishable from a genuine billing email.
     *
     * Deliberately absent for prod. A redirect there would divert customers'
     * billing and alert mail away from the people it concerns, which is a
     * worse failure than the one it prevents.
     *
     * UAT gets it too, and needs it more: it is where copied production data
     * gets rehearsed, so its workspaces hold real customers' addresses.
     */
    ...(envName !== 'prod' ? { notificationRedirectTo: 'neeta@mobil80.com' } : {}),
    schedulesEnabled: !schedulesPaused(envName),
    customerBridgeRoleArn,
    whatsappAwsPhoneNumberId: whatsappAwsPhone(envName),
  });
  envStacks.push(notificationsStack);

  if (runsAssistant(envName)) {
    envStacks.push(new AssistantStack(app, `CloudMeterAssistantStack${suffix}`, {
      env,
      envName,
      table: dataStack.table,
      whatsappAwsPhoneNumberId: whatsappAwsPhone(envName)!,
    }));
  }

  envStacks.push(new ApiStack(app, `CloudMeterApiStack${suffix}`, {
    env,
    envName,
    table: dataStack.table,
    whatsappSecret: notificationsStack.whatsappSecret,
    slackSecret: notificationsStack.slackSecret,
    stripeSecret: notificationsStack.stripeSecret,
    razorpaySecret: notificationsStack.razorpaySecret,
    userPool: authStack.userPool,
    userPoolClient: authStack.userPoolClient,
    mobileUserPoolClient: authStack.mobileUserPoolClient,
    bmsUserPool: bmsAuthStack.userPool,
    bmsUserPoolClient: bmsAuthStack.userPoolClient,
    otpFromEmail,
    portalUrl: portalUrlOverride ?? `https://${sites.find((s) => s.siteName === 'portal')!.domainName}`,
    bmsUrl: bmsUrlOverride ?? `https://${sites.find((s) => s.siteName === 'bms')!.domainName}`,
    // Every host this environment actually serves, including the bare prod
    // domain — the marketing site calls /plans, so www belongs here too.
    customerBridgeRoleArn,
    whatsappAwsPhoneNumberId: whatsappAwsPhone(envName),
    webOrigins: [
      ...sites.flatMap((s) => [s.domainName, ...(s.extraDomainNames ?? [])]).map((d) => `https://${d}`),
      ...siteOrigins,
    ],
  }));

  envStacks.push(new AppSyncStack(app, `CloudMeterAppSyncStack${suffix}`, {
    env,
    envName,
    table: dataStack.table,
    userPool: authStack.userPool,
  }));

  for (const site of sites) {
    const siteSuffix = site.siteName.charAt(0).toUpperCase() + site.siteName.slice(1);
    const frontendStack = new FrontendStack(app, `CloudMeterFrontendStack${siteSuffix}${suffix}`, {
      env,
      envName,
      crossRegionReferences: true,
      // All three absent together outside the domain-owning account, which
      // leaves the distribution on its own *.cloudfront.net name and writes no
      // DNS records anywhere — see FrontendStack.
      hostedZone: dnsStack?.hostedZone,
      certificate: certStack?.certificate,
      certificateArn: !certStack && usesDomain(envName) ? certificateArn : undefined,
      siteName: site.siteName,
      domainName: usesDomain(envName) ? site.domainName : undefined,
      extraDomainNames: site.extraDomainNames,
      defaultRootObject: site.defaultRootObject,
    });
    envStacks.push(frontendStack);
    // portal and bms feed CiDeployStack below, which needs both envs'
    // buckets/distributions at once and so lives outside this per-env loop.
    if (site.siteName === 'portal') frontendStacksByEnv[envName].portal = frontendStack;
    if (site.siteName === 'bms') frontendStacksByEnv[envName].bms = frontendStack;
  }

  // Only dev still needs a redirect distribution. In prod the bare domain is an
  // alias on the www distribution itself (see extraDomainNames above), so a
  // redirect stack would try to claim a hostname that is already spoken for and
  // fail with a CNAME conflict against our own infrastructure.
  // Its entire job is to answer on a cloudmeter.io hostname and 301 away, so
  // outside the account holding that domain there is nothing for it to do.
  if (envName !== 'prod' && dnsStack && certStack) {
    envStacks.push(new RedirectStack(app, `CloudMeterRedirectStack${suffix}`, {
      env,
      crossRegionReferences: true,
      hostedZone: dnsStack.hostedZone,
      certificate: certStack.certificate,
      domainName: redirectDomain,
      redirectHost: sites.find((s) => s.siteName === 'www')!.domainName,
    }));
  }

  envStacks.forEach((stack) => cdk.Tags.of(stack).add('Environment', envName));
}

// Grants GitHub Actions (via OIDC) permission to deploy the portal and bms
// frontends — spans both environments, so it lives outside the loop above.
new CiDeployStack(app, 'CloudMeterCiDeployStack', {
  env,
  portalDev: frontendStacksByEnv.dev.portal!,
  portalProd: frontendStacksByEnv.prod.portal!,
  bmsDev: frontendStacksByEnv.dev.bms!,
  bmsProd: frontendStacksByEnv.prod.bms!,
});
