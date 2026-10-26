import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface NotificationsStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  otpFromEmail: string;
  portalUrl: string;
  /**
   * Where this environment's *automated* mail goes instead of the customer —
   * digests, anomaly alerts and renewal notices. Omit in production, where
   * redirecting a billing email away from the person it concerns would be a
   * serious bug. See functions/shared/email-redirect.ts.
   */
  notificationRedirectTo?: string;
  /**
   * False builds the digest, renewal and sync schedules switched off. The
   * functions still deploy and can be invoked by hand; nothing fires on its
   * own. Defaults to on. See PAUSED_SCHEDULES in bin/infra.ts.
   */
  schedulesEnabled?: boolean;
  /** See ApiStackProps.customerBridgeRoleArn. Given to the sync sweep. */
  customerBridgeRoleArn?: string;
  /** See ApiStackProps.whatsappAwsPhoneNumberId. Given to both sweeps. */
  whatsappAwsPhoneNumberId?: string;
}

/**
 * Lets a function send WhatsApp through AWS End User Messaging Social, from
 * the one linked number only. A no-op where no number is configured, which
 * leaves that environment sending through Meta's API as before.
 */
export function allowAwsWhatsApp(fn: lambda.Function, phoneNumberId: string | undefined): void {
  if (!phoneNumberId) return;
  const stack = Stack.of(fn);
  fn.addEnvironment('WHATSAPP_ORIGINATION_PHONE_ID', phoneNumberId);
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['social-messaging:SendWhatsAppMessage'],
    resources: [`arn:aws:social-messaging:${stack.region}:${stack.account}:phone-number-id/${phoneNumberId.replace(/^phone-number-id-/, '')}`],
  }));
}

/**
 * Outbound notifications. Currently the daily email digest; WhatsApp joins it
 * here once Meta approves the templates in docs/whatsapp-templates.md.
 */
