-- name: ListAnnouncements :many
SELECT a.id, a.title, a.content, a.created_at,
       COALESCE(u.name, '') AS creator_name
FROM announcements a
LEFT JOIN users u ON u.id = a.created_by
ORDER BY a.created_at DESC
LIMIT $1;

-- name: InsertAnnouncement :one
INSERT INTO announcements (title, content, created_by)
VALUES ($1, $2, $3)
RETURNING id, title, content, created_at;

-- name: DeleteAnnouncement :exec
DELETE FROM announcements WHERE id = $1;
