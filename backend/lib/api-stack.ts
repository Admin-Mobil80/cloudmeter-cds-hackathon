import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';
import { allowAwsWhatsApp } from './notifications-stack';

export interface ApiStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  whatsappSecret: secretsmanager.ISecret;
  slackSecret: secretsmanager.ISecret;
  stripeSecret: secretsmanager.ISecret;
  razorpaySecret: secretsmanager.ISecret;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  mobileUserPoolClient: cognito.UserPoolClient;
  /** The staff console's own pool — a portal token must never reach /bms/*. */
  bmsUserPool: cognito.UserPool;
  bmsUserPoolClient: cognito.UserPoolClient;
  otpFromEmail: string;
  portalUrl: string;
  bmsUrl: string;
  /**
   * Every browser origin allowed to call this API. CORS was `*`, which let any
   * page on the internet issue authenticated requests on behalf of a token it
   * managed to obtain. Tokens live in localStorage rather than cookies, so a
   * wildcard is not directly exploitable, but there is no reason to leave the
   * door open — these are the only origins that exist.
   */
  webOrigins: string[];
  /**
   * Role in the previous CloudMeter account through which customer roles that
   * still trust that account are reached. Temporary; see
   * functions/shared/assume-customer-role.ts.
   */
  customerBridgeRoleArn?: string;
  /**
   * AWS id (`phone-number-id-…`) of the WhatsApp number linked to AWS End User
   * Messaging Social. When set, WhatsApp goes out through AWS instead of
   * Meta's API. Deliberately unset for UAT: it holds real customers' numbers,
   * and its empty Meta secret is what keeps it from messaging them.
   */
  whatsappAwsPhoneNumberId?: string;
  /**
   * Name of the approved digest template with a "Top services" line. When
   * unset, digests use the original cloudmeter_daily_digest.
   */
  whatsappDigestTemplateWithServices?: string;
}

