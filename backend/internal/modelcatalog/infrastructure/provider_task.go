package infrastructure

import "context"

func (r *Repository) RecordGenerationProviderTask(ctx context.Context, logID, providerID, taskID string) error {
	id, err := parsePgUUID(logID)
	if err != nil {
		return err
	}
	return r.q.RecordGenerationProviderTask(ctx, id, providerID, taskID)
}
