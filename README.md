# CloudMeter — multi-cloud cost monitoring with a WhatsApp AI cost agent

CloudMeter, by Mobil80, brings a company's cloud and AI spend — AWS, Azure,
Google Cloud, Alibaba Cloud, Huawei Cloud, OpenAI — into one dashboard, detects
cost spikes, and tells the team on **WhatsApp through AWS End User Messaging
Social**, by email through **Amazon SES**, and on Slack.

People can also **ask CloudMeter about their costs on WhatsApp**. An AI agent on
**Amazon Bedrock AgentCore**, using **Amazon Nova 2 Lite** on Amazon Bedrock,
reads their live CloudMeter data with read-only tools and replies in seconds.

Live at [cloudmeter.io](https://cloudmeter.io) — customer portal:
[portal.cloudmeter.io](https://portal.cloudmeter.io).

![CloudMeter architecture](backend/docs/architecture.png)

## Try it

**Web portal** — [portal.cloudmeter.io](https://portal.cloudmeter.io)

1. Enter `appreview@cloudmeter.io` and continue.
2. At the code screen enter `061628` (a fixed code — no mailbox needed).
3. You are in the **CloudMeter Demo** workspace: five sample cloud accounts
   with six months of history. No real cloud account is connected to it, and
   the workspace is read-only.

**WhatsApp AI cost agent** — CloudMeter's number is **+91 81058 23737**.

1. Signed in as above, open **Notifications → Connect WhatsApp**, enter your
   mobile number and type in the code that arrives on WhatsApp.
2. Message +91 81058 23737 from that phone, for example *How much did we spend
   this month?*, *s3 cost*, *Production (AWS)*, *Any cost spikes?*
3. Type *invite* to see a team invite that starts on WhatsApp and finishes in
   email: CloudMeter asks for the workspace, the person's email and Member or
   Admin. The demo workspace is read-only, so the last step says no invitation
   was sent.

## What's in this repository

| Folder | What it is |
|---|---|
| [`backend/`](backend) | AWS CDK app (TypeScript) and every Lambda function: cost ingestion, API, notifications, and the WhatsApp AI agent. **Start here** — its [README](backend/README.md) has the details, build and deploy steps. |
| [`portal/`](portal) | Customer web portal (plain HTML/JS, no build step) |
| [`staff-console/`](staff-console) | Internal staff console for workspaces, plans and payments, on its own Cognito user pool |
| [`marketing/`](marketing) | Public marketing site |

## Where the AWS Communication Developer Services are used

**AWS End User Messaging Social (WhatsApp)**
- Sending: [`backend/functions/shared/whatsapp.ts`](backend/functions/shared/whatsapp.ts) —
  `SendWhatsAppMessageCommand` from `@aws-sdk/client-socialmessaging`, for
  verification codes, daily digests, cost-spike alerts and the agent's replies.
- Receiving: the WhatsApp Business Account's event destination is an Amazon SNS
  topic that triggers
  [`backend/functions/assistant/whatsapp-inbound`](backend/functions/assistant/whatsapp-inbound/index.ts).
- Across channels: a team invite typed on WhatsApp
  ([`backend/functions/assistant/invite-flow.ts`](backend/functions/assistant/invite-flow.ts))
  is sent as an Amazon SES email by the same function the portal uses
  ([`backend/functions/shared/team-invite.ts`](backend/functions/shared/team-invite.ts)).
- IAM: each sender may call `social-messaging:SendWhatsAppMessage` on one
  phone-number ARN only — [`backend/lib/notifications-stack.ts`](backend/lib/notifications-stack.ts),
  [`backend/lib/assistant-stack.ts`](backend/lib/assistant-stack.ts).

**Amazon SES** — sign-in codes, alerts, digests, invitations and renewal
notices; see "Where Amazon SES is used" in the [backend README](backend/README.md).

**The AI agent** — [`backend/functions/assistant/`](backend/functions/assistant):
the AgentCore runtime entry point (`agent/`), its read-only tools (`tools.ts`),
and the guards that stop the WhatsApp pipeline from ever looping. The agent
never changes anything; team invites run as plain code beside it and are sent
only after the Owner or Admin confirms the role.

## About this repository

This is a snapshot of CloudMeter's four codebases, published for the AWS CDS
Agentic AI Partner Hackathon. The commit history is in Mobil80's private
repositories. CloudMeter's first commit was on 17 August 2026; the WhatsApp AI
agent and the WhatsApp delivery through AWS End User Messaging Social were built
during the Submission Period — see "Built before and during the hackathon" in
the [backend README](backend/README.md).

Customer and staff names in sample data, tests and comments have been replaced
with placeholders.

## License

[GNU Affero General Public License v3.0](LICENSE).
