package sqlc

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
)

// RecordGenerationProviderTask retains the non-secret vendor task ID even if
// polling is interrupted. It does not requeue or submit any paid work.
func (q *Queries) RecordGenerationProviderTask(ctx context.Context, logID pgtype.UUID, providerID, taskID string) error {
	_, err := q.db.Exec(ctx, `UPDATE generation_logs SET request_payload =
		COALESCE(request_payload, '{}'::jsonb) || jsonb_build_object('_upstream_task',
		jsonb_build_object('provider_config_id', $2::text, 'task_id', $3::text, 'recorded_at', NOW()))
		WHERE id=$1`, logID, providerID, taskID)
	return err
}
