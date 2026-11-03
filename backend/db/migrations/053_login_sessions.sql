-- Tracked browser logins. Existing stateless cookies remain valid until the
-- user first revokes another device; /api/auth/me upgrades the current cookie.
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_sessions_disabled_at timestamptz;

CREATE TABLE IF NOT EXISTS login_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  legacy_key text UNIQUE,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS login_sessions_user_active_idx
  ON login_sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
