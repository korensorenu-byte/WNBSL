-- WNBSLS Savings, Loans & Investment Management - initial schema
-- Money is stored as BIGINT toea (1 kina = 100 toea) to avoid floating-point errors.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human-readable, gap-free-ish reference numbers.
CREATE SEQUENCE IF NOT EXISTS member_no_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS account_no_seq START 100001;
CREATE SEQUENCE IF NOT EXISTS loan_no_seq START 5001;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','officer','auditor','member')),
  member_id     UUID,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_no    TEXT NOT NULL UNIQUE,
  full_name    TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  village      TEXT,
  id_type      TEXT,
  id_number    TEXT,
  joined_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','exited')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD CONSTRAINT users_member_fk FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL;

-- Share capital ledger: subscriptions add, withdrawals subtract.
CREATE TABLE IF NOT EXISTS share_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  type        TEXT NOT NULL CHECK (type IN ('subscription','withdrawal')),
  amount_toea BIGINT NOT NULL CHECK (amount_toea > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS savings_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no  TEXT NOT NULL UNIQUE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  product     TEXT NOT NULL DEFAULT 'Regular Savings',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen','closed')),
  opened_on   DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Savings ledger: balance is always derived from entries (no stored balance to drift).
CREATE TABLE IF NOT EXISTS savings_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES savings_accounts(id) ON DELETE RESTRICT,
  type        TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','interest')),
  amount_toea BIGINT NOT NULL CHECK (amount_toea > 0),
  reference   TEXT,
  period      TEXT,                       -- e.g. '2026-10' for interest postings
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id),
  UNIQUE (account_id, type, period)       -- prevents double interest posting for a month
);

CREATE TABLE IF NOT EXISTS loans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_no             TEXT NOT NULL UNIQUE,
  member_id           UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  guarantor_id        UUID REFERENCES members(id) ON DELETE RESTRICT,
  principal_toea      BIGINT NOT NULL CHECK (principal_toea > 0),
  annual_rate_pct     NUMERIC(6,2) NOT NULL CHECK (annual_rate_pct >= 0),
  term_months         INTEGER NOT NULL CHECK (term_months > 0),
  method              TEXT NOT NULL DEFAULT 'reducing' CHECK (method IN ('reducing','flat')),
  purpose             TEXT,
  status              TEXT NOT NULL DEFAULT 'applied'
                      CHECK (status IN ('applied','approved','rejected','disbursed','closed','written_off')),
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at         TIMESTAMPTZ,
  approved_by         UUID REFERENCES users(id),
  disbursed_at        TIMESTAMPTZ,
  disbursed_by        UUID REFERENCES users(id),
  rejection_reason    TEXT
);

CREATE TABLE IF NOT EXISTS loan_installments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id        UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  period         INTEGER NOT NULL,
  due_date       DATE NOT NULL,
  principal_due  BIGINT NOT NULL,
  interest_due   BIGINT NOT NULL,
  principal_paid BIGINT NOT NULL DEFAULT 0,
  interest_paid  BIGINT NOT NULL DEFAULT 0,
  UNIQUE (loan_id, period)
);

CREATE TABLE IF NOT EXISTS loan_repayments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id     UUID NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  amount_toea BIGINT NOT NULL CHECK (amount_toea > 0),
  paid_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS investments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  category                 TEXT NOT NULL DEFAULT 'other',
  principal_toea           BIGINT NOT NULL CHECK (principal_toea > 0),
  expected_annual_return_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  invested_on              DATE NOT NULL DEFAULT CURRENT_DATE,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','matured','sold','lost')),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investment_income (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id UUID NOT NULL REFERENCES investments(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('return','distribution')),
  amount_toea   BIGINT NOT NULL CHECK (amount_toea > 0),
  received_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_savings_tx_account ON savings_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_share_tx_member ON share_transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_installments_due ON loan_installments(due_date);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
