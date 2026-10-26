import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface BmsAuthStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  otpFromEmail: string;
}

/**
 * Sign-in for the Business Management System — CloudMeter's own staff console.
 *
 * A separate user pool from the customer portal, deliberately. Staff and
 * customers are different populations with different rules, and one pool would
 * mean a customer's sign-up could, through any future bug in role handling,
 * become an identity the staff console recognises. Two pools makes that
 * impossible rather than merely unlikely.
 *
 * Self sign-up is off: a BMS identity only ever exists because an existing BMS
 * user created it. The sign-in mechanism itself is the same passwordless email
 * OTP the portal uses — the challenge Lambdas are pool-agnostic, so this stack
 * runs its own copies rather than sharing instances across pools.
 */
export class BmsAuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: BmsAuthStackProps) {
    super(scope, id, props);

    const { table, otpFromEmail, envName } = props;
    const sfx = suffix(envName);

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    };

    const defineAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'BmsDefineAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-bms-define-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/define-auth-challenge/index.ts'),
    });

    const createAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'BmsCreateAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-bms-create-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/create-auth-challenge/index.ts'),
      timeout: Duration.seconds(15),
      environment: { ...fnDefaults.environment, OTP_FROM_EMAIL: otpFromEmail },
    });
    createAuthChallengeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const verifyAuthChallengeFn = new lambdaNode.NodejsFunction(this, 'BmsVerifyAuthChallengeFn', {
      ...fnDefaults,
      functionName: `cloudmeter-bms-verify-auth-challenge${sfx}`,
      entry: path.join(__dirname, '../functions/auth/verify-auth-challenge/index.ts'),
    });

    for (const fn of [defineAuthChallengeFn, createAuthChallengeFn, verifyAuthChallengeFn]) {
      table.grantReadWriteData(fn);
    }

    this.userPool = new cognito.UserPool(this, 'BmsUserPool', {
      userPoolName: `cloudmeter-bms-users${sfx}`,
      // The whole point: nobody can create themselves an internal identity.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: {
        defineAuthChallenge: defineAuthChallengeFn,
        createAuthChallenge: createAuthChallengeFn,
        verifyAuthChallengeResponse: verifyAuthChallengeFn,
      },
      // Staff identities outlive any one deploy; losing them would lock
      // everyone out of the console with no self-serve way back in.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('BmsWebClient', {
      userPoolClientName: `cloudmeter-bms-web-client${sfx}`,
      authFlows: { custom: true },
      generateSecret: false,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
    });
  }
}
