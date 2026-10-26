import { Stack, StackProps, CfnOutput, Fn } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';

export class DnsStack extends Stack {
  public readonly hostedZone: route53.HostedZone;
  public readonly emailIdentity: ses.EmailIdentity;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // This stack OWNS the live zone (Z03034243DQQN22TP350L in ap-south-1) along
    // with the DKIM and SPF records below. Do not "modernise" this to
    // HostedZone.fromHostedZoneAttributes/fromLookup: an imported zone emits no
    // CloudFormation resource, so the owned one disappears from the template and
    // the next deploy destroys the live zone and every record in it. That was
    // tried on 2026-08-27 and `cdk diff` reported `destroy` against all five.
    //
    // What actually went wrong that day was a duplicate zone appearing, and the
    // cause was the shell, not this file: `aws configure export-credentials`
    // exports credentials but NOT a region, so with AWS_REGION unset CDK falls
    // back to us-east-1 and creates a whole second set of stacks there instead
    // of updating the real ap-south-1 ones. Always export AWS_REGION=ap-south-1
    // before any cdk command here.
    this.hostedZone = new route53.HostedZone(this, 'CloudMeterZone', {
      zoneName: 'cloudmeter.io',
      comment: 'CloudMeter production DNS zone',
    });

    // Domain-level Easy DKIM verification — CDK writes the DKIM CNAME
    // records straight into the hosted zone above, no manual DNS copy-paste.
    this.emailIdentity = new ses.EmailIdentity(this, 'CloudMeterEmailIdentity', {
      identity: ses.Identity.publicHostedZone(this.hostedZone),
    });

    // DKIM alone isn't enough for a brand-new sending domain to reliably
    // reach the inbox — SPF is the other signal mail providers check, and
    // its absence is a common reason OTP mail lands in spam. (A DMARC
    // record at _dmarc.cloudmeter.io — "v=DMARC1; p=none;" — already exists
    // in this zone outside CDK's management; not duplicating it here.)
    new route53.TxtRecord(this, 'SpfRecord', {
      zone: this.hostedZone,
      recordName: 'cloudmeter.io',
      values: ['v=spf1 include:amazonses.com ~all'],
    });

    new CfnOutput(this, 'HostedZoneId', { value: this.hostedZone.hostedZoneId });
    new CfnOutput(this, 'NameServers', {
      value: Fn.join(', ', this.hostedZone.hostedZoneNameServers as string[]),
    });
  }
}
