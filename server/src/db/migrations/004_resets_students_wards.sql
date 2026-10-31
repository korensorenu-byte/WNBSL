-- Password reset, member investment products, student investment accounts,
-- and household registration from the PNG LLG ward platform.

-- ---- Password reset (all users) ----
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Households and ward registration ----
CREATE TABLE IF NOT EXISTS households (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  ward_code    TEXT,
  village      TEXT,
  head_name    TEXT,
  address      TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS relationship_to_head TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS household_id UUID REFERENCES households(id);
ALTER TABLE members ADD COLUMN IF NOT EXISTS ward_code TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS external_ref TEXT UNIQUE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS ward_payload JSONB;
ALTER TABLE members ADD COLUMN IF NOT EXISTS guardian_member_id UUID REFERENCES members(id);
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_status_check;
ALTER TABLE members ADD CONSTRAINT members_status_check
  CHECK (status IN ('active','suspended','exited','pending_review'));

-- ---- Student investment accounts: a savings account held for a child by a parent ----
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS guardian_member_id UUID REFERENCES members(id);

-- Medical withdrawal requests from a student account (approved by the administrator).
CREATE TABLE IF NOT EXISTS medical_withdrawal_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_account_id UUID NOT NULL REFERENCES savings_accounts(id) ON DELETE RESTRICT,
  guardian_member_id UUID NOT NULL REFERENCES members(id),
  amount_toea        BIGINT NOT NULL CHECK (amount_toea > 0),
  reason             TEXT NOT NULL,
  evidence_note      TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  decision_note      TEXT,
  decided_by         UUID REFERENCES users(id),
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Member investment products (separate from loan investments) ----
CREATE TABLE IF NOT EXISTS investment_products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('fixed_deposit','project_shares','agri_shares','property')),
  description      TEXT,
  annual_rate_pct  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (annual_rate_pct >= 0),
  term_months      INTEGER CHECK (term_months IS NULL OR term_months > 0),
  min_amount_toea  BIGINT NOT NULL DEFAULT 0 CHECK (min_amount_toea >= 0),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_investments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID NOT NULL REFERENCES investment_products(id) ON DELETE RESTRICT,
  member_id          UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  savings_account_id UUID NOT NULL REFERENCES savings_accounts(id) ON DELETE RESTRICT,
  principal_toea     BIGINT NOT NULL CHECK (principal_toea > 0),
  rate_pct           NUMERIC(6,2) NOT NULL,
  start_on           DATE NOT NULL,
  maturity_on        DATE,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','matured')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Declared returns for share and property products, shared pro-rata by holders.
CREATE TABLE IF NOT EXISTS product_distributions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES investment_products(id) ON DELETE RESTRICT,
  amount_toea BIGINT NOT NULL CHECK (amount_toea > 0),
  note        TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_investment_income (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_investment_id UUID NOT NULL REFERENCES member_investments(id) ON DELETE RESTRICT,
  distribution_id     UUID REFERENCES product_distributions(id) ON DELETE RESTRICT,
  amount_toea         BIGINT NOT NULL CHECK (amount_toea > 0),
  kind                TEXT NOT NULL CHECK (kind IN ('interest','maturity','distribution')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keys that the PNG LLG ward platform uses to push households. Only a hash is stored.
CREATE TABLE IF NOT EXISTS integration_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_members_household ON members(household_id);
CREATE INDEX IF NOT EXISTS idx_members_guardian ON members(guardian_member_id);
