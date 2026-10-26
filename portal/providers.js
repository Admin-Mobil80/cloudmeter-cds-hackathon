// CloudMeter — shared cloud provider display metadata.
// Credential *fields* are not defined here — they come from GET /providers so
// the backend adapters stay the single source of truth.

const PROVIDER_META = {
  aws: {
    key: 'aws', name: 'AWS', fullName: 'Amazon Web Services', badge: 'AWS',
    color: 'var(--provider-aws)', nounSingular: 'account', nounPlural: 'accounts',
    idLabel: 'Account ID', idPlaceholder: '111122223333',
    roleLabel: 'read-only cross-account IAM role',
    // AWS uses cross-account AssumeRole rather than stored keys, so its setup
    // snippet is generated server-side per connection (it embeds a unique
    // External ID) rather than being static text.
  },
  azure: {
    key: 'azure', name: 'Azure', fullName: 'Microsoft Azure', badge: 'AZ',
    color: 'var(--provider-azure)', nounSingular: 'subscription', nounPlural: 'subscriptions',
    idLabel: 'Subscription ID', idPlaceholder: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
    roleLabel: 'read-only service principal (Cost Management Reader)',
    snippet: `# Create a service principal and grant it read-only cost access
az ad sp create-for-rbac \\
  --name "CloudMeterReader" \\
  --role "Cost Management Reader" \\
  --scopes /subscriptions/<subscription-id>

# Note the appId (client ID), password (client secret) and tenant
# from the output — you'll paste them below.`,
  },
  gcp: {
    key: 'gcp', name: 'GCP', fullName: 'Google Cloud Platform', badge: 'GCP',
    // The project ID is itself a credential, so the connect form takes it
    // from there rather than asking for it a second time.
    idFromCredential: 'project_id',
    color: 'var(--provider-gcp)', nounSingular: 'project', nounPlural: 'projects',
    idLabel: 'Project ID', idPlaceholder: 'my-project-84421',
    roleLabel: 'read-only service account (BigQuery Data Viewer + Job User)',
    snippet: `# GCP has no cost API — CloudMeter reads your Cloud Billing
# export in BigQuery, so that export must already be configured.

gcloud iam service-accounts create cloudmeter-reader \\
  --display-name "CloudMeter Read-Only"

gcloud projects add-iam-policy-binding <project-id> \\
  --member "serviceAccount:cloudmeter-reader@<project-id>.iam.gserviceaccount.com" \\
  --role "roles/bigquery.dataViewer"

gcloud projects add-iam-policy-binding <project-id> \\
  --member "serviceAccount:cloudmeter-reader@<project-id>.iam.gserviceaccount.com" \\
  --role "roles/bigquery.jobUser"

gcloud iam service-accounts keys create key.json \\
  --iam-account cloudmeter-reader@<project-id>.iam.gserviceaccount.com

# Paste the full contents of key.json below.`,
  },
  alibaba: {
    key: 'alibaba', name: 'Alibaba Cloud', fullName: 'Alibaba Cloud', badge: 'AL',
    color: 'var(--provider-alibaba)', nounSingular: 'account', nounPlural: 'accounts',
    idLabel: 'Account UID', idPlaceholder: '6602991700221144',
    roleLabel: 'RAM user with billing read access',
    snippet: `# Create a RAM user and attach read-only billing access
aliyun ram CreateUser --UserName cloudmeter-reader

aliyun ram AttachPolicyToUser \\
  --PolicyName AliyunBSSReadOnlyAccess \\
  --PolicyType System \\
  --UserName cloudmeter-reader

aliyun ram CreateAccessKey --UserName cloudmeter-reader

# Note the AccessKeyId and AccessKeySecret from the output.`,
  },
  huawei: {
    key: 'huawei', name: 'Huawei Cloud', fullName: 'Huawei Cloud', badge: 'HW',
    color: 'var(--provider-huawei)', nounSingular: 'account', nounPlural: 'accounts',
    idLabel: 'Account ID (Domain ID)', idPlaceholder: '4471209300aa11bb22cc',
    roleLabel: 'IAM user with BSS billing read permission',
    snippet: `# In the Huawei Cloud console:
# 1. IAM > Users > Create User (Access type: Programmatic access)
# 2. Grant the user the "BSS Administrator" or a custom
#    read-only billing policy (bss:bill:view)
# 3. Download the AK/SK credentials file
# 4. Find your Domain ID under My Credentials > API Credentials`,
  },
  openai: {
    key: 'openai', name: 'OpenAI', fullName: 'OpenAI', badge: 'AI',
    idFromCredential: 'organization_name',
    color: 'var(--provider-openai)', nounSingular: 'organization', nounPlural: 'organizations',
    idLabel: 'Organization Name', idPlaceholder: 'Acme Inc.',
    roleLabel: 'Admin API key with billing read access',
    snippet: `# In the OpenAI platform (platform.openai.com):
# 1. You must be an Owner of the organization
# 2. Settings > Organization > Admin keys > Create admin key
# 3. Copy the key (starts with "sk-admin-") \u2014 it is shown once
#
# A project API key ("sk-proj-...") cannot read cost data;
# only an Admin key can reach the organization Costs API.`,
  },
  whatsapp: {
    key: 'whatsapp', name: 'WhatsApp Business', fullName: 'WhatsApp Business Platform', badge: 'WA',
    color: 'var(--provider-whatsapp)', nounSingular: 'account', nounPlural: 'accounts',
    idFromCredential: 'waba_id',
    idLabel: 'WhatsApp Business Account ID', idPlaceholder: '1234567890123456',
    roleLabel: 'System User token with WhatsApp management access',
    snippet: `# In Meta Business Settings (business.facebook.com/settings):
# 1. Users > System Users > Add \u2014 or pick an existing one
# 2. Assign Assets > WhatsApp Accounts > select your WABA
#    and grant "Manage WhatsApp business accounts" (full control)
# 3. Generate New Token > select your app
#    Scope required: whatsapp_business_management
# 4. Copy the token \u2014 System User tokens can be made permanent
#
# The WABA ID is under Accounts > WhatsApp Accounts.
# It is NOT the phone number ID and NOT the Business Manager ID.`,
  },
  adhoc: {
    key: 'adhoc', name: 'Adhoc', fullName: 'Adhoc Spend', badge: 'AD',
    // One account per tool, with each plan recorded as a line inside it — so
    // the thing being counted here is tools, not subscriptions.
    color: 'var(--provider-adhoc)',
    nounSingular: 'subscription tool', nounPlural: 'subscription tools',
    // Everything below is what the other providers need for the connect flow —
    // a credential to create, an account id to paste. This one has none of
    // that: it is typed in, so add-account sends it down a different path and
    // these fields are never read.
    subtitle: 'Subscription cost by AI tools',
    manualEntry: true,
  },
};

const PROVIDER_ORDER = ['aws', 'azure', 'gcp', 'alibaba', 'huawei', 'openai', 'whatsapp', 'adhoc'];
