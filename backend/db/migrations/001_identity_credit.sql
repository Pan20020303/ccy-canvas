CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  initial_daily_quota integer NOT NULL CHECK (initial_daily_quota >= 0),
  max_uses integer NOT NULL CHECK (max_uses > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE invitation_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES invitations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  email text NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  daily_quota integer NOT NULL CHECK (daily_quota >= 0),
  current_balance integer NOT NULL CHECK (current_balance >= 0),
  reset_timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  last_reset_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES credit_accounts(id),
  type text NOT NULL CHECK (type IN ('daily_reset', 'reserve', 'charge', 'refund', 'admin_adjustment')),
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  generation_job_id uuid,
  model_id uuid,
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_entries_user_created_idx ON credit_ledger_entries(user_id, created_at DESC);
CREATE INDEX invitations_created_by_idx ON invitations(created_by, created_at DESC);
