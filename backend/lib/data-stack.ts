import { Stack, StackProps, RemovalPolicy, Duration, Aws } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { EnvProps, suffix, s3Suffix } from './env-config';

export interface DataStackProps extends StackProps, EnvProps {}

export class DataStack extends Stack {
  public readonly table: dynamodb.Table;
  public readonly rawCostBucket: s3.Bucket;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.encryptionKey = new kms.Key(this, 'CloudMeterDataKey', {
      description: `CloudMeter DynamoDB + S3 encryption key (${envName})`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table = new dynamodb.Table(this, 'CloudMeterTable', {
      tableName: `cloudmeter${suffix(envName)}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // GSI1: USER#<userId> -> TENANT#<tenantId> — resolve the caller's current
    // tenant + role on every request (see packages/authz in a later phase).
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2: EMAIL#<email> -> TENANT#<tenantId> — used by PostConfirmation to
    // detect a pending team invite for a newly-confirmed email.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI3: sparse index, CloudAccount items only — lets the hourly ingestion
    // lister enumerate active accounts across all tenants without a scan.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
    });

    // S3 bucket names can't contain underscores and must be globally
    // unique, so the account id is baked in alongside the -dev/-prod suffix.
    this.rawCostBucket = new s3.Bucket(this, 'RawCostArchiveBucket', {
      bucketName: `cloudmeter-raw-cost${s3Suffix(envName)}-${Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
