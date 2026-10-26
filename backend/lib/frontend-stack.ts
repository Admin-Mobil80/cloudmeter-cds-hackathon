import { Stack, StackProps, RemovalPolicy, Aws, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { EnvProps, s3Suffix, suffix } from './env-config';

export interface FrontendStackProps extends StackProps, EnvProps {
  /**
   * The zone the site's hostnames live in, and the certificate for them.
   *
   * Both optional together, and omitted only where CloudMeter does not own the
   * DNS: a second AWS account standing up its own copy while `cloudmeter.io`
   * stays in the original one. The distribution then answers on the
   * `*.cloudfront.net` name CloudFront assigns it, with no alias records and
   * no custom certificate — reachable, unbranded, and crucially unable to
   * create a competing copy of a zone this account does not own.
   *
   * Leaving them out is not a shortcut for the accounts that DO own the zone:
   * a site deployed this way has no stable hostname, so anything that has
   * already been mailed or bookmarked must keep its domain.
   */
  hostedZone?: route53.IHostedZone;
  certificate?: acm.ICertificate;
  /**
   * An existing certificate to put the domain on the distribution with, for an
   * account whose certificates and DNS records are made outside CDK.
   *
   * The second account's deploy role is denied Route 53 and has no ACM, so
   * there the certificate is created by hand and passed in by ARN, and the
   * alias records are written by hand too. With this and `domainName` but no
   * `hostedZone`, the distribution answers on the domain and this stack writes
   * no DNS at all.
   */
  certificateArn?: string;
  /** Short identifier for this site, e.g. 'portal' or 'bms' — used in resource names. */
  siteName: string;
  /**
   * Single fully-qualified domain this distribution serves, e.g.
   * 'dev.portal.cloudmeter.io'.
   *
   * Omitted together with `hostedZone` and `certificate` — see those.
   */
  domainName?: string;
  /**
   * Extra hostnames this same distribution answers on, beyond `domainName`.
   *
   * Used for the bare domain: cloudmeter.io serves the marketing site directly
   * rather than redirecting to www, so a visitor typing the short name gets the
   * page instead of a round trip. One distribution, one cache, one deploy —
   * not a second copy to keep in step.
   */
  extraDomainNames?: string[];
  /**
   * What CloudFront serves for a request to "/". Defaults to 'index.html',
   * which is right for a site whose home page is its marketing page. The
   * portal no longer is one — its marketing page moved to the www site — so
   * it passes 'login.html' instead of needing an index.html of its own.
   */
  defaultRootObject?: string;
}

// One S3 bucket + one CloudFront distribution per site per environment —
// portal and bms are separate applications with their own distributions,
// even though they currently share one ACM cert (covers both domains) and
// the one shared Route 53 hosted zone.
export class FrontendStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const {
      envName, hostedZone, siteName, domainName, defaultRootObject,
      extraDomainNames = [],
    } = props;
    const certificate = props.certificate
      ?? (props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'ImportedCertificate', props.certificateArn)
        : undefined);

    // Empty when this site has no domain of its own, which is what leaves both
    // the distribution's aliases and the DNS records below with nothing to do.
    const hosts = domainName ? [domainName, ...extraDomainNames] : [];

    /*
     * Where the API, AppSync and Cognito this site talks to actually live.
     *
     * Taken from the stack, because every environment deploys its backend in
     * the same region as its frontend stack. If that ever stops being true this
     * becomes a prop — but a wrong value here fails in a way nobody enjoys
     * debugging, so it should never be a literal again.
     */
    const apiRegion = Stack.of(this).region;

    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `cloudmeter-${siteName}-frontend${s3Suffix(envName)}-${Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });


    /**
     * Security headers on every response.
     *
     * CSP is the one that matters. The portal loads no inline <script> and
     * uses no inline event handlers, so `script-src 'self'` is achievable
     * without weakening it to 'unsafe-inline' — which means an injected
     * payload cannot execute even if an escape is missed somewhere. That is
     * defence in depth for exactly the bug class the escaping fixes address.
     *
     * `style-src` does allow inline: the markup carries style="" attributes
     * throughout. Injected CSS is a far smaller problem than injected script,
     * and removing several hundred inline styles is not a security change.
     *
     * connect-src is scoped to the service hosts this app actually calls,
     * wildcarded by service rather than pinned to specific ids — that avoids a
     * cross-stack reference between the frontend and the API/AppSync stacks
     * while still refusing exfiltration to an arbitrary host.
     *
     * The region comes from the stack rather than being written in. It was
     * hardcoded to ap-south-1, which is invisible until the app is deployed
     * somewhere else: every call the page makes is then blocked by the browser
     * before it is sent, including the one to Cognito, and the only symptom is
     * a bare "Failed to fetch". curl cannot reproduce it — a CSP is enforced by
     * browsers and ignored by everything else — so it survives exactly the
     * checks a deploy usually gets.
     */
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `cloudmeter-${siteName}-security${suffix(envName)}`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "connect-src 'self'"
              + ` https://*.execute-api.${apiRegion}.amazonaws.com`
              + ` https://*.appsync-api.${apiRegion}.amazonaws.com`
              + ` https://cognito-idp.${apiRegion}.amazonaws.com`,
            // The marketing site embeds the promo video from YouTube, using
            // the no-cookie host so a visitor isn't tracked until they press
            // play. Only www gets it: the portal and BMS frame nothing, and
            // without a frame-src line they fall back to default-src 'self'.
            ...(siteName === 'www' ? ['frame-src https://www.youtube-nocookie.com'] : []),
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join('; '),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      /*
       * Both omitted for a site with no domain of its own, which then answers
       * on the *.cloudfront.net name CloudFront assigns it.
       *
       * They travel together deliberately. CloudFront rejects `domainNames`
       * without a certificate covering them, so splitting the condition would
       * turn a missing cert into a deploy-time failure rather than a site that
       * simply has no custom hostname.
       *
       * The zone is not part of the condition: in the second account the
       * domain is attached with an imported certificate while the DNS records
       * are written by hand. Where a zone is passed, the records below follow.
       */
      ...(certificate && domainName
        ? { domainNames: hosts, certificate }
        : {}),
      defaultRootObject: defaultRootObject ?? 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    /*
     * No zone, no records — and that is the safety property, not a side
     * effect.
     *
     * This loop is the only place in the stack that writes DNS. A deployment
     * into an account that does not own `cloudmeter.io` is handed no zone, so
     * the loop has nothing to iterate and touches no hosted zone in that
     * account — including ones belonging to entirely unrelated systems.
     */
    if (hostedZone && domainName) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
      // Every hostname the distribution answers on needs its own alias record;
      // an alias on the distribution with no DNS pointing at it resolves nowhere.
      for (const host of hosts) {
        // The apex strips to an empty recordName, which Route53 reads as the
        // zone itself — exactly what a bare-domain record needs.
        const recordName = host.replace(/\.?cloudmeter\.io$/, '');
        const id = host === domainName ? '' : `-${host.replace(/[^a-zA-Z0-9]/g, '')}`;
        const a = new route53.ARecord(this, `AliasA${id}`, { zone: hostedZone, recordName, target });
        const aaaa = new route53.AaaaRecord(this, `AliasAAAA${id}`, { zone: hostedZone, recordName, target });

        // Deleting this stack must not take the hostname off the internet. A
        // frontend stack can be torn down and rebuilt; the DNS name is the part
        // customers have bookmarked, linked and configured elsewhere, and losing
        // it is the one failure here that cannot be undone in a hurry.
        //
        // The apex records were adopted by `cdk import`, which sets Retain on
        // anything it imports — deploying without this would have quietly
        // stripped that protection from cloudmeter.io.
        a.applyRemovalPolicy(RemovalPolicy.RETAIN);
        aaaa.applyRemovalPolicy(RemovalPolicy.RETAIN);
      }
    }

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
  }
}
