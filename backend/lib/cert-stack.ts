import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';

export interface CertStackProps extends StackProps {
  hostedZone: route53.IHostedZone;
  domainNames: string[];
}

// CloudFront only accepts ACM certificates issued in us-east-1, regardless
// of which region the rest of the stack lives in — hence a dedicated stack.
export class CertStack extends Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const { hostedZone, domainNames } = props;

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainNames[0],
      subjectAlternativeNames: domainNames.slice(1),
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
  }
}