export class NotificationsStack extends Stack {
  /** Shared with ApiStack, which needs it for number verification. */
  public readonly whatsappSecret: secretsmanager.Secret;
  public readonly slackSecret: secretsmanager.Secret;
  /** Shared with ApiStack, which runs checkout, the portal and the webhook. */
  public readonly stripeSecret: secretsmanager.Secret;
  public readonly razorpaySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: NotificationsStackProps) {
    super(scope, id, props);

    const { table, envName, otpFromEmail, portalUrl } = props;
    /*
     * Omitted entirely rather than set empty where no redirect is configured.
     *
     * An empty NOTIFICATION_REDIRECT_TO behaves identically — the helper reads
     * blank as "do not redirect" — but a production lambda carrying a variable
     * named "redirect customer email elsewhere" invites exactly one dangerous
     * question at 3am. Absent answers it.
     */
    const redirectEnv: Record<string, string> = props.notificationRedirectTo?.trim()
      ? { NOTIFICATION_REDIRECT_TO: props.notificationRedirectTo.trim() }
      : {};
    const sfx = suffix(envName);
    const schedulesEnabled = props.schedulesEnabled ?? true;

    // Same reasoning as the WhatsApp token, and more so: this key can move
    // money, so it is never in the repo, a CDK context value, a CloudFormation
    // parameter or a chat window. A human pastes it into Secrets Manager.
    this.stripeSecret = new secretsmanager.Secret(this, 'StripeCredentials', {
      secretName: `cloudmeter/stripe${sfx}`,
      description: 'Stripe API credentials for CloudMeter subscriptions',
      generateSecretString: {
        // Both are pasted in by hand; the generated key is unused padding so
        // that CDK has something to generate, keeping the shape self-documenting.
        secretStringTemplate: JSON.stringify({ secretKey: '', webhookSecret: '' }),
        generateStringKey: 'unusedPlaceholder',
      },
    });

    // Same reasoning as Stripe: Razorpay's key secret can move money, so it is
    // pasted into Secrets Manager by a human and never travels through code,
    // CDK context or a chat window.
    this.razorpaySecret = new secretsmanager.Secret(this, 'RazorpayCredentials', {
      secretName: `cloudmeter/razorpay${sfx}`,
      description: 'Razorpay API credentials for CloudMeter subscriptions',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ keyId: '', keySecret: '', webhookSecret: '' }),
        generateStringKey: 'unusedPlaceholder',
      },
    });

    // Created empty on purpose. The token is written straight into Secrets
    // Manager by a human — it must never pass through this repo, a CDK context
    // value, a CloudFormation parameter or a chat window, all of which end up
    // in logs or history somewhere.
    /*
     * Slack bot tokens, keyed by tenant.
     *
     * One secret holding a map rather than one secret per tenant: Secrets
     * Manager is billed per secret per month, and a map of twenty-odd tokens
     * is a few kilobytes against a 64KB limit. The trade-off is that revoking
     * one tenant's token means editing a shared value — acceptable while this
     * is counted in tens, and worth revisiting if it ever reaches hundreds.
     *
     * Created empty for the same reason as the WhatsApp one above: a token
     * must never pass through this repo, a CDK context value or a
     * CloudFormation parameter.
     *
     * `clientId` and `clientSecret` are CloudMeter's own Slack app
     * credentials, used by the install flow to exchange an OAuth code for a
     * tenant's token. `tokens` is where those tokens land, keyed by tenantId.
     */
    const slackSecret = this.slackSecret = new secretsmanager.Secret(this, 'SlackCredentials', {
      secretName: `cloudmeter/slack${sfx}`,
      description: 'Slack app credentials and per-tenant bot tokens for CloudMeter notifications',
      secretObjectValue: {},
    });

    const whatsappSecret = this.whatsappSecret = new secretsmanager.Secret(this, 'WhatsAppCredentials', {
      secretName: `cloudmeter/whatsapp${sfx}`,
      description: 'Meta WhatsApp Cloud API credentials for CloudMeter alerts',
      generateSecretString: {
        // A webhook verify token is ours to invent, so generate it rather than
        // asking someone to think one up. The rest are filled in by hand.
        secretStringTemplate: JSON.stringify({
          accessToken: '',
          phoneNumberId: '',
          wabaId: '',
          appSecret: '',
        }),
        generateStringKey: 'webhookVerifyToken',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const sweepFn = new lambdaNode.NodejsFunction(this, 'DigestSweepFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-digest-sweep${sfx}`,
      entry: path.join(__dirname, '../functions/notifications/digest-sweep/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      // Reads every tenant's stored cost rows and sends a mail per recipient.
      // Well within this today; the ceiling exists so a pathological tenant
      // can't hold the whole sweep open.
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        OTP_FROM_EMAIL: otpFromEmail,
        PORTAL_URL: portalUrl,
        WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
        ...redirectEnv,
      },
    });

    table.grantReadWriteData(sweepFn);
    sweepFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // Hourly on the half hour, not the hour. Timezones exist at :30 and :45
    // offsets — India is UTC+5:30, Nepal UTC+5:45 — so a run at :00 UTC would
    // never coincide with 10:00 local in those zones. Firing at :30 means the
    // sweep lands inside the correct local hour for every offset in use.
    new events.Rule(this, 'DigestSchedule', {
      ruleName: `cloudmeter-digest-hourly${sfx}`,
      description: 'Hourly check for tenants whose local digest hour it now is',
      schedule: events.Schedule.cron({ minute: '30' }),
      enabled: schedulesEnabled,
      targets: [new targets.LambdaFunction(sweepFn)],
    });

    // Renewal reminders. Separate from the digest sweep because it runs daily
    // rather than hourly and touches no cost data — folding it in would mean
    // 24 needless passes a day over every tenant's subscription state.
    const renewalFn = new lambdaNode.NodejsFunction(this, 'RenewalSweepFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-renewal-sweep${sfx}`,
      entry: path.join(__dirname, '../functions/notifications/renewal-sweep/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        OTP_FROM_EMAIL: otpFromEmail,
        PORTAL_URL: portalUrl,
        ...redirectEnv,
      },
    });

    table.grantReadWriteData(renewalFn);
    renewalFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // 07:00 UTC — 12:30 in India, morning to early-afternoon across the
    // timezones in use. A billing reminder that lands at 3am reads as spam and
    // is buried by the time anyone is at a desk.
    new events.Rule(this, 'RenewalSchedule', {
      ruleName: `cloudmeter-renewal-daily${sfx}`,
      description: 'Daily check for trials and subscriptions ending, or ended without renewing',
      schedule: events.Schedule.cron({ minute: '0', hour: '7' }),
      enabled: schedulesEnabled,
      targets: [new targets.LambdaFunction(renewalFn)],
    });

    // Cost ingestion on a schedule. Before this, a refresh only happened when
    // someone opened an account's page, so the monitoring frequency was a
    // ceiling rather than a cadence and untouched accounts went stale.
    const syncFn = new lambdaNode.NodejsFunction(this, 'SyncSweepFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-sync-sweep${sfx}`,
      entry: path.join(__dirname, '../functions/ingestion/sync-sweep/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      // Real cost pulls across many accounts. The handler stops starting new
      // work a minute before this, so anything left rolls into the next hour.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        TABLE_NAME: table.tableName,
        OTP_FROM_EMAIL: otpFromEmail,
        PORTAL_URL: portalUrl,
        WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
        ...redirectEnv,
        ...(props.customerBridgeRoleArn ? { CUSTOMER_BRIDGE_ROLE_ARN: props.customerBridgeRoleArn } : {}),
      },
    });

    table.grantReadWriteData(syncFn);
    whatsappSecret.grantRead(syncFn);

    /*
     * Slack bot tokens are one secret per tenant, namespaced — see
     * functions/shared/slack.ts for why a shared map was the wrong shape. The
     * name is not known at synth time, so the grant is on the namespace and
     * the prefix is enforced in code.
     */
    const slackTenantSecrets = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/slack/tenant/*`],
    });
    slackSecret.grantRead(syncFn);
    syncFn.addToRolePolicy(slackTenantSecrets);
    syncFn.addEnvironment('SLACK_SECRET_ARN', slackSecret.secretArn);
    // Anomaly detection runs at the end of each sweep and notifies on anything
    // newly raised, so this function sends as well as ingests.
    syncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    syncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['arn:aws:iam::*:role/*'],
    }));
    syncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/tenant/*`],
    }));

    // Offset from the digest sweep so the two don't contend, and so a tenant's
    // digest reads data the sync wrote rather than racing it.
    new events.Rule(this, 'SyncSchedule', {
      ruleName: `cloudmeter-sync-hourly${sfx}`,
      description: 'Hourly refresh of accounts due under their monitoring frequency',
      schedule: events.Schedule.cron({ minute: '5' }),
      enabled: schedulesEnabled,
      targets: [new targets.LambdaFunction(syncFn)],
    });

    whatsappSecret.grantRead(sweepFn);
    sweepFn.addEnvironment('WHATSAPP_SECRET_ARN', whatsappSecret.secretArn);
    allowAwsWhatsApp(sweepFn, props.whatsappAwsPhoneNumberId);
    allowAwsWhatsApp(syncFn, props.whatsappAwsPhoneNumberId);
    slackSecret.grantRead(sweepFn);
    sweepFn.addToRolePolicy(slackTenantSecrets);
    sweepFn.addEnvironment('SLACK_SECRET_ARN', slackSecret.secretArn);

    new CfnOutput(this, 'WhatsAppSecretName', {
      value: whatsappSecret.secretName,
      description: 'Populate accessToken, phoneNumberId, wabaId and appSecret here',
    });
  }
}
