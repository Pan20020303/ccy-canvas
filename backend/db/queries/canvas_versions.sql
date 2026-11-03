-- name: InsertCanvasVersion :one
INSERT INTO canvas_versions (project_id, nodes, edges, groups, label, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, created_at;

-- name: ListCanvasVersions :many
-- 版本列表(不含 nodes/edges 以减负),含创建者名。
SELECT v.id, v.label, v.created_by, v.created_at, COALESCE(u.name, '') AS author_name
FROM canvas_versions v
LEFT JOIN users u ON u.id = v.created_by
WHERE v.project_id = $1
ORDER BY v.created_at DESC
LIMIT 100;

-- name: GetCanvasVersion :one
SELECT id, project_id, nodes, edges, groups FROM canvas_versions WHERE id = $1;

-- name: PruneCanvasVersions :exec
-- 只保留某项目最新 N 个版本,防 jsonb 无限增长。
DELETE FROM canvas_versions
WHERE project_id = $1
  AND id NOT IN (
    SELECT id FROM canvas_versions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2
  );
