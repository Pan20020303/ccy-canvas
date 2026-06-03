-- name: InsertGenerationLog :one
INSERT INTO generation_logs (user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at;

-- name: UpdateGenerationLogResult :exec
UPDATE generation_logs
SET status = $2,
    result_url = $3,
    error_msg = $4,
    duration_ms = $5
WHERE id = $1;

-- name: ListGenerationLogs :many
SELECT id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at
FROM generation_logs
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListGenerationLogsWithUser :many
SELECT g.id, g.user_id, g.node_id, g.service_type, g.model, g.prompt, g.status, g.result_url, g.error_msg, g.duration_ms, g.cost, g.created_at,
       COALESCE(u.email, '') AS user_email,
       COALESCE(u.name, '')  AS user_name
FROM generation_logs g
LEFT JOIN users u ON u.id = g.user_id
WHERE ($1::text = '' OR g.status = $1)
  AND ($2::text = '' OR COALESCE(u.name, '') ILIKE '%' || $2 || '%' OR COALESCE(u.email, '') ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR g.model ILIKE '%' || $3 || '%')
ORDER BY g.created_at DESC
LIMIT $4 OFFSET $5;

-- name: CountGenerationLogs :one
SELECT count(*)::int AS total FROM generation_logs;

-- name: CountGenerationLogsWithFilter :one
SELECT count(*)::int AS total
FROM generation_logs g
LEFT JOIN users u ON u.id = g.user_id
WHERE ($1::text = '' OR g.status = $1)
  AND ($2::text = '' OR COALESCE(u.name, '') ILIKE '%' || $2 || '%' OR COALESCE(u.email, '') ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR g.model ILIKE '%' || $3 || '%');

-- name: CountGenerationsToday :one
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'success')::int AS success,
       count(*) FILTER (WHERE status = 'error')::int AS errors
FROM generation_logs
WHERE created_at >= CURRENT_DATE;
