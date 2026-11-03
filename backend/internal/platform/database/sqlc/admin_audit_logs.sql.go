// Hand-authored sqlc-style bindings for admin_audit_logs.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type AdminAuditLog struct {
	ID          pgtype.UUID        `json:"id"`
	RequestID   string             `json:"request_id"`
	ActorUserID pgtype.UUID        `json:"actor_user_id"`
	ActorName   string             `json:"actor_name"`
	ActorEmail  string             `json:"actor_email"`
	Action      string             `json:"action"`
	TargetType  string             `json:"target_type"`
	TargetID    string             `json:"target_id"`
	TargetLabel string             `json:"target_label"`
	Method      string             `json:"method"`
	Route       string             `json:"route"`
	Status      string             `json:"status"`
	HTTPStatus  pgtype.Int4        `json:"http_status"`
	ErrorCode   string             `json:"error_code"`
	Summary     string             `json:"summary"`
	Metadata    []byte             `json:"metadata"`
	DurationMs  pgtype.Int4        `json:"duration_ms"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
	CompletedAt pgtype.Timestamptz `json:"completed_at"`
}

type CreateAdminAuditLogParams struct {
	RequestID   string `json:"request_id"`
	ActorUserID string `json:"actor_user_id"`
	Action      string `json:"action"`
	TargetType  string `json:"target_type"`
	TargetID    string `json:"target_id"`
	TargetLabel string `json:"target_label"`
	Method      string `json:"method"`
	Route       string `json:"route"`
	Summary     string `json:"summary"`
	Metadata    []byte `json:"metadata"`
}

const createAdminAuditLog = `-- name: CreateAdminAuditLog :one
INSERT INTO admin_audit_logs (
    request_id, actor_user_id, actor_name, actor_email,
    action, target_type, target_id, target_label,
    method, route, status, summary, metadata
)
VALUES (
    $1, NULLIF($2::text, '')::uuid,
    COALESCE((SELECT name FROM users WHERE id = NULLIF($2::text, '')::uuid), ''),
    COALESCE((SELECT email FROM users WHERE id = NULLIF($2::text, '')::uuid), ''),
    $3, $4, $5, $6, $7, $8, 'started', $9, $10
)
RETURNING id
`

func (q *Queries) CreateAdminAuditLog(ctx context.Context, arg CreateAdminAuditLogParams) (pgtype.UUID, error) {
	var id pgtype.UUID
	err := q.db.QueryRow(ctx, createAdminAuditLog,
		arg.RequestID, arg.ActorUserID, arg.Action, arg.TargetType,
		arg.TargetID, arg.TargetLabel, arg.Method, arg.Route,
		arg.Summary, arg.Metadata,
	).Scan(&id)
	return id, err
}

type FinishAdminAuditLogParams struct {
	ID         pgtype.UUID `json:"id"`
	Status     string      `json:"status"`
	HTTPStatus int32       `json:"http_status"`
	ErrorCode  string      `json:"error_code"`
	DurationMs int32       `json:"duration_ms"`
}

const finishAdminAuditLog = `-- name: FinishAdminAuditLog :exec
UPDATE admin_audit_logs
SET status = $2, http_status = $3, error_code = $4, duration_ms = $5, completed_at = now()
WHERE id = $1
`

func (q *Queries) FinishAdminAuditLog(ctx context.Context, arg FinishAdminAuditLogParams) error {
	_, err := q.db.Exec(ctx, finishAdminAuditLog,
		arg.ID, arg.Status, arg.HTTPStatus, arg.ErrorCode, arg.DurationMs,
	)
	return err
}

type ListAdminAuditLogsParams struct {
	Actor      string             `json:"actor"`
	Action     string             `json:"action"`
	TargetType string             `json:"target_type"`
	Status     string             `json:"status"`
	RequestID  string             `json:"request_id"`
	From       pgtype.Timestamptz `json:"from"`
	To         pgtype.Timestamptz `json:"to"`
	Limit      int32              `json:"limit"`
	Offset     int32              `json:"offset"`
}

const listAdminAuditLogs = `-- name: ListAdminAuditLogs :many
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
LIMIT $8 OFFSET $9
`

func (q *Queries) ListAdminAuditLogs(ctx context.Context, arg ListAdminAuditLogsParams) ([]AdminAuditLog, error) {
	rows, err := q.db.Query(ctx, listAdminAuditLogs,
		arg.Actor, arg.Action, arg.TargetType, arg.Status, arg.RequestID,
		arg.From, arg.To, arg.Limit, arg.Offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AdminAuditLog{}
	for rows.Next() {
		var item AdminAuditLog
		if err := rows.Scan(
			&item.ID, &item.RequestID, &item.ActorUserID, &item.ActorName, &item.ActorEmail,
			&item.Action, &item.TargetType, &item.TargetID, &item.TargetLabel,
			&item.Method, &item.Route, &item.Status, &item.HTTPStatus, &item.ErrorCode,
			&item.Summary, &item.Metadata, &item.DurationMs, &item.CreatedAt, &item.CompletedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type CountAdminAuditLogsParams struct {
	Actor      string             `json:"actor"`
	Action     string             `json:"action"`
	TargetType string             `json:"target_type"`
	Status     string             `json:"status"`
	RequestID  string             `json:"request_id"`
	From       pgtype.Timestamptz `json:"from"`
	To         pgtype.Timestamptz `json:"to"`
}

const countAdminAuditLogs = `-- name: CountAdminAuditLogs :one
SELECT count(*)::int
FROM admin_audit_logs
WHERE ($1::text = '' OR actor_name ILIKE '%' || $1 || '%' OR actor_email ILIKE '%' || $1 || '%')
  AND ($2::text = '' OR action = $2)
  AND ($3::text = '' OR target_type = $3)
  AND ($4::text = '' OR status = $4)
  AND ($5::text = '' OR request_id = $5)
  AND ($6::timestamptz IS NULL OR created_at >= $6)
  AND ($7::timestamptz IS NULL OR created_at <= $7)
`

func (q *Queries) CountAdminAuditLogs(ctx context.Context, arg CountAdminAuditLogsParams) (int32, error) {
	var total int32
	err := q.db.QueryRow(ctx, countAdminAuditLogs,
		arg.Actor, arg.Action, arg.TargetType, arg.Status, arg.RequestID, arg.From, arg.To,
	).Scan(&total)
	return total, err
}
