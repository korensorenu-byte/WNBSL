-- Adds the cashier role, invitation-based onboarding, public membership requests and a notification log.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','officer','cashier','auditor','member'));

-- Single-use invitation links. Only a SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','officer','cashier','auditor','member')),
  full_name   TEXT,
  member_id   UUID REFERENCES members(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  invited_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_invitation_per_email
  ON invitations (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Public requests to join the Society. Staff approve or decline them.
CREATE TABLE IF NOT EXISTS membership_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  village     TEXT,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  member_id   UUID REFERENCES members(id) ON DELETE SET NULL,
  decline_reason TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  decided_by  UUID REFERENCES users(id)
);

-- Every email attempt is recorded so staff can see what was sent or failed.
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent','failed','logged')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
