package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type AdminAlert struct {
	ID               pgtype.UUID        `json:"id"`
	ProviderConfigID pgtype.UUID        `json:"provider_config_id"`
	GenerationLogID  pgtype.UUID        `json:"generation_log_id"`
	ServiceType      string             `json:"service_type"`
	Model            string             `json:"model"`
	ErrorCode        string             `json:"error_code"`
	ErrorMessage     string             `json:"error_message"`
	Source           string             `json:"source"`
	Severity         string             `json:"severity"`
	Status           string             `json:"status"`
	CreatedAt        pgtype.Timestamptz `json:"created_at"`
	LastSeenAt       pgtype.Timestamptz `json:"last_seen_at"`
	ProviderName     string             `json:"provider_name"`
}

type UpsertAdminAlertParams struct {
	ProviderConfigID pgtype.UUID `json:"provider_config_id"`
	GenerationLogID  pgtype.UUID `json:"generation_log_id"`
	ServiceType      string      `json:"service_type"`
	Model            string      `json:"model"`
	ErrorCode        string      `json:"error_code"`
	ErrorMessage     string      `json:"error_message"`
	Source           string      `json:"source"`
	Severity         string      `json:"severity"`
}

const upsertAdminAlert = `
INSERT INTO admin_alerts (
    provider_config_id, generation_log_id, service_type, model,
    error_code, error_message, source, severity, status
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unread')
RETURNING id
`

func (q *Queries) UpsertAdminAlert(ctx context.Context, arg UpsertAdminAlertParams) (pgtype.UUID, error) {
	row := q.db.QueryRow(ctx, upsertAdminAlert,
		arg.ProviderConfigID, arg.GenerationLogID, arg.ServiceType, arg.Model,
		arg.ErrorCode, arg.ErrorMessage, arg.Source, arg.Severity,
	)
	var id pgtype.UUID
	err := row.Scan(&id)
	return id, err
}

const countUnreadAdminAlerts = `
SELECT count(*)::int
FROM admin_alerts
WHERE status = 'unread'
`

func (q *Queries) CountUnreadAdminAlerts(ctx context.Context) (int32, error) {
	row := q.db.QueryRow(ctx, countUnreadAdminAlerts)
	var count int32
	err := row.Scan(&count)
	return count, err
}

const listAdminAlerts = `
SELECT a.id, a.provider_config_id, a.generation_log_id, a.service_type, a.model,
       a.error_code, a.error_message, a.source, a.severity, a.status,
       a.created_at, a.last_seen_at, COALESCE(p.name, '') AS provider_name
FROM admin_alerts a
LEFT JOIN provider_configs p ON p.id = a.provider_config_id
WHERE ($1::text = '' OR a.status = $1)
ORDER BY a.last_seen_at DESC
LIMIT $2 OFFSET $3
`

type ListAdminAlertsParams struct {
	Status string `json:"status"`
	Limit  int32  `json:"limit"`
	Offset int32  `json:"offset"`
}

func (q *Queries) ListAdminAlerts(ctx context.Context, arg ListAdminAlertsParams) ([]AdminAlert, error) {
	rows, err := q.db.Query(ctx, listAdminAlerts, arg.Status, arg.Limit, arg.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AdminAlert{}
	for rows.Next() {
		var i AdminAlert
		if err := rows.Scan(
			&i.ID, &i.ProviderConfigID, &i.GenerationLogID, &i.ServiceType, &i.Model,
			&i.ErrorCode, &i.ErrorMessage, &i.Source, &i.Severity, &i.Status,
			&i.CreatedAt, &i.LastSeenAt, &i.ProviderName,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const markAdminAlertRead = `
UPDATE admin_alerts
SET status = 'read'
WHERE id = $1
`

func (q *Queries) MarkAdminAlertRead(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, markAdminAlertRead, id)
	return err
}

const markAllAdminAlertsRead = `
UPDATE admin_alerts
SET status = 'read'
WHERE status = 'unread'
`

func (q *Queries) MarkAllAdminAlertsRead(ctx context.Context) error {
	_, err := q.db.Exec(ctx, markAllAdminAlertsRead)
	return err
}