export class ApiStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;
  private readonly table: dynamodb.Table;
  private readonly sfx: string;
  private readonly bridgeEnv: Record<string, string>;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      table, userPool, userPoolClient, mobileUserPoolClient, bmsUserPool, bmsUserPoolClient,
      envName, otpFromEmail, portalUrl, bmsUrl, webOrigins,
      whatsappSecret, slackSecret, stripeSecret, razorpaySecret,
    } = props;
    this.table = table;
    this.sfx = suffix(envName);
    this.bridgeEnv = props.customerBridgeRoleArn
      ? { CUSTOMER_BRIDGE_ROLE_ARN: props.customerBridgeRoleArn }
      : {};

    // Both clients share one pool, so one token shape and one authorizer
    // covers web and mobile — accepting either client's ID as a valid
    // audience is what makes a mobile-issued token satisfy this authorizer.
    const authorizer = new authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId, mobileUserPoolClient.userPoolClientId] },
    );

    // A second authorizer, bound to the BMS pool. Separate pools mean a
    // customer's token cannot satisfy it however the routes are later edited.
    const bmsAuthorizer = new authorizers.HttpJwtAuthorizer(
      'BmsCognitoAuthorizer',
      bmsUserPool.userPoolProviderUrl,
      { jwtAudience: [bmsUserPoolClient.userPoolClientId] },
    );

    this.httpApi = new apigwv2.HttpApi(this, 'CloudMeterHttpApi', {
      apiName: `cloudmeter-api${this.sfx}`,
      corsPreflight: {
        allowOrigins: webOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    /**
     * Account-level API Gateway limits are the only thing bounding this API
     * today, and they are far above anything CloudMeter does — which means a
     * public route like /auth/prepare-signin can be hammered essentially
     * without limit. It calls Cognito and DynamoDB on every request, and the
     * sign-in flow behind it sends email.
     *
     * Set well above real traffic: this is an abuse ceiling, not a quota, and
     * normal use must never reach it.
     */
    const stage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: 200,
      ThrottlingBurstLimit: 400,
    });

    // /me
    this.route('/me', [apigwv2.HttpMethod.GET], 'Me', 'api/me', authorizer);
    // Which CloudMeter account the caller is working in, when they're in several.
    this.route('/me/active-account', [apigwv2.HttpMethod.PUT], 'MeActiveAccount', 'api/me/active-account', authorizer);

    // Assuming read-only roles in arbitrary customer AWS accounts is the
    // core function of the product, so the resource can't be narrowed to
    // known ARNs — the External ID condition in each customer's own trust
    // policy is what actually gates access.
    const assumeCustomerRole = new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['arn:aws:iam::*:role/*'],
    });

    // Customer cloud credentials live in Secrets Manager, one secret per
    // connected account, namespaced by tenant.
    const secretArnPattern = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/tenant/*`;
    const readCustomerSecrets = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [secretArnPattern],
    });
    const writeCustomerSecrets = new iam.PolicyStatement({
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:TagResource'],
      // CreateSecret is evaluated before the secret exists, so it can't be
      // scoped to a concrete ARN; the name prefix is enforced in code.
      resources: ['*'],
    });
    const deleteCustomerSecrets = new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      resources: [secretArnPattern],
    });

    // Deliberately PUBLIC: the marketing pricing page renders from this too,
    // and it carries nothing customer-specific.
    this.route('/plans', [apigwv2.HttpMethod.GET], 'Plans', 'api/plans', null);

    // /providers — credential-field metadata driving the connect form
    this.route('/providers', [apigwv2.HttpMethod.GET], 'Providers', 'api/providers', authorizer);

    // /accounts
    this.route('/accounts', [apigwv2.HttpMethod.GET], 'AccountsList', 'api/accounts/list', authorizer);
    this.route('/accounts/connect-params', [apigwv2.HttpMethod.POST], 'AccountsConnectParams', 'api/accounts/connect-params', authorizer, {
      CLOUDMETER_ACCOUNT_ID: this.account,
    });
    // 60s: a real cost pull spans 6 months plus per-tag/label dimensions,
    // which is well past the default 10s on every provider.
    const accountsCreateFn = this.route('/accounts', [apigwv2.HttpMethod.POST], 'AccountsCreate', 'api/accounts/create', authorizer, undefined, 60);
    accountsCreateFn.addToRolePolicy(assumeCustomerRole);
    accountsCreateFn.addToRolePolicy(writeCustomerSecrets);
    accountsCreateFn.addToRolePolicy(deleteCustomerSecrets);
    const accountsRefreshFn = this.route('/accounts/{accountId}/refresh', [apigwv2.HttpMethod.POST], 'AccountsRefresh', 'api/accounts/refresh', authorizer, undefined, 60);
    accountsRefreshFn.addToRolePolicy(assumeCustomerRole);
    accountsRefreshFn.addToRolePolicy(readCustomerSecrets);
    this.route('/accounts/{accountId}', [apigwv2.HttpMethod.GET], 'AccountsGet', 'api/accounts/get', authorizer);
    // Reassigning an account mails both the outgoing and incoming manager, so
    // this route needs SES and the same from/portal settings the digest uses.
    const accountsUpdateFn = this.route('/accounts/{accountId}', [apigwv2.HttpMethod.PATCH], 'AccountsUpdate', 'api/accounts/update', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    }, 15);
    accountsUpdateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    const accountsDeleteFn = this.route('/accounts/{accountId}', [apigwv2.HttpMethod.DELETE], 'AccountsDelete', 'api/accounts/delete', authorizer);
    accountsDeleteFn.addToRolePolicy(deleteCustomerSecrets);
    this.route('/accounts/{accountId}/cost/services', [apigwv2.HttpMethod.GET], 'CostServices', 'api/accounts/cost-services', authorizer);
    this.route('/accounts/{accountId}/cost/tags', [apigwv2.HttpMethod.GET], 'CostTags', 'api/accounts/cost-tags', authorizer);

    /**
     * Subscriptions inside an "Adhoc Spend" account. One handler for all four
     * verbs — they share their validation and every write recomputes the same
     * six-month window, so splitting them would be three copies of the same
     * file and three more IAM roles for no gain.
     */
    const adhocItemsFn = this.route('/accounts/{accountId}/adhoc-items',
      [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], 'AdhocItems', 'api/adhoc-items', authorizer);

    // The per-item path reuses the same function rather than getting its own.
    // This stack is at ~420 of CloudFormation's 500-resource ceiling, and a
    // second Lambda for the same handler would spend roughly ten of them —
    // role, policy, log group, permissions, integration — to run identical
    // code.
    this.httpApi.addRoutes({
      path: '/accounts/{accountId}/adhoc-items/{itemId}',
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: new integrations.HttpLambdaIntegration('AdhocItemIntegration', adhocItemsFn),
      authorizer,
    });
    this.route('/accounts/{accountId}/cost/history', [apigwv2.HttpMethod.GET], 'CostHistory', 'api/accounts/cost-history', authorizer);
    this.route('/accounts/{accountId}/cost/daily', [apigwv2.HttpMethod.GET], 'CostDaily', 'api/accounts/cost-daily', authorizer);
    // Reads stored daily rows only — no extra metered provider call.
    this.route('/accounts/{accountId}/cost/compare', [apigwv2.HttpMethod.GET], 'CostCompare', 'api/accounts/cost-compare', authorizer);
    this.route('/accounts/{accountId}/cost/regions', [apigwv2.HttpMethod.GET], 'CostRegions', 'api/accounts/cost-regions', authorizer);

    // /dashboard
    this.route('/dashboard/summary', [apigwv2.HttpMethod.GET], 'DashboardSummary', 'api/dashboard-summary', authorizer);
    this.route('/dashboard/daily', [apigwv2.HttpMethod.GET], 'DashboardDaily', 'api/dashboard-daily', authorizer, undefined, 30);
    // Fans out one read per account, same as /dashboard/daily, so it gets the
    // same longer timeout rather than the default.
    this.route('/dashboard/regions', [apigwv2.HttpMethod.GET], 'DashboardRegions', 'api/dashboard-regions', authorizer, undefined, 30);

    // /notifications — a preview of the daily digest, sent only to the caller.
    const testDigestFn = this.route('/notifications/test-digest', [apigwv2.HttpMethod.POST], 'NotificationsTestDigest', 'api/notifications-test-digest', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
      WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
    }, 30);
    whatsappSecret.grantRead(testDigestFn);
    allowAwsWhatsApp(testDigestFn, props.whatsappAwsPhoneNumberId);
    if (props.whatsappDigestTemplateWithServices) {
      testDigestFn.addEnvironment('WHATSAPP_DIGEST_TEMPLATE_WITH_SERVICES', props.whatsappDigestTemplateWithServices);
    }
    testDigestFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // WhatsApp number verification. Sending needs the Cloud API credentials;
    // verifying only reads what we already stored.
    const waStartFn = this.route('/notifications/whatsapp/start', [apigwv2.HttpMethod.POST], 'NotificationsWhatsappStart', 'api/notifications-whatsapp-start', authorizer, {
      WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
    }, 15);
    whatsappSecret.grantRead(waStartFn);
    allowAwsWhatsApp(waStartFn, props.whatsappAwsPhoneNumberId);
    this.route('/notifications/whatsapp/verify', [apigwv2.HttpMethod.POST], 'NotificationsWhatsappVerify', 'api/notifications-whatsapp-verify', authorizer);

    // Connecting Slack needs the workspace's bot token: it asks Slack to match
    // the caller's email and opens the DM to post in.
    const slackConnectFn = this.route('/notifications/slack/connect', [apigwv2.HttpMethod.POST], 'NotificationsSlackConnect', 'api/notifications-slack-connect', authorizer, {
      SLACK_SECRET_ARN: slackSecret.secretArn,
    }, 15);
    slackSecret.grantRead(slackConnectFn);
    // One secret per tenant, namespaced; the concrete name is not known at
    // synth time. See functions/shared/slack.ts.
    slackConnectFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/slack/tenant/*`],
    }));

    /*
     * Installing CloudMeter into a workspace's Slack.
     *
     * `start` is authenticated and Owner/Admin-only; `callback` is public
     * because Slack redirects a browser to it carrying no CloudMeter
     * credentials, exactly like the billing webhooks above. The callback's
     * security is the single-use state the start endpoint issued.
     *
     * The redirect URI must match what is registered on the Slack app, so it
     * is passed explicitly rather than derived from the request — a mismatch
     * is rejected by Slack and is not worth making dependent on how the
     * request happened to arrive.
     */
    const slackRedirectUri = `${this.httpApi.apiEndpoint}/slack/oauth/callback`;
    const slackOauthStartFn = this.route('/slack/oauth/start', [apigwv2.HttpMethod.POST], 'SlackOauthStart', 'api/slack-oauth-start', authorizer, {
      SLACK_SECRET_ARN: slackSecret.secretArn,
      SLACK_REDIRECT_URI: slackRedirectUri,
    }, 15);
    slackSecret.grantRead(slackOauthStartFn);

    const slackOauthCallbackFn = this.route('/slack/oauth/callback', [apigwv2.HttpMethod.GET], 'SlackOauthCallback', 'api/slack-oauth-callback', null, {
      SLACK_SECRET_ARN: slackSecret.secretArn,
      SLACK_REDIRECT_URI: slackRedirectUri,
      PORTAL_URL: portalUrl,
    }, 20);
    slackSecret.grantRead(slackOauthCallbackFn);
    // Writes one tenant's own secret. CreateSecret is evaluated before the
    // secret exists so it cannot be scoped to a concrete ARN; the name prefix
    // is enforced in code, as it is for customer cloud credentials above.
    slackOauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
    }));
    slackOauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/slack/tenant/*`],
    }));

    // Per-account notification switches, for Members who have no org-wide page.
    this.route('/accounts/{accountId}/notifications', [apigwv2.HttpMethod.PUT], 'AccountNotifications', 'api/notification-prefs/account', authorizer);

    // /billing — subscriptions via Stripe or Razorpay, decided per tenant by
    // region. Reads both gateways' secrets purely to report whether checkout
    // is usable right now (gatewayReady in the handler) — it never charges
    // anything itself. Missing the Razorpay half of this left `GET /billing`
    // reporting checkout unavailable for every Indian tenant even once
    // Razorpay was fully configured, since razorpayConfig() had no ARN to
    // read and gatewayReady() swallowed the resulting error silently.
    const billingGetFn = this.route('/billing', [apigwv2.HttpMethod.GET], 'BillingGet', 'api/billing/get', authorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      RAZORPAY_SECRET_ARN: razorpaySecret.secretArn,
    });
    stripeSecret.grantRead(billingGetFn);
    razorpaySecret.grantRead(billingGetFn);

    const checkoutFn = this.route('/billing/checkout-session', [apigwv2.HttpMethod.POST], 'BillingCheckout', 'api/billing/checkout', authorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      PORTAL_URL: portalUrl,
    }, 20);
    stripeSecret.grantRead(checkoutFn);
    checkoutFn.addEnvironment('RAZORPAY_SECRET_ARN', razorpaySecret.secretArn);
    razorpaySecret.grantRead(checkoutFn);

    const portalFn = this.route('/billing/portal-session', [apigwv2.HttpMethod.POST], 'BillingPortal', 'api/billing/portal', authorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      PORTAL_URL: portalUrl,
    }, 20);
    stripeSecret.grantRead(portalFn);

    // Owner-only cancellation at the end of the paid period, on whichever
    // gateway holds the subscription.
    const cancelFn = this.route('/billing/cancel', [apigwv2.HttpMethod.POST], 'BillingCancel', 'api/billing/cancel', authorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      RAZORPAY_SECRET_ARN: razorpaySecret.secretArn,
    }, 20);
    stripeSecret.grantRead(cancelFn);
    razorpaySecret.grantRead(cancelFn);

    // Deliberately PUBLIC: Stripe holds no credentials of ours, so the request
    // signature is the security boundary and is verified in the handler.
    const stripeWebhookFn = this.route('/webhooks/stripe', [apigwv2.HttpMethod.POST], 'StripeWebhook', 'api/billing/webhook', null, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
    }, 20);
    stripeSecret.grantRead(stripeWebhookFn);

    // /bms — the staff console. Every route behind the BMS authorizer, and
    // every handler additionally requires an active BMS user record.
    this.route('/bms/me', [apigwv2.HttpMethod.GET], 'BmsMe', 'api/bms/me', bmsAuthorizer);
    /*
     * The tenant list shows which workspaces have Slack installed. It lists
     * the per-tenant secrets by name only — ListSecrets returns no values, so
     * no token is readable here, and the console needs nothing but the names.
     */
    const bmsTenantsFn = this.route('/bms/tenants', [apigwv2.HttpMethod.GET], 'BmsTenants', 'api/bms/tenants', bmsAuthorizer, undefined, 30);
    bmsTenantsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:ListSecrets'],
      // ListSecrets is an account-level call and cannot be scoped to an ARN;
      // it returns names and metadata, never a secret's value.
      resources: ['*'],
    }));

    // Onboarding a business from the console provisions the owner's portal
    // login, so this one reaches into the customer pool.
    const bmsCreateTenantFn = this.route('/bms/tenants', [apigwv2.HttpMethod.POST], 'BmsTenantCreate', 'api/bms/tenant-create', bmsAuthorizer, {
      PORTAL_USER_POOL_ID: userPool.userPoolId,
      PORTAL_URL: portalUrl,
      OTP_FROM_EMAIL: otpFromEmail,
    }, 20);
    bmsCreateTenantFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn],
    }));
    bmsCreateTenantFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Reads the gateway before taking a tenant over by hand, so it needs both
    // gateways' keys (read-only use: one GET of the subscription).
    const bmsSubscriptionFn = this.route('/bms/tenants/{tenantId}/subscription', [apigwv2.HttpMethod.PUT], 'BmsTenantSubscription', 'api/bms/tenant-subscription', bmsAuthorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      RAZORPAY_SECRET_ARN: razorpaySecret.secretArn,
    });
    stripeSecret.grantRead(bmsSubscriptionFn);
    razorpaySecret.grantRead(bmsSubscriptionFn);

    // Irreversible: purges a whole customer account, credentials included.
    const bmsDeleteTenantFn = this.route('/bms/tenants/{tenantId}', [apigwv2.HttpMethod.DELETE], 'BmsTenantDelete', 'api/bms/tenant-delete', bmsAuthorizer, {
      PORTAL_USER_POOL_ID: userPool.userPoolId,
    }, 60);
    bmsDeleteTenantFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/tenant/*`],
    }));
    bmsDeleteTenantFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminDeleteUser'],
      resources: [userPool.userPoolArn],
    }));

    const bmsUsersEnv = {
      BMS_USER_POOL_ID: bmsUserPool.userPoolId,
      OTP_FROM_EMAIL: otpFromEmail,
      BMS_URL: bmsUrl,
    };
    for (const [id, routePath, methods] of [
      ['BmsUsersList', '/bms/users', [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]],
      ['BmsUsersDelete', '/bms/users/{email}', [apigwv2.HttpMethod.DELETE]],
    ] as Array<[string, string, apigwv2.HttpMethod[]]>) {
      const fn = this.route(routePath, methods, id, 'api/bms/users', bmsAuthorizer, bmsUsersEnv, 15);
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminDeleteUser'],
        resources: [bmsUserPool.userPoolArn],
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }));
    }

    // An additional CloudMeter account for someone who already has a login.
    // Sign-up can't serve this: it keys on the email address, which Cognito
    // already has.
    this.route('/tenants', [apigwv2.HttpMethod.POST], 'TenantsCreate', 'api/tenants/create', authorizer);

    // Public like the Stripe webhook — Razorpay has no credentials to
    // present, so the HMAC signature on the raw body is the only gate.
    const razorpayWebhookFn = this.route('/webhooks/razorpay', [apigwv2.HttpMethod.POST], 'RazorpayWebhook', 'api/billing/razorpay-webhook', null, {
      RAZORPAY_SECRET_ARN: razorpaySecret.secretArn,
    });
    razorpaySecret.grantRead(razorpayWebhookFn);

    // Which gateway the platform charges through. Staff-only via the BMS pool.
    // The AI-tool plans and list prices the Adhoc Spend form pre-fills from.
    // Reference data, so any staff login may edit it — see the handler.
    this.route('/bms/adhoc-catalog', [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT], 'BmsAdhocCatalog', 'api/bms/adhoc-catalog', bmsAuthorizer);

    // Reads both secrets, so the console can say which gateways actually have
    // credentials rather than repeating a hardcoded flag. Read-only, and it
    // reports only whether the fields are non-empty — never a value.
    const bmsPaymentSettingsFn = this.route('/bms/settings/payments', [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT], 'BmsPaymentSettings', 'api/bms/payment-settings', bmsAuthorizer, {
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      RAZORPAY_SECRET_ARN: razorpaySecret.secretArn,
    });
    stripeSecret.grantRead(bmsPaymentSettingsFn);
    razorpaySecret.grantRead(bmsPaymentSettingsFn);
    // The revenue ledger. Reads across every tenant, so it gets a longer
    // timeout than a per-tenant route would need.
    this.route('/bms/transactions', [apigwv2.HttpMethod.GET], 'BmsTransactions', 'api/bms/transactions', bmsAuthorizer, {}, 20);

    // /pricing — a cross-provider price comparison. Open to every role: a
    // Member who can't see Billing still needs to know what an instance costs
    // before launching one. Needs pricing:GetProducts for the AWS figures and
    // a longer timeout, since a cold refresh calls out to two providers.
    const pricingFn = this.route('/pricing', [apigwv2.HttpMethod.GET], 'Pricing', 'api/pricing', authorizer, {}, 30);
    pricingFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['pricing:GetProducts', 'pricing:DescribeServices'],
      resources: ['*'],
    }));

    // /alerts
    this.route('/alerts', [apigwv2.HttpMethod.GET], 'AlertsList', 'api/alerts/list', authorizer);
    this.route('/alerts/{alertId}/read', [apigwv2.HttpMethod.POST], 'AlertsRead', 'api/alerts/read', authorizer);

    // /team
    this.route('/team', [apigwv2.HttpMethod.GET], 'TeamList', 'api/team/list', authorizer);
    const teamInviteFn = this.route('/team/invite', [apigwv2.HttpMethod.POST], 'TeamInvite', 'api/team/invite', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    });
    teamInviteFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    this.route('/team/invites/{token}', [apigwv2.HttpMethod.DELETE], 'TeamInviteDelete', 'api/team/invite-delete', authorizer);
    // A role change decides what someone can reach, and it is made by somebody
    // else — so the person it happened to is emailed about it, which needs SES.
    const teamUpdateFn = this.route('/team/{userId}', [apigwv2.HttpMethod.PATCH], 'TeamUpdate', 'api/team/update', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    });
    teamUpdateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Removing someone who manages accounts hands those on and emails the new
    // manager, so this needs SES like the other team routes.
    const teamRemoveFn = this.route('/team/{userId}', [apigwv2.HttpMethod.DELETE], 'TeamRemove', 'api/team/remove', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    }, 20);
    teamRemoveFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Handing the CloudMeter account to someone else. Emails the new owner,
    // and may reassign the outgoing owner's cloud accounts, so it needs SES
    // and the same longer timeout as the removal route.
    const teamTransferFn = this.route('/team/{userId}/transfer-ownership', [apigwv2.HttpMethod.POST], 'TeamTransferOwnership', 'api/team/transfer-ownership', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    }, 20);
    teamTransferFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Which cloud accounts a Member can see. Owners/Admins are never mapped.
    // Emails the Member what changed, so it needs SES like the invite route.
    const teamAccountsFn = this.route('/team/{userId}/accounts', [apigwv2.HttpMethod.PUT], 'TeamAccounts', 'api/team/accounts', authorizer, {
      OTP_FROM_EMAIL: otpFromEmail,
      PORTAL_URL: portalUrl,
    }, 15);
    teamAccountsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // Deliberately PUBLIC: an invited teammate has no session yet, so this
    // can't sit behind the JWT authorizer. It only ever provisions an account
    // for an address that already has a pending invite (see the handler), and
    // returns an identical response either way so it can't be used to
    // enumerate invited addresses.
    const prepareSigninFn = this.route('/auth/prepare-signin', [apigwv2.HttpMethod.POST], 'AuthPrepareSignin', 'api/auth-prepare-signin', null, {
      USER_POOL_ID: userPool.userPoolId,
    });
    prepareSigninFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
      ],
      resources: [userPool.userPoolArn],
    }));

    // /me/notification-prefs
    // Reads whether this tenant has Slack set up, so the page does not offer
    // an install to a workspace already using it. Only the boolean reaches the
    // browser; the token never leaves the backend.
    const notifPrefsGetFn = this.route('/me/notification-prefs', [apigwv2.HttpMethod.GET], 'NotifPrefsGet', 'api/notification-prefs/get', authorizer);
    notifPrefsGetFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:cloudmeter/slack/tenant/*`],
    }));
    this.route('/me/notification-prefs', [apigwv2.HttpMethod.PUT], 'NotifPrefsPut', 'api/notification-prefs/put', authorizer);

    // /tenant/settings — CloudMeter-wide settings (e.g. monitoring frequency)
    this.route('/tenant/settings', [apigwv2.HttpMethod.GET], 'TenantSettingsGet', 'api/tenant-settings/get', authorizer);
    this.route('/tenant/settings', [apigwv2.HttpMethod.PUT], 'TenantSettingsPut', 'api/tenant-settings/put', authorizer);

    // Runs once after a sign-up's first authentication. Notably it does NOT use
    // resolveCaller, because its whole job is to serve a caller who has no
    // membership yet.
    this.route('/tenant/bootstrap', [apigwv2.HttpMethod.POST], 'TenantBootstrap', 'api/tenant-bootstrap', authorizer);

    // Closing a workspace purges everything irreversibly, so it gets a longer
    // timeout — it fans out across accounts, snapshots, secrets and logins.
    const tenantCloseFn = this.route('/tenant/close', [apigwv2.HttpMethod.POST], 'TenantClose', 'api/tenant-close', authorizer, {
      USER_POOL_ID: userPool.userPoolId,
    }, 120);
    tenantCloseFn.addToRolePolicy(deleteCustomerSecrets);
    tenantCloseFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminDeleteUser'],
      resources: [userPool.userPoolArn],
    }));

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
  }

  private route(
    routePath: string,
    methods: apigwv2.HttpMethod[],
    id: string,
    entryDir: string,
    // Explicitly nullable: a route may be public, but only deliberately —
    // omitting the argument entirely would make that too easy to do by
    // accident, so callers must pass null and say why.
    authorizer: authorizers.HttpJwtAuthorizer | null,
    extraEnv?: Record<string, string>,
    timeoutSeconds = 10,
  ): lambdaNode.NodejsFunction {
    const fn = new lambdaNode.NodejsFunction(this, `${id}Fn`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-${id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}${this.sfx}`,
      entry: path.join(__dirname, `../functions/${entryDir}/index.ts`),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(timeoutSeconds),
      environment: { TABLE_NAME: this.table.tableName, ...this.bridgeEnv, ...extraEnv },
    });
    this.table.grantReadWriteData(fn);

    this.httpApi.addRoutes({
      path: routePath,
      methods,
      integration: new integrations.HttpLambdaIntegration(`${id}Integration`, fn),
      ...(authorizer ? { authorizer } : {}),
    });

    return fn;
  }
}
