-- name: ListProjectComments :many
-- 某项目全部评论(含作者名),时间正序,前端按 node_id/parent_id 组线程。
SELECT c.id, c.project_id, c.node_id, c.author_id, c.parent_id, c.body, c.resolved, c.created_at,
       u.name AS author_name
FROM canvas_comments c
JOIN users u ON u.id = c.author_id
WHERE c.project_id = $1
ORDER BY c.created_at ASC
LIMIT 2000;

-- name: InsertComment :one
INSERT INTO canvas_comments (project_id, node_id, author_id, parent_id, body)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, project_id, node_id, author_id, parent_id, body, resolved, created_at;

-- name: GetCommentByID :one
SELECT id, project_id, author_id FROM canvas_comments WHERE id = $1;

-- name: SetCommentResolved :exec
UPDATE canvas_comments SET resolved = $2 WHERE id = $1;

-- name: DeleteComment :exec
DELETE FROM canvas_comments WHERE id = $1;
