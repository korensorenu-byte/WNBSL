-- Loan products, member funding of loans, investor distributions, and member earnings.

CREATE TABLE IF NOT EXISTS loan_products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  annual_rate_pct   NUMERIC(6,2) NOT NULL CHECK (annual_rate_pct >= 0),
  method            TEXT NOT NULL DEFAULT 'reducing' CHECK (method IN ('reducing','flat')),
  max_amount_toea   BIGINT NOT NULL CHECK (max_amount_toea > 0),
  max_term_months   INTEGER NOT NULL CHECK (max_term_months > 0),
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO loan_products (name, description, annual_rate_pct, method, max_amount_toea, max_term_months)
VALUES ('General Loan', 'Everyday borrowing for household and small needs.', 12, 'reducing', 5000000, 36)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES loan_products(id);
UPDATE loans SET product_id = (SELECT id FROM loan_products WHERE name = 'General Loan') WHERE product_id IS NULL;

-- A member's share of a loan. Money comes from the member's savings account.
CREATE TABLE IF NOT EXISTS loan_investments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                UUID NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  member_id              UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  amount_toea            BIGINT NOT NULL CHECK (amount_toea > 0),
  savings_transaction_id UUID REFERENCES savings_transactions(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_investments_loan ON loan_investments(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_investments_member ON loan_investments(member_id);

-- How each repayment was shared with each investor.
CREATE TABLE IF NOT EXISTS investment_distributions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_investment_id  UUID NOT NULL REFERENCES loan_investments(id) ON DELETE RESTRICT,
  repayment_id        UUID NOT NULL REFERENCES loan_repayments(id) ON DELETE RESTRICT,
  interest_toea       BIGINT NOT NULL DEFAULT 0 CHECK (interest_toea >= 0),
  principal_toea      BIGINT NOT NULL DEFAULT 0 CHECK (principal_toea >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where a member's loan interest goes: straight to savings (default) or held as earnings.
ALTER TABLE members ADD COLUMN IF NOT EXISTS interest_destination TEXT NOT NULL DEFAULT 'savings'
  CHECK (interest_destination IN ('savings','hold'));

-- Earnings held from loan interest, and transfers out of them.
CREATE TABLE IF NOT EXISTS earnings_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  type        TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount_toea BIGINT NOT NULL CHECK (amount_toea > 0),
  loan_id     UUID REFERENCES loans(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_earnings_member ON earnings_ledger(member_id);

-- Record where a repayment came from.
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'cash'
  CHECK (source IN ('cash','savings','earnings'));
