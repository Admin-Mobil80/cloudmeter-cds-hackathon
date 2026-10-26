import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';

export interface AppSyncStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  userPool: cognito.UserPool;
}

export class AppSyncStack extends Stack {
  public readonly api: appsync.GraphqlApi;

  constructor(scope: Construct, id: string, props: AppSyncStackProps) {
    super(scope, id, props);

    const { table, userPool, envName } = props;
    const sfx = suffix(envName);

    this.api = new appsync.GraphqlApi(this, 'CloudMeterGraphqlApi', {
      name: `cloudmeter-graphql${sfx}`,
      definition: appsync.Definition.fromFile(path.join(__dirname, '../graphql/schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
      },
      logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR },
    });

    // Proof-of-life resolver only — the full GraphQL domain schema (accounts,
    // cost, alerts, team, notifications) is a later-phase addition once the
    // REST API surface it mirrors is built out.
    const meFn = new lambdaNode.NodejsFunction(this, 'AppSyncMeFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-appsync-me${sfx}`,
      entry: path.join(__dirname, '../functions/appsync/me/index.ts'),
      bundling: { minify: true, sourceMap: false, target: 'node24' },
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadData(meFn);

    const meDataSource = this.api.addLambdaDataSource('MeDataSource', meFn);
    meDataSource.createResolver('MeResolver', { typeName: 'Query', fieldName: 'me' });

    new CfnOutput(this, 'GraphqlApiUrl', { value: this.api.graphqlUrl });
  }
}
