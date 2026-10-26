# CloudMeter Frontend

Static HTML/CSS/JS web app for CloudMeter — a multi-cloud cost-monitoring SaaS. No build step, no framework.

## Pages

- `index.html` — public marketing homepage
- `login.html` — sign up / sign in (email + OTP)
- `dashboard.html` — unified cost overview
- `accounts.html`, `account-detail.html` — connected cloud accounts and per-account cost drill-down
- `alerts.html` — anomaly alerts
- `team.html` — team members and roles (Owner/Admin/Member)
- `notifications.html` — per-user notification channel preferences
- `billing.html`, `settings.html` — plan/billing and account settings (owner-only)

## Local development

```bash
python3 -m http.server 8790
```

Then open `http://localhost:8790/`. Opening the HTML files directly via `file://` will not work — several pages rely on `sessionStorage`, which most browsers isolate per-origin and don't share across `file://` pages.

## Deployment

Pushes to `main` deploy automatically to S3 via GitHub Actions.
