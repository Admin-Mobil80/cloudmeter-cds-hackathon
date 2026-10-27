# CloudMeter — WhatsApp message templates

**Status: all four submitted to Meta on 2026-08-20**, on the shared `Partner`
WhatsApp Business Account (id `1538908081173274`, sender +91 78994 44028) while
CloudMeter waits for its own number.

| Template | Category | Language | Status on submission |
|---|---|---|---|
| `cloudmeter_verify_code` | Authentication | `en` | **APPROVED** immediately |
| `cloudmeter_daily_digest` | Utility | `en` | Pending review |
| `cloudmeter_cost_anomaly` | Utility | `en` | Pending review |
| `cloudmeter_sync_failed` | Utility | `en` | Pending review |

Authentication templates approve instantly because Meta owns the wording — you
declare behaviour (code expiry, copy-code button) and it supplies the text.
Utility templates carry our own words, so a human reviews them.

Re-submitting is done in **WhatsApp Manager → Account tools → Message
templates**, or through the Graph API against the WABA's `message_templates`
edge.

The three alert templates are category **Utility**, not Marketing. That matters
for more than tone: Utility templates are approved faster, are priced lower per
conversation, and — unlike Marketing — are not suppressed by a user's marketing
opt-out. Every one of them is a response to something happening in an account
the recipient already asked us to watch, which is the definition Meta applies.

## Rules these are written against

- **Outside the 24-hour customer service window, only an approved template can
  be sent.** A cost alert almost always falls outside it: the recipient is
  asleep, or hasn't messaged us in weeks. So every outbound message we might
  ever need to send has to exist here as a template — we cannot compose free
  text at alert time.
- Variables are positional (`{{1}}`, `{{2}}`, …). They may not be adjacent to
  each other, may not start or end the body, and may not contain newlines or
  tabs. Each needs a sample value at submission or the template is rejected.
- No URL shorteners in the body. Our links point at `portal.cloudmeter.io`
  directly, which also keeps them recognisable to the reader.
- Keep the body under ~1024 characters. All of these are far below that; a phone
  notification is read in about two seconds.

---

## 0. `cloudmeter_verify_code` — number verification

**Name:** `cloudmeter_verify_code`
**Category:** Authentication
**Language:** English (`en`)

Meta supplies the wording for this category; we only declare the behaviour, so
there is nothing to write and nothing to get rejected:

```
components:
  BODY    add_security_recommendation: true
  FOOTER  code_expiration_minutes: 10
  BUTTONS OTP, otp_type: COPY_CODE, text: "Copy code"
```

Which renders as:

```
*123456* is your verification code. For your security, do not share this code.
Expires in 10 minutes.
[ Copy code ]
```

Sent with the code twice — once as the body parameter, once as the button's
payload — which is what `sendTemplate` in `shared/whatsapp.ts` does.

---

## 1. `cloudmeter_daily_digest`

Sent once per account per day, at the local hour set under Settings → Timezone
& daily digest.

**Name:** `cloudmeter_daily_digest`
**Category:** Utility
**Language:** English (`en`)

**Body:**

```
CloudMeter daily summary for {{1}}

Spend on {{2}}: {{3}}
Month to date: {{4}} ({{5}} vs the same point last month)
Biggest mover: {{6}}

Full breakdown: portal.cloudmeter.io/dashboard.html
```

**Footer:** `Manage alerts in CloudMeter under Notifications`

**Sample values:**

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | Organization name | `Mobil80 Solutions` |
| `{{2}}` | The complete day being reported | `19 Aug 2026` |
| `{{3}}` | That day's total spend | `$142.87` |
| `{{4}}` | Month-to-date spend | `$2,727` |
| `{{5}}` | Change vs same point last month | `up 12%` |
| `{{6}}` | Largest single-service change | `AWS Lambda, up $274` |

`{{2}}` is a real date rather than the word "yesterday" on purpose — providers
post cost data late, so the day we can report is not always the previous one.
Naming the date means the message is never quietly wrong.

---

## 2. `cloudmeter_cost_anomaly`

**Name:** `cloudmeter_cost_anomaly`
**Category:** Utility
**Language:** English (`en`)

**Body:**

```
CloudMeter detected unusual spend in {{1}}

{{2}} on {{3}} is {{4}} - normally around {{5}}.
Estimated impact if it continues: {{6}} this month.

Review it: portal.cloudmeter.io/alerts.html
```

**Footer:** `Manage alerts in CloudMeter under Notifications`

**Sample values:**

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | Organization name | `Mobil80 Solutions` |
| `{{2}}` | Service that moved | `AWS Lambda` |
| `{{3}}` | Cloud account name | `Northwind` |
| `{{4}}` | Current level | `running at $434 over 30 days` |
| `{{5}}` | Learned baseline | `$170` |
| `{{6}}` | Projected impact | `$264 extra` |

---

## 3. `cloudmeter_sync_failed`

**Name:** `cloudmeter_sync_failed`
**Category:** Utility
**Language:** English (`en`)

**Body:**

```
CloudMeter can no longer read costs for {{1}}

The {{2}} account {{3}} last synced {{4}}. Its credentials may have been
rotated or its permissions changed, so cost data has stopped updating.

Fix the connection: portal.cloudmeter.io/accounts.html
```

**Footer:** `Manage alerts in CloudMeter under Notifications`

**Sample values:**

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | Organization name | `Mobil80 Solutions` |
| `{{2}}` | Provider | `AWS` |
| `{{3}}` | Cloud account name | `contoso` |
| `{{4}}` | When it last worked | `3 days ago` |

This one earns its place: silence from a monitoring product is ambiguous, and a
customer should never mistake "we stopped being able to look" for "nothing is
wrong". It is also the only template here that reports a CloudMeter problem
rather than a cloud-spend one.

---

## Opt-in and phone numbers

Meta requires demonstrable opt-in before messaging a number. Ours is the
Notifications page: the user enters their own number and enables the WhatsApp
channel, which is explicit, per-user, and revocable in the same place. Two
things follow that we should build alongside sending:

- Record **when** and **from where** consent was given, per user. Meta can ask,
  and "the user ticked a box at some point" is not an answer.
- Verify the number actually belongs to them before the first alert, otherwise
  a typo sends someone else's cost data to a stranger. A one-time code over
  WhatsApp is the obvious mechanism, and it doubles as proof the number can
  receive our messages at all.

## Rate limiting

Anomaly alerts need a per-tenant ceiling. A single misconfigured resource can
trip a dozen service-level anomalies in one sync, and a phone that buzzes twelve
times gets muted — after which the channel is worthless for the alert that
actually matters. A digest carries the full list; WhatsApp should carry only
what needs waking someone up.
