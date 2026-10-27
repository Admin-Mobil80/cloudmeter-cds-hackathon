import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as esbuild from 'esbuild';
import * as path from 'path';
import { EnvProps, suffix } from './env-config';
import { allowAwsWhatsApp } from './notifications-stack';

export interface AssistantStackProps extends StackProps, EnvProps {
  table: dynamodb.Table;
  /** The AWS End User Messaging Social phone number id the assistant answers on. */
  whatsappAwsPhoneNumberId: string;
  /** Bedrock model or inference profile id. */
  modelId?: string;
  /** SES-verified sender for the invitations a WhatsApp invite sends. */
  otpFromEmail: string;
  /** The portal's address, linked from those invitations. */
  portalUrl: string;
}

/**
 * CloudMeter's WhatsApp AI cost assistant.
 *
 *   WhatsApp → AWS End User Messaging Social → SNS topic (this stack)
 *     → whatsapp-inbound Lambda → agent on Bedrock AgentCore Runtime
 *     → Claude on Amazon Bedrock, calling read-only CloudMeter tools
 *     → reply via SendWhatsAppMessage
 *
 * The topic is attached to the WhatsApp Business Account as its event
 * destination outside CloudFormation (PutWhatsAppBusinessAccountEventDestinations
 * has no CloudFormation resource); the topic ARN is an output for that step.
 *
 * Built so it cannot loop: the Lambda only reads from the topic, never
 * publishes; it has no retries and a small reserved concurrency; and its code
 * drops receipts and our own messages (functions/assistant/inbound.ts).
 */
export class AssistantStack extends Stack {
  constructor(scope: Construct, id: string, props: AssistantStackProps) {
    super(scope, id, props);
    const { table, envName } = props;
    const sfx = suffix(envName);
    const modelId = props.modelId ?? 'us.amazon.nova-2-lite-v1:0';
    // AgentCore names allow letters, digits and underscores only.
    const runtimeName = `cloudmeter_assistant_${envName}`;

    // ---- The agent, bundled into one file and deployed as a zip from S3 ----
    const bundleDir = path.join(__dirname, '../.build', `assistant-agent-${envName}`);
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../functions/assistant/agent/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      minify: true,
      legalComments: 'none',
      outfile: path.join(bundleDir, 'index.js'),
      logLevel: 'error',
    });
    const agentCode = new s3assets.Asset(this, 'AgentCode', { path: bundleDir });

    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'CloudMeter WhatsApp assistant on AgentCore: read-only table access and Bedrock model calls',
    });
    agentCode.grantRead(agentRole);
    // Read-only, as promised to customers: the assistant can look, never change.
    table.grantReadData(agentRole);
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:DescribeLogGroups'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${runtimeName}-*`,
      ],
    }));

    const runtime = new agentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: runtimeName,
      description: 'CloudMeter WhatsApp cost assistant',
      roleArn: agentRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: agentCode.s3BucketName, prefix: agentCode.s3ObjectKey } },
          runtime: 'NODE_22',
          entryPoint: ['index.js'],
        },
      },
      environmentVariables: {
        TABLE_NAME: table.tableName,
        ASSISTANT_MODEL_ID: modelId,
      },
      // Short idle timeout: a WhatsApp question is one request, and an idle
      // session left running is billed for nothing.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 1800 },
    });
    runtime.node.addDependency(agentRole);

    // ---- The letterbox: AWS End User Messaging Social publishes here ----
    const topic = new sns.Topic(this, 'WhatsAppEvents', {
      topicName: `cloudmeter-whatsapp-events${sfx}`,
      displayName: 'CloudMeter WhatsApp events',
    });
    topic.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      principals: [new iam.ServicePrincipal('social-messaging.amazonaws.com')],
      resources: [topic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    // ---- The inbound Lambda ----
    const inboundFn = new lambdaNode.NodejsFunction(this, 'InboundFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      functionName: `cloudmeter-whatsapp-inbound${sfx}`,
      entry: path.join(__dirname, '../functions/assistant/whatsapp-inbound/index.ts'),
      // SDK bundled in rather than taken from the runtime: the AgentCore client
      // is newer than some Lambda runtimes' built-in copy.
      bundling: { minify: true, sourceMap: false, target: 'node24', externalModules: [] },
      timeout: Duration.seconds(90),
      memorySize: 512,
      // Loop guards at the platform level: at most 5 copies at once, and a
      // failed run is never retried (a retry would be a second reply).
      reservedConcurrentExecutions: 5,
      retryAttempts: 0,
      environment: {
        TABLE_NAME: table.tableName,
        ASSISTANT_RUNTIME_ARN: runtime.attrAgentRuntimeArn,
        ASSISTANT_HOURLY_LIMIT: '20',
        // See REPLY_TO_UNKNOWN in the handler: only prod answers strangers.
        ASSISTANT_REPLY_TO_UNKNOWN: String(envName === 'prod'),
        // For team invites started on WhatsApp (functions/assistant/invite-flow.ts).
        OTP_FROM_EMAIL: props.otpFromEmail,
        PORTAL_URL: props.portalUrl,
      },
    });
    table.grantReadWriteData(inboundFn);
    // The invitation email itself, sent the same way the portal's invite sends it.
    inboundFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    allowAwsWhatsApp(inboundFn, props.whatsappAwsPhoneNumberId);
    inboundFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/*`],
    }));
    topic.addSubscription(new subs.LambdaSubscription(inboundFn));

    // A runaway is visible within minutes. Every WhatsApp message CloudMeter
    // sends comes back as 2-3 receipts (ignored, but each is a run), so the
    // evening digest alone is ~150 runs; a loop would pass 500 in seconds.
    new cloudwatch.Alarm(this, 'InboundRunaway', {
      alarmName: `cloudmeter-whatsapp-inbound-runaway${sfx}`,
      alarmDescription: 'The WhatsApp assistant Lambda is running far more often than conversations explain; check for a loop.',
      metric: inboundFn.metricInvocations({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 500,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'WhatsAppEventsTopicArn', { value: topic.topicArn });
    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.attrAgentRuntimeArn });
  }
}
