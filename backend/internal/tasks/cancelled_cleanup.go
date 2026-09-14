package tasks

import (
	"context"
	"errors"
	"github.com/hibiken/asynq"
)

type cancelledTaskInspector interface {
	DeleteTask(string, string) error
	Close() error
}

// Cleanup is only called AFTER the database has committed cancellation.
// Inspector.DeleteTask atomically refuses active Redis jobs, so it cannot abort
// any provider. A leased job observes cancelled when claiming DB execution.
func (q *Queue) RemoveCancelledTask(ctx context.Context, serviceType, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if q == nil || q.inspector == nil || id == "" {
		return nil
	}
	err := q.inspector.DeleteTask(queueNameForServiceType(serviceType), id)
	if errors.Is(err, asynq.ErrTaskNotFound) || errors.Is(err, asynq.ErrQueueNotFound) {
		return nil
	}
	return err
}
