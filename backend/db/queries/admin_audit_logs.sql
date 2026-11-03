-- name: CreateAdminAuditLog :one
INSERT INTO admin_audit_logs (
    request_id, actor_user_id, actor_name, actor_email,
    action, target_type, target_id, target_label,
    method, route, status, summary, metadata
)
VALUES (
    $1,
    NULLIF($2::text, '')::uuid,
    COALESCE((SELECT name FROM users WHERE id = NULLIF($2::text, '')::uuid), ''),
    COALESCE((SELECT email FROM users WHERE id = NULLIF($2::text, '')::uuid), ''),
    $3, $4, $5, $6, $7, $8, 'started', $9, $10
)
RETURNING id;

-- name: FinishAdminAuditLog :exec
UPDATE admin_audit_logs
SET status = $2,
    http_status = $3,
    error_code = $4,
    duration_ms = $5,
    completed_at = now()
WHERE id = $1;

-- name: ListAdminAuditLogs :many
SELECT id, request_id, actor_user_id, actor_name, actor_email,
       action, target_type, target_id, target_label,
       method, route, status, http_status, error_code, summary,
       metadata, duration_ms, created_at, completed_at
FROM admin_audit_logs
WHERE ($1::text = '' OR actor_name ILIKE '%' || $1 || '%' OR actor_email ILIKE '%' || $1 || '%')
  AND ($2::text = '' OR action = $2)
  AND ($3::text = '' OR target_type = $3)
  AND ($4::text = '' OR status = $4)
  AND ($5::text = '' OR request_id = $5)
  AND ($6::timestamptz IS NULL OR created_at >= $6)
  AND ($7::timestamptz IS NULL OR created_at <= $7)
ORDER BY created_at DESC, id DESC
LIMIT $8 OFFSET $9;

-- name: CountAdminAuditLogs :one
SELECT count(*)::int
FROM admin_audit_logs
WHERE ($1::text = '' OR actor_name ILIKE '%' || $1 || '%' OR actor_email ILIKE '%' || $1 || '%')
  AND ($2::text = '' OR action = $2)
  AND ($3::text = '' OR target_type = $3)
  AND ($4::text = '' OR status = $4)
  AND ($5::text = '' OR request_id = $5)
  AND ($6::timestamptz IS NULL OR created_at >= $6)
  AND ($7::timestamptz IS NULL OR created_at <= $7);
