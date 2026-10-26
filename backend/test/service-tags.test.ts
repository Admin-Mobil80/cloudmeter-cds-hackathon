import { App, Stack, Tags, Aspects } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Table, AttributeType } from 'aws-cdk-lib/aws-dynamodb';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ServiceNameTagger, serviceNameOf, SERVICE_TAG_KEY } from '../lib/service-tags';

/**
 * The tag this produces is meant to answer "what is CloudMeter spending on
 * Lambda?" in Cost Explorer. A wrong or missing value there is invisible — the
 * bill still adds up, it just can't be broken down — so it is worth pinning.
 */

describe('serviceNameOf', () => {
  it('takes the service out of the CloudFormation type', () => {
    expect(serviceNameOf('AWS::Lambda::Function')).toBe('lambda');
    expect(serviceNameOf('AWS::DynamoDB::Table')).toBe('dynamodb');
    expect(serviceNameOf('AWS::S3::Bucket')).toBe('s3');
  });

  it('uses the name people actually search for where the namespace differs', () => {
    expect(serviceNameOf('AWS::Logs::LogGroup')).toBe('cloudwatch-logs');
    expect(serviceNameOf('AWS::Events::Rule')).toBe('eventbridge');
    expect(serviceNameOf('AWS::CertificateManager::Certificate')).toBe('acm');
  });

  it('does not let the API version split one service in two', () => {
    // A move to or from V1 would otherwise show up as a different service
    // entirely, and the history either side of it would stop lining up.
    expect(serviceNameOf('AWS::ApiGatewayV2::Api')).toBe('apigateway');
  });

  it('leaves AppSync alone so a tag cannot trigger an API replacement', () => {
    // A new API id would cascade to the schema, data source and resolver, and
    // move the GraphQL endpoint the portal calls on sign-in.
    expect(serviceNameOf('AWS::AppSync::GraphQLApi')).toBeUndefined();
  });

  it('returns nothing for a type it cannot read', () => {
    expect(serviceNameOf('')).toBeUndefined();
    expect(serviceNameOf(undefined)).toBeUndefined();
    expect(serviceNameOf('Custom::LogRetention')).toBeUndefined();
  });
});

describe('ServiceNameTagger', () => {
  function synth(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    new Table(stack, 'Table', { partitionKey: { name: 'PK', type: AttributeType.STRING } });
    new Bucket(stack, 'Bucket');
    new LambdaFunction(stack, 'Fn', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => {};'),
    });

    Tags.of(app).add('Application', 'CLOUDMETER');
    Aspects.of(app).add(new ServiceNameTagger());
    return Template.fromStack(stack);
  }

  it('tags each resource with its own service', () => {
    const t = synth();
    // arrayWith, not an exact list: Application sits alongside it and the order
    // these render in is CDK's business, not something to pin here.
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([{ Key: SERVICE_TAG_KEY, Value: 'dynamodb' }]),
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([{ Key: SERVICE_TAG_KEY, Value: 's3' }]),
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.arrayWith([{ Key: SERVICE_TAG_KEY, Value: 'lambda' }]),
    });
  });

  it('leaves the existing Application tag alone', () => {
    // These are separate keys answering separate questions; a change here that
    // dropped Application would break the only tag currently worth activating.
    const t = synth();
    const tables = t.findResources('AWS::DynamoDB::Table');
    const tags = Object.values(tables)[0].Properties.Tags as Array<{ Key: string }>;
    expect(tags.map((x) => x.Key).sort()).toEqual(['Application', SERVICE_TAG_KEY]);
  });

  it('skips resource types that cannot hold tags', () => {
    // The aspect must not invent a Tags property on, say, an IAM policy —
    // CloudFormation rejects the whole template if it does.
    const t = synth();
    Object.values(t.findResources('AWS::IAM::Policy')).forEach((r) => {
      expect(r.Properties?.Tags).toBeUndefined();
    });
  });
});
