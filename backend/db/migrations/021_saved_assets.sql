-- Persisted user asset library ("素材库 / 我的素材 / 我的主体库", user-scoped). The
-- frontend library was localStorage-only, so saved assets were lost on a cache
-- wipe and never followed the user across devices. This table mirrors the
-- generation_history design (idempotent upsert keyed by (user_id, client_id)).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS saved_assets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id     TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT 'other',
    kind          TEXT NOT NULL DEFAULT 'image',
    thumbnail     TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    text_content  TEXT NOT NULL DEFAULT '',
    client_ts     BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (user, client asset id) so re-syncing the same asset is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS saved_assets_user_client_idx
    ON saved_assets (user_id, client_id);

-- List newest-first for a user.
CREATE INDEX IF NOT EXISTS saved_assets_user_ts_idx
    ON saved_assets (user_id, client_ts DESC);
