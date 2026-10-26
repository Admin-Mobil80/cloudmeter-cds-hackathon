import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { FrontendStack } from './frontend-stack';

const GITHUB_ORG = 'Admin-Mobil80';
const PORTAL_REPO = 'Cloudmeter-Frontend';
const BMS_REPO = 'Cloudmeter-BMS';

export interface CiDeployStackProps extends StackProps {
  portalDev: FrontendStack;
  portalProd: FrontendStack;
  bmsDev: FrontendStack;
  bmsProd: FrontendStack;
}

/**
 * IAM roles GitHub Actions assumes (via OIDC, no stored keys) to deploy the
 * portal and BMS static frontends. Two roles, one per environment, each
 * trusted only for that environment's exact branch across both repos — a
 * dev-branch workflow run cannot obtain prod credentials no matter what the
 * workflow YAML says, because the trust condition is checked against GitHub's
 * own token claim for the ref that actually triggered the run.
 *
 * This account is shared with several unrelated client projects (skilterco,
 * bugtrakr, slotzapp, mmdm, and others), each with their own GitHub OIDC
 * roles already in place — so this stack imports the account's existing
 * `token.actions.githubusercontent.com` provider (there can only be one) and
 * adds two new roles alongside them, scoped tightly to CloudMeter's own repos
 * and buckets. It never touches the provider itself or any other project's
 * resources.
 *
 * The same holds in the second account (975138397215), where the provider was
 * created on 2026-09-09 by another team's Terraform (tagged Project=ohteapea).
 * The ARN is built from the stack's own account so each account imports its
 * own provider. Importing by ARN changes nothing about it, but CloudMeter's
 * deploys there depend on it existing: if that team removes it, pushes stop
 * reaching the second account until it is recreated.
 */
export class CiDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: CiDeployStackProps) {
    super(scope, id, props);

    const { portalDev, portalProd, bmsDev, bmsProd } = props;

    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const devRole = this.deployRole('Dev', oidcProvider, 'dev', [portalDev, bmsDev]);
    const prodRole = this.deployRole('Prod', oidcProvider, 'main', [portalProd, bmsProd]);

    new CfnOutput(this, 'DevRoleArn', { value: devRole.roleArn });
    new CfnOutput(this, 'ProdRoleArn', { value: prodRole.roleArn });
  }

  private deployRole(
    suffix: string,
    oidcProvider: iam.IOpenIdConnectProvider,
    branch: string,
    sites: FrontendStack[],
  ): iam.Role {
    const role = new iam.Role(this, `GitHubDeploy${suffix}Role`, {
      roleName: `cloudmeter-github-deploy-${branch === 'main' ? 'prod' : 'dev'}`,
      description: `Assumed by GitHub Actions (OIDC) to deploy CloudMeter's frontends from the ${branch} branch only.`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          // Admin-Mobil80 has GitHub's "use immutable IDs" OIDC setting on,
          // so the real `sub` claim is `repo:org@orgId/repo@repoId:ref:...`,
          // not the plain `repo:org/repo:ref:...` the docs lead with —
          // confirmed from a CloudTrail-denied AssumeRoleWithWebIdentity
          // record (`repo:Admin-Mobil80@208915971/Cloudmeter-Frontend@...`).
          // Wildcarding the numeric ID segment matches either form and
          // doesn't require hardcoding (or re-discovering) each repo's ID.
          StringLike: {
            'token.actions.githubusercontent.com:sub': [
              `repo:${GITHUB_ORG}@*/${PORTAL_REPO}@*:ref:refs/heads/${branch}`,
              `repo:${GITHUB_ORG}@*/${BMS_REPO}@*:ref:refs/heads/${branch}`,
            ],
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    for (const site of sites) {
      site.bucket.grantReadWrite(role);
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${site.distribution.distributionId}`,
        ],
      }));
    }

    return role;
  }
}
