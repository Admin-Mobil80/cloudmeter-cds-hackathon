import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface AuthStackProps extends StackProps, EnvProps {
  /**
   * Address that signs in with a fixed code instead of an emailed one, for
   * Apple's and Google's reviewers. Omit to disable the path entirely.
   */
  demoLoginEmail?: string;
  /** The fixed code that address accepts. Omit to disable. */
  demoLoginCode?: string;
  table: dynamodb.Table;
  otpFromEmail: string;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly mobileUserPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { table, otpFromEmail, envName } = props;

    /*
     * The app-store review login, empty unless this environment sets it.
     *
     * Kept per-environment rather than global so dev can carry one while prod
     * does not, and so removing it from prod after approval is a one-line
     * change here rather than an edit to the auth handler.
     */
    const demoLoginEmail = props.demoLoginEmail ?? '';
    const demoLoginCode = props.demoLoginCode ?? '';
    const sfx = suffix(envName);

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    };

    const preSignUpFn = new lambdaNode.NodejsFunction(this, 'PreSignUpFn', {
      ...fnDefaults,
      functionName: `cloudmeter-pre-sign-up${sfx}`,
      entry: path.join(__dirname, '../functions/auth/pre-sign-up/index.ts'),
    });

    const defineAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'DefineAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-define-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/define-auth-challenge/index.ts'),
    });

    const createAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'CreateAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-create-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/create-auth-challenge/index.ts'),
      timeout: Duration.seconds(15),
      environment: {
        ...fnDefaults.environment,
        OTP_FROM_EMAIL: otpFromEmail,
        /*
         * The app-store review login — see the comment in
         * create-auth-challenge for why it exists and how it is contained.
         *
         * Deliberately plain values rather than a secret. They are handed to
         * Apple and Google in a form field and typed by strangers, so they are
         * not confidential in any useful sense; keeping them here makes the
         * login greppable, reviewable in a diff, and removable by deleting
         * four lines. Blank in an environment that has not set them, which
         * disables the path entirely.
         *
         * The workspace behind this login holds generated sample data and no
         * cloud credentials. Delete both values once the apps are approved if
         * you would rather it did not stand.
         */
        DEMO_LOGIN_EMAIL: demoLoginEmail,
        DEMO_LOGIN_CODE: demoLoginCode,
      },
    });
    createAuthChallengeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const verifyAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'VerifyAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-verify-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/verify-auth-challenge/index.ts'),
    });

    const postConfirmationFn = new lambdaNode.NodejsFunction(this, 'PostConfirmationFn', {
      ...fnDefaults,
      functionName: `cloudmeter-post-confirmation${sfx}`,
      entry: path.join(__dirname, '../functions/auth/post-confirmation/index.ts'),
    });

    for (const fn of [defineAuthChallengeFn, createAuthChallengeFn, verifyAuthChallengeFn, postConfirmationFn]) {
      table.grantReadWriteData(fn);
    }

    this.userPool = new cognito.UserPool(this, 'CloudMeterUserPool', {
      userPoolName: `cloudmeter-users${sfx}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preSignUp: preSignUpFn,
        defineAuthChallenge: defineAuthChallengeFn,
        createAuthChallenge: createAuthChallengeFn,
        verifyAuthChallengeResponse: verifyAuthChallengeFn,
        postConfirmation: postConfirmationFn,
      },
    });

    // Public SPA client: custom-auth (OTP) only, no password-based flows.
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `cloudmeter-web-client${sfx}`,
      authFlows: { custom: true },
      generateSecret: false,
      refreshTokenValidity: Duration.days(30),
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
    });

    // Same pool as WebClient — one CloudMeter login works on both — but its
    // own client so the mobile app's tokens can be revoked, and its token
    // lifetimes tuned, independently of the web portal's.
    this.mobileUserPoolClient = this.userPool.addClient('MobileClient', {
      userPoolClientName: `cloudmeter-mobile-client${sfx}`,
      authFlows: { custom: true },
      generateSecret: false,
      refreshTokenValidity: Duration.days(30),
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
    });
  }
}
