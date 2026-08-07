-- 画布分组持久化：canvas_snapshots 此前只存 nodes/edges，分组只活在前端
-- localStorage 里 —— 从首页重新进入项目时服务端画布回填会把 groups 置空。
ALTER TABLE canvas_snapshots ADD COLUMN IF NOT EXISTS groups JSONB NOT NULL DEFAULT '[]';
