import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomBytes, randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../shared/ddb';
import { resolveCaller, requireRole, json, requireWritable } from '../../../shared/authz';

const CLOUDMETER_ACCOUNT_ID = process.env.CLOUDMETER_ACCOUNT_ID!;
const PENDING_TTL_SECONDS = 60 * 60;

// Issues the server-generated External ID the customer must put in their
// trust policy, plus the ready-to-paste setup commands. Held as a short-lived
// pending record so POST /accounts can look the External ID back up
// server-side rather than trusting the client to echo it.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const readOnly = requireWritable(caller);
  if (readOnly) return readOnly;

  const forbidden = requireRole(caller, ['owner', 'admin']);
  if (forbidden) return forbidden;

  const connectionToken = randomUUID();
  const externalId = `cm-${randomBytes(8).toString('hex')}`;
  const roleName = 'CloudMeterReadOnly';

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${caller.membership.tenantId}`,
      SK: `PENDINGCONN#${connectionToken}`,
      externalId,
      createdBy: caller.userId,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
    },
  }));

  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${CLOUDMETER_ACCOUNT_ID}:root` },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': externalId } },
      },
    ],
  };

  const permissionPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetTags', 'ce:GetDimensionValues'],
        Resource: '*',
      },
    ],
  };

  const snippet = `# 1. Save this trust policy as trust-policy.json
cat > trust-policy.json <<'EOF'
${JSON.stringify(trustPolicy, null, 2)}
EOF

# 2. Save the read-only permissions as cost-read-policy.json
cat > cost-read-policy.json <<'EOF'
${JSON.stringify(permissionPolicy, null, 2)}
EOF

# 3. Create the role and attach the policy
aws iam create-role \\
  --role-name ${roleName} \\
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \\
  --role-name ${roleName} \\
  --policy-name CloudMeterCostReadOnly \\
  --policy-document file://cost-read-policy.json

# 4. Copy the printed Role ARN back into CloudMeter
aws iam get-role --role-name ${roleName} --query Role.Arn --output text`;

  return json(200, { connectionToken, externalId, roleName, snippet });
};
