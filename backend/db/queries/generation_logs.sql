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

-- name: GetGenerationLogByIDForUser :one
-- Lookup a specific generation log by ID, scoped to the requesting user
-- so a malicious client can't poll someone else's task state.
SELECT id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at
FROM generation_logs
WHERE id = $1 AND user_id = $2;

-- name: GetLatestGenerationLogsForUserNodes :many
-- For each (node_id) in the given list, return the most recent log row
-- owned by this user. Powers the frontend's reload-recovery polling:
-- when the browser doesn't have a task_id (e.g. after a refresh), it
-- batch-asks "what's the latest state for these N nodes I think are
-- still running?".
SELECT DISTINCT ON (node_id)
       id, user_id, node_id, service_type, model, prompt, status, result_url, error_msg, duration_ms, cost, created_at
FROM generation_logs
WHERE user_id = $1
  AND node_id = ANY($2::text[])
ORDER BY node_id, created_at DESC;

-- name: GetInflightGenerationLogByNode :one
-- 节点级在途去重：同一用户、同一节点、同一模型、同一提示词若已有在途任务
-- (pending/queued/running/retrying)，返回最近一条。用于挡「一段时间没返回就
-- 重发一条一样的请求」——图片/视频异步队列每次提交 request_id 都是新随机值，
-- 上面的 request_id 快路挡不住用户手动重发，这里按内容兜底避免重复 reserve/扣费。
-- 只匹配完全相同的请求（改提示词/换模型即视为新生成，不误挡 re-roll）。
SELECT id, user_id, node_id, service_type, model, status, created_at
FROM generation_logs
WHERE user_id = $1
  AND node_id = $2
  AND service_type = $3
  AND model = $4
  AND prompt = $5
  AND status IN ('pending', 'queued', 'running', 'retrying')
ORDER BY created_at DESC
LIMIT 1;
