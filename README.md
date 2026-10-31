# WNBSLS Savings, Loans & Investment Management

A responsive web application for managing the savings, loans and investments of the
**West New Britain Savings and Loans Society (WNBSLS)**.

- **Members & share capital**: member register, share subscriptions and withdrawals.
- **Savings**: accounts, deposits, withdrawals with minimum-balance protection, monthly interest run (idempotent).
- **Loans**: eligibility limits based on savings + shares, application, approval, rejection, disbursement,
  reducing-balance or flat schedules, repayments allocated interest-first to the oldest instalment, arrears report.
- **Investments**: Society investments, expected returns, returns received and distributions to members.
- **Reports & audit**: dashboard (outstanding loans, portfolio at risk, share capital, savings) and an audit trail.
- **Configurable rules**: interest rates, loan multiple, loan cap, maximum term and minimum balance are set by an admin in Settings.
- **Roles**: `admin` (approves, configures, manages users), `officer` (transactions and applications),
  `auditor` (read-only), `member` (own records and loan applications only).

Currency is **PGK**. Money is stored as whole **toea** (1 kina = 100 toea) so calculations never suffer floating-point error.

## Architecture

```
server/   Node.js 20+ · Express · PostgreSQL (pg) · JWT auth · bcrypt
  src/lib/finance.js   pure finance logic (schedules, allocation, arrears, eligibility)
  src/routes/          REST API under /api
  src/db/migrations/   versioned SQL migrations
  test/                unit tests for the finance logic
web/      React 18 · Vite · responsive CSS (works on phones, tablets and desktops)
```

## Quick start

Prerequisites: Node.js 20+, PostgreSQL 14+ (or `docker compose up -d db`).

```bash
# 1. Database
docker compose up -d db

# 2. Server
cd server
cp ../.env.example .env          # then edit DATABASE_URL, JWT_SECRET and ADMIN_*
npm install
export $(grep -v '^#' .env | xargs)
npm run migrate
npm run seed                     # creates default settings and the first admin
npm test                         # finance unit tests
npm start                        # API on http://localhost:4000

# 3. Web app (new terminal)
cd web
npm install
npm run dev                      # http://localhost:5173 (proxies /api to :4000)
```

Production build: `cd web && npm run build` produces `web/dist/`, which any static host or
the Express server can serve. Serve the API and web app over HTTPS only.

## Business rules (defaults — confirm before go-live)

| Rule | Default | Where to change |
|---|---|---|
| Savings interest | 4% p.a., credited monthly on the month-end balance | Settings |
| Loan interest | 12% p.a. | Settings (applies to new applications only) |
| Loan method | Reducing balance (`flat` also supported) | Settings |
| Maximum loan | 3 × (savings + share capital), capped at K50,000 | Settings |
| Maximum term | 36 months | Settings |
| Minimum savings balance | K0 | Settings |
| Guarantor | Not required (supported when enabled) | Settings |

These are **starting values, not the Society's approved by-law terms**. The Board should confirm them.
Changing a rate does not rewrite schedules already created at disbursement.

## Regulatory note

The Society operates under PNG law, and the rules above must be checked against the Society's
registration, its constitution and the applicable PNG savings and loans regulation before use with real money.
Reporting formats (for example returns to the regulator) are not yet built and should be added once confirmed.

## Security

- Passwords are hashed with bcrypt (cost 12). Login is throttled after 10 failed attempts per email in 15 minutes.
- JWT sessions expire after 8 hours. The web app keeps the token in `sessionStorage`.
- Every money-moving action writes to `audit_log`.
- Withdrawals and repayments lock the affected rows inside a database transaction, so concurrent requests cannot overdraw an account.
- Members can only read their own records; the server enforces this, not the UI.
- Run behind HTTPS, set a strong `JWT_SECRET`, restrict `CORS_ORIGIN`, back up the database daily, and review the audit trail regularly.

For production, add a password-reset flow, two-factor authentication for admins, and rate limiting at the reverse proxy.

## API overview

| Method | Path | Roles |
|---|---|---|
| POST | `/api/auth/login` | public |
| GET | `/api/auth/me` | any |
| GET/POST | `/api/members` | staff (create: admin, officer) |
| GET/PATCH | `/api/members/:id` | staff; member (own record) |
| POST | `/api/members/:id/shares` | admin, officer |
| GET/POST | `/api/savings/accounts` | staff; member (own) |
| GET | `/api/savings/accounts/:id` | staff; member (own) |
| POST | `/api/savings/accounts/:id/transactions` | admin, officer |
| POST | `/api/savings/interest-run` | admin |
| GET | `/api/loans/eligibility/:memberId` | staff; member (own) |
| GET/POST | `/api/loans` | staff; member (own) |
| GET | `/api/loans/arrears` | admin, officer, auditor |
| GET | `/api/loans/:id` | staff; member (own) |
| POST | `/api/loans/:id/approve`, `/reject`, `/disburse` | admin |
| POST | `/api/loans/:id/repayments` | admin, officer |
| GET/POST | `/api/investments` | admin (create); staff (read) |
| POST | `/api/investments/:id/income` | admin |
| GET/PUT | `/api/settings` | any (read); admin (write) |
| GET/POST | `/api/users` | admin |
| GET | `/api/reports/summary` | staff |
| GET | `/api/audit` | admin, auditor |

