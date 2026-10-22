package tasks

import (
	"context"
	"errors"
	"github.com/hibiken/asynq"
	"testing"
)

type cancelledInspectorFake struct {
	queue, id string
	err       error
	calls     int
}

func (f *cancelledInspectorFake) DeleteTask(queue, id string) error {
	f.queue, f.id = queue, id
	f.calls++
	return f.err
}
func (*cancelledInspectorFake) Close() error { return nil }

func TestCancelledQueueCleanupNeverInterruptsActiveJobs(t *testing.T) {
	for _, cause := range []error{nil, asynq.ErrTaskNotFound, asynq.ErrQueueNotFound, errors.New("task is active")} {
		fake := &cancelledInspectorFake{err: cause}
		q := &Queue{inspector: fake}
		err := q.RemoveCancelledTask(context.Background(), "video", "request-id")
		if fake.calls != 1 || fake.queue != "video" || fake.id != "request-id" {
			t.Fatal("wrong cleanup target")
		}
		if cause != nil && cause.Error() == "task is active" && err == nil {
			t.Fatal("active cleanup must be deferred, not force-interrupted")
		}
		if (cause == nil || errors.Is(cause, asynq.ErrTaskNotFound) || errors.Is(cause, asynq.ErrQueueNotFound)) && err != nil {
			t.Fatalf("idempotent cleanup: %v", err)
		}
	}
}

func TestCancelledQueueCleanupHonorsCancelledContext(t *testing.T) {
	fake := &cancelledInspectorFake{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := (&Queue{inspector: fake}).RemoveCancelledTask(ctx, "image", "id"); !errors.Is(err, context.Canceled) || fake.calls != 0 {
		t.Fatal("cleanup used cancelled request")
	}
}
