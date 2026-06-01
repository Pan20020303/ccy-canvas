-- name: InsertGenerationLog :one
INSERT INTO generation_logs (user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at;

-- name: ListGenerationLogs :many
SELECT id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at
FROM generation_logs
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: CountGenerationLogs :one
SELECT count(*)::int AS total FROM generation_logs;

-- name: CountGenerationsToday :one
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'success')::int AS success,
       count(*) FILTER (WHERE status = 'error')::int AS errors
FROM generation_logs
WHERE created_at >= CURRENT_DATE;
