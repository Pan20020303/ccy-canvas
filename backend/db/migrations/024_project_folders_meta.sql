-- 首页项目管理：文件夹 + 项目封面。
--   project_folders：用户自建的项目文件夹（首页网格里以文件夹卡片呈现）。
--   projects.cover_url：项目封面（用户在首页「修改封面」上传后写入）。
--   projects.folder_id：项目归属的文件夹；删除文件夹时项目回到根层级。
CREATE TABLE IF NOT EXISTS project_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL DEFAULT '未命名文件夹',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_folders_owner_idx ON project_folders(owner_id, created_at DESC);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS cover_url text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_id uuid NULL REFERENCES project_folders(id) ON DELETE SET NULL;
