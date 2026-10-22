-- Collaborative project credit pool and member allocations.
-- Personal balances fund the pool; generation inside a collaborative project
-- consumes the pool and records the requesting member's usage.

ALTER TABLE credit_ledger_entries DROP CONSTRAINT IF EXISTS credit_ledger_entries_type_check;
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_type_check
  CHECK (type IN (
    'daily_reset', 'reserve', 'charge', 'refund', 'admin_adjustment',
    'project_transfer_out', 'project_refund_in'
  ));

CREATE TABLE IF NOT EXISTS project_credit_accounts (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  current_balance bigint NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  total_funded bigint NOT NULL DEFAULT 0 CHECK (total_funded >= 0),
  total_consumed bigint NOT NULL DEFAULT 0 CHECK (total_consumed >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_credit_member_limits (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quota bigint CHECK (quota IS NULL OR quota >= 0),
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Tracks how much each manager has funded. Refunds can only return that
-- manager's remaining contribution, so one manager cannot withdraw another's.
CREATE TABLE IF NOT EXISTS project_credit_contributions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_remaining bigint NOT NULL DEFAULT 0 CHECK (amount_remaining >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('transfer_in', 'refund_out', 'reserve', 'refund', 'quota_update')),
  amount bigint NOT NULL,
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  member_used_after bigint,
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_credit_ledger_project_created_idx
  ON project_credit_ledger_entries(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_credit_ledger_user_created_idx
  ON project_credit_ledger_entries(user_id, created_at DESC);
