import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

export interface RedirectStackProps extends StackProps {
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
  /** The bare domain this distribution answers on, e.g. 'cloudmeter.io' or 'dev.cloudmeter.io'. */
  domainName: string;
  /** Host every request gets redirected to, e.g. 'www.cloudmeter.io'. */
  redirectHost: string;
}

/**
 * Visitors who type the bare domain (no "www") land on this instead of a DNS
 * error — every request gets a 301 to the same path on redirectHost. A
 * CloudFront Function does the redirect entirely at the edge, so this needs
 * no origin server of its own: the HttpOrigin below exists only because
 * CloudFront requires one, and is never actually fetched from.
 */
export class RedirectStack extends Stack {
  constructor(scope: Construct, id: string, props: RedirectStackProps) {
    super(scope, id, props);

    const { hostedZone, certificate, domainName, redirectHost } = props;

    const redirectFn = new cloudfront.Function(this, 'RedirectFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var qs = '';
  for (var key in request.querystring) {
    qs += (qs ? '&' : '?') + key + '=' + request.querystring[key].value;
  }
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: 'https://${redirectHost}' + request.uri + qs }
    }
  };
}
`),
    });

    const distribution = new cloudfront.Distribution(this, 'RedirectDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(redirectHost),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [{
          function: redirectFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      domainNames: [domainName],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Empty recordName resolves to the zone apex itself, which is exactly
    // right when domainName IS the zone name (the prod case).
    const recordName = domainName.replace(/\.cloudmeter\.io$/, '');
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'AliasA', { zone: hostedZone, recordName, target });
    new route53.AaaaRecord(this, 'AliasAAAA', { zone: hostedZone, recordName, target });

    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
