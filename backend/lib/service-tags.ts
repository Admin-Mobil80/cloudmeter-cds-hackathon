import { CfnResource, IAspect, TagManager } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Tags every resource with the AWS service it belongs to — `cloudmeter=lambda`
 * on a function, `cloudmeter=dynamodb` on a table.
 *
 * `Application` and `Environment` are added with plain `Tags.of()` in
 * bin/infra.ts because every resource gets the same value. This one can't work
 * that way: the value has to be read off each resource, so it needs an aspect
 * that inspects the CloudFormation type as the tree is synthesised.
 *
 * Like the other two, the tag alone produces no cost data — the key has to be
 * activated as a cost allocation tag in Billing first, and only from that point
 * onward. Activation is not retroactive.
 */
export const SERVICE_TAG_KEY = 'cloudmeter';

/**
 * Where the CloudFormation namespace isn't the name anyone would search for.
 * `AWS::Logs::LogGroup` is CloudWatch Logs, not a service called "logs", and
 * pinning ApiGatewayV2 to the version number would split one service in two the
 * day anything moves to V1 or back.
 *
 * Anything not listed falls through to the namespace lowercased, which is
 * already right for the common cases (Lambda, DynamoDB, S3, KMS, CloudFront).
 */
const SERVICE_NAMES: Record<string, string> = {
  Logs: 'cloudwatch-logs',
  Events: 'eventbridge',
  ApiGatewayV2: 'apigateway',
  CertificateManager: 'acm',
  SecretsManager: 'secrets-manager',
  Route53: 'route53',
};

/**
 * Types left untagged because CloudFormation treats a tag change on them as
 * grounds for replacing the resource.
 *
 * AWS::AppSync::GraphQLApi is the only one. A change set for it comes back
 * "may be replaced" on Tags alone, and a replacement issues a new API id —
 * which cascades to the schema, data source and resolver that reference it, and
 * changes the GraphQL endpoint the portal calls on sign-in. AWS documents Tags
 * here as no-interruption and it would most likely be fine, but "most likely"
 * is the wrong standard for the endpoint the app depends on, and the reward is
 * a cost breakdown for a service that costs very little.
 *
 * These resources still carry Application and Environment, so they are not
 * invisible in cost reporting — only unsplit by service.
 */
const SKIP_TYPES = new Set(['AWS::AppSync::GraphQLApi']);

/**
 * The CloudFormation type a node ends up rendering as.
 *
 * Usually the node is the CfnResource itself. For the wrapper case it is a
 * plain Construct holding the TagManager, and the type lives on the CfnResource
 * it creates as its default child. The TagManager knows its own type but keeps
 * it private, so this reads it from the child instead.
 */
function cfnTypeOf(node: IConstruct): string | undefined {
  if (CfnResource.isCfnResource(node)) return node.cfnResourceType;
  const child = node.node.defaultChild;
  return child && CfnResource.isCfnResource(child) ? child.cfnResourceType : undefined;
}

/**
 * `AWS::Lambda::Function` -> `lambda`. Undefined for anything that isn't an AWS
 * resource type.
 *
 * The `AWS::` check matters: a `Custom::LogRetention` would otherwise be
 * labelled the service "logretention", which doesn't exist and which nobody
 * would be able to make sense of in a cost report. Custom resources aren't
 * taggable today so it never reaches a template, but that is a property of
 * CloudFormation rather than something this should rely on.
 */
export function serviceNameOf(cfnResourceType: string | undefined): string | undefined {
  if (SKIP_TYPES.has(String(cfnResourceType))) return undefined;
  const [vendor, service] = String(cfnResourceType).split('::');
  if (vendor !== 'AWS' || !service) return undefined;
  return SERVICE_NAMES[service] ?? service.toLowerCase();
}

export class ServiceNameTagger implements IAspect {
  visit(node: IConstruct): void {
    // Most resources aren't taggable at all — IAM policies, Lambda permissions,
    // API Gateway routes, Route53 records. Asking the TagManager rather than
    // keeping a list of which is which means a new resource type is handled
    // correctly without anyone remembering to update this file.
    //
    // Deliberately not gated on CfnResource: a handful of CDK's own constructs
    // (the log-retention helper among them) hold the TagManager on a plain
    // wrapper Construct and render it into a raw CfnResource underneath, so
    // that guard silently skips them.
    let manager: TagManager | undefined;
    if (TagManager.isTaggable(node)) manager = node.tags;
    else if (TagManager.isTaggableV2(node)) manager = node.cdkTagManager;
    if (!manager) return;

    const value = serviceNameOf(cfnTypeOf(node));
    if (value) manager.setTag(SERVICE_TAG_KEY, value);
  }
}
