-- Persisted generation history (user-scoped). The frontend "历史资产" panel was
-- localStorage-only; this table lets a user's generation history survive a
-- localStorage wipe and follow them across devices. space_id / space_type /
-- project_id are stored now so team-shared history can be enabled later once a
-- backend workspace-membership model exists (today reads are scoped by user_id).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS generation_history (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id         TEXT NOT NULL,
    space_id          TEXT NOT NULL DEFAULT '',
    space_type        TEXT NOT NULL DEFAULT 'personal',
    project_id        TEXT NOT NULL DEFAULT '',
    item_type         TEXT NOT NULL DEFAULT '',
    media_type        TEXT NOT NULL DEFAULT 'image',
    title             TEXT NOT NULL DEFAULT '',
    thumbnail         TEXT NOT NULL DEFAULT '',
    content           TEXT NOT NULL DEFAULT '',
    aspect_ratio      TEXT NOT NULL DEFAULT '',
    prompt_excerpt    TEXT NOT NULL DEFAULT '',
    source_node_id    TEXT NOT NULL DEFAULT '',
    derivation_action TEXT NOT NULL DEFAULT '',
    client_ts         BIGINT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (user, client item id) so re-syncing the same item is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS generation_history_user_client_idx
    ON generation_history (user_id, client_id);

-- List newest-first for a user, optionally within a space.
CREATE INDEX IF NOT EXISTS generation_history_user_ts_idx
    ON generation_history (user_id, client_ts DESC);
CREATE INDEX IF NOT EXISTS generation_history_user_space_ts_idx
    ON generation_history (user_id, space_id, client_ts DESC);
