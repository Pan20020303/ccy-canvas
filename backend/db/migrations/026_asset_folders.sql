-- 素材库文件夹:用户自建、可把素材拖入、可命名。与 saved_assets 一样按
-- (user_id, client_id) 幂等 upsert。素材归属用 saved_assets.folder_id 表示,
-- folder_id = '' 即根目录。幂等:可重复执行。

ALTER TABLE saved_assets ADD COLUMN IF NOT EXISTS folder_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS asset_folders (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    client_ts  BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_folders_user_client_idx
    ON asset_folders (user_id, client_id);

CREATE INDEX IF NOT EXISTS saved_assets_user_folder_idx
    ON saved_assets (user_id, folder_id);
