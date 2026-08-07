-- name: InsertSkillRun :one
INSERT INTO skill_runs (user_id, agent_id, skill_id, inputs, outputs, status, error_msg, duration_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, user_id, agent_id, skill_id, inputs, outputs, status, error_msg, duration_ms, created_at;

-- name: UpdateSkillRunResult :exec
UPDATE skill_runs
SET outputs = $2,
    status = $3,
    error_msg = $4,
    duration_ms = $5
WHERE id = $1;

-- name: ListSkillRunsForUser :many
SELECT id, user_id, agent_id, skill_id, inputs, outputs, status, error_msg, duration_ms, created_at
FROM skill_runs
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;
