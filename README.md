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