## Roadmap

- Member self-service portal screens for statements and loan schedules (API already enforces access).
- PDF statements and printable loan schedules.
- Mobile-money and bank-transfer import for deposits and repayments.
- Penalties for late payment and guarantor tracking.
- Regulatory and Board reports once their formats are confirmed.

## Deploy to Render

The repo includes `render.yaml`, which creates one web service (API and web app) and one PostgreSQL database.

1. Push this repo to GitHub (done: `korensorenu-byte/WNBSL`).
2. In Render, choose **New > Blueprint** and select this repository.
3. When prompted, enter `ADMIN_EMAIL` (the first administrator's login email) and `ADMIN_PASSWORD` (12+ characters).
4. Wait for the first deploy to finish, then open the service URL Render shows (for example `https://wnbsls.onrender.com`).
5. Sign in with the admin email and password you entered.

`JWT_SECRET` is generated automatically by Render.

Notes:
- **Free plans:** the web service sleeps when idle, so the first visit can take about 30 seconds. The free database expires after 30 days. Upgrade both before entering real member data.
- **Changing the admin password:** the seed only creates the admin once. To change it later, add a user or change the password through the database.
- **Backups:** turn on automated database backups in Render before going live.
- **Custom domain:** add it in the service settings and point it at Render, then keep HTTPS on.

## Deploy to Railway

The repo includes `railway.json` and a root `package.json`, so Railway builds and starts the app from the repo root.

1. In Railway, create a project: **New Project > Deploy from GitHub repo**, and select `korensorenu-byte/WNBSL`. Allow Railway access to the repo if asked.
2. In the same project, click **+ New > Database > Add PostgreSQL**.
3. Open the app service, go to **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway fills this in from the database service)
   - `DATABASE_SSL` = `false` (the internal connection doesn't use TLS)
   - `JWT_SECRET` = a random string of 32+ characters (for example, from a password generator)
   - `ADMIN_EMAIL` = the first administrator's login email
   - `ADMIN_PASSWORD` = 12+ characters
4. Under **Settings > Networking**, click **Generate Domain** to get a public `*.up.railway.app` address.
5. Wait for the deploy to show **Active**, then open the domain and sign in.

Railway sets `PORT` automatically. Migrations and the admin seed run on each start and are safe to repeat.

## Deploy to Fly.io

Fly runs the Dockerfile in the repo. Fly requires a valid credit card on the account for most uses. Prepaid cards can only buy credits, not serve as the saved payment method.

1. Install the Fly CLI (`brew install flyctl` on macOS, or `curl -L https://fly.io/install.sh | sh` on Linux) and run `fly auth login`.
2. In the repo folder, run `fly launch --no-deploy --copy-config`. Keep the existing `fly.toml`, and pick a unique app name if `wnbsls` is taken.
3. Create a PostgreSQL database and attach it. This sets the `DATABASE_URL` secret for you:
   `fly postgres create --name wnbsls-db --region syd` then `fly postgres attach wnbsls-db --app <your-app>`
4. Set the secrets:
   `fly secrets set JWT_SECRET=<32+ random characters> ADMIN_EMAIL=<email> ADMIN_PASSWORD=<12+ characters> --app <your-app>`
5. Deploy: `fly deploy --app <your-app>`. Then open `https://<your-app>.fly.dev`.

Fly may show a different `postgres` command for newer managed databases. Follow the prompts if so.

## Use Neon for the database (Render)

1. Create a project at neon.tech and choose the region closest to you.
2. Copy the connection string (it starts with `postgresql://` and includes `sslmode=require`).
3. In Render, open the `wnbsls` service, go to **Environment**, and set:
   - `DATABASE_URL` = the Neon connection string (paste it here only, never in chat or in the repo)
   - `DATABASE_SSL` = `true`
4. Click **Manual Deploy > Deploy latest commit**.

Neon's free plan pauses the database after a few minutes of inactivity; the first request after a pause is slower.


## Onboarding, invitations and email

- **Landing page** (`/`): about the Society, a loan calculator, a public membership request form and a sign-in button.
- **Staff accounts** are created only by invitation. The administrator sends an invitation from **Team & invitations**. The person receives an email with a one-time link (valid 7 days) and chooses a password.
- **Roles:** `admin` (approves, configures, invites staff), `officer` (loan officer: members, membership requests, loan applications, invites members), `cashier` (cash desk: deposits, withdrawals, share purchases and repayments), `auditor` (read-only), `member` (own records and loan applications).
- **Customers** are invited to their own portal from the member record (or when a membership request is approved). Members can sign in only after accepting the link.
- **Email notifications** are sent for: staff and member invitations, membership request received (applicant and administrators), membership approved or declined, loan approved, rejected or disbursed, and repayments received. The administrator sees every attempt under **Settings & audit → Email log**.

### Configuring email (Resend)

1. Create an account at resend.com and verify a sending domain.
2. Set `RESEND_API_KEY`, `MAIL_FROM` (for example `WNBSLS <noreply@yourdomain.org>`) and `APP_URL` (the public address of the site) in the server environment.
3. Without `RESEND_API_KEY`, emails are printed to the server log and the invitation link is shown on screen, so the workflow can be tested locally.

### Deployment note

Set `APP_URL` to the public address of the deployed site, otherwise invitation links will point to localhost.


## Member portal, loan market and earnings

Customers sign in to their own portal after accepting an invitation.

- **Overview:** savings, share capital, earnings held, loans outstanding, money invested, interest earned, upcoming repayments and recent activity.
- **Loan market:** compare loan products, apply for a loan, and compare up to three open loans side by side (rate, term, monthly payment, total interest, funding progress). Borrowers are anonymous to other members.
- **Fund a loan:** a member commits part or all of an open loan from a savings account. Members cannot fund their own loans. A loan is paid out only once it is fully funded.
- **My loans:** outstanding balance, schedule, overdue amounts, and repayment from savings or from held earnings.
- **My investments:** each position with its stage (waiting for funding, earning, or repaid), capital returned, and interest earned.
- **Earnings & transfers:** interest goes to savings automatically by default. A member can choose to hold it as earnings and then move it to savings, or use it to repay a loan.

### How the money moves

- Funding a loan debits the member's savings and is recorded against that loan.
- Each repayment is split between investors in proportion to their share. Every investor's interest and capital return is recorded per repayment in `investment_distributions`.
- Interest and returned capital are credited to the investor's savings (or held as earnings, if they chose that).
- Loan products are managed by the administrator. A rate change applies to new applications only.

### Deployment

Run migrations after deploying (`npm run migrate`). Migration `003` adds loan products, investments, distributions and earnings, and it creates a default "General Loan" product.


## Password reset

Anyone can request a reset from **Forgot password?** on the sign-in page (members and staff alike). The email link works once and expires after one hour. The reply is the same whether or not the email is registered, so accounts can't be probed. Setting a new password signs the user in and sends a notice that the password changed.

## Other investments (not loans)

Administrators offer four types, managed under **Settings & audit**:
- **Fixed deposit:** a fixed term and rate. Principal and simple interest return to the member's savings account at maturity. The payout runs automatically every six hours, or on demand from the same screen.
- **Project or business shares, agriculture co-operative shares, property or land:** the administrator declares a return. It is shared between holders in proportion to what they hold, and credited to savings or held as earnings according to each member's choice.

Loan investments (funding specific loans) remain separate.

## Loan payout

When a fully funded loan is disbursed, the amount is credited to the borrower's savings account and then debited as the payout. Both entries appear on the statement, so the loan can be traced from the account.

## Student investment accounts

- A parent opens an account for a child under 18 from **Children's accounts**. The child's record is created with the date of birth, and the parent can add money while the child is under 18.
- Before 18, money in the account can't be withdrawn, moved to an investment, or otherwise transferred out, except for an **approved medical withdrawal**. The parent submits the request with the need and the evidence location, and an administrator approves or declines it. Approval moves the money to the parent's savings and records it.
- On the child's 18th birthday the account is theirs. The system emails them an invitation to create their own login (the daily job runs automatically), and the parent loses access. The child's email must be on file for the invitation to be sent.
- Dates are worked out in the Society's timezone (`SOCIETY_TIMEZONE`, default `Pacific/Port_Moresby`), so birthdays take effect on the right day.

## PNG LLG ward platform integration

Households are pushed from the ward platform to the Society's system. New people arrive as **pending review** and are not members until staff approve them on the Officer desk.

1. An administrator creates a key under **Settings & audit → Ward platform connection**. The key is shown once.
2. The ward platform sends each household to `POST /api/integrations/ward/households` with the header `X-Api-Key: <key>` and this JSON body:

```json
{
  "externalRef": "WARD1-HH-0001",
  "wardCode": "NAL-01",
  "village": "Aling Tais 1",
  "head": { "name": "Joseph Mopeng", "address": "Aling Tais 1, Nalobu Ward 1" },
  "members": [
    { "externalRef": "WARD1-P-0001", "fullName": "Joseph Mopeng", "dateOfBirth": "1978-03-02",
      "sex": "male", "relationshipToHead": "head", "phone": "70111222", "email": "optional@example.com", "idNumber": "optional" },
    { "externalRef": "WARD1-P-0002", "fullName": "Grace Mopeng", "dateOfBirth": "1982-07-19",
      "sex": "female", "relationshipToHead": "spouse" }
  ]
}
```

- Pushes are idempotent: the same `externalRef` updates the existing record, so the platform can resend safely. Up to 50 members per request.
- Each member is validated separately. A bad row is reported in `errors` and the rest still save. Status `202` means accepted; `422` means nothing could be saved.
- Field names are a proposal. If the ward platform uses different names, the mapping is a small change in `server/src/routes/integrations.js`. Please share the platform's field list so the mapping can be confirmed.

## Deployment changes

Run `npm run migrate` (migration `004` adds password resets, student accounts, investment products, households and integration keys). Optional new variable: `SOCIETY_TIMEZONE`.
