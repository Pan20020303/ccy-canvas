package application

import (
	"context"
	"testing"
)

type recordingTaskRepo struct {
	fakeRepository
	logID, providerID, taskID string
}

func (r *recordingTaskRepo) RecordGenerationProviderTask(ctx context.Context, logID, providerID, taskID string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	r.logID, r.providerID, r.taskID = logID, providerID, taskID
	return nil
}
func TestRememberProviderTask(t *testing.T) {
	r := &recordingTaskRepo{}
	s := &Service{repo: r}
	s.rememberProviderTask("log-1", "provider-1", "task-1")
	if r.logID != "log-1" || r.providerID != "provider-1" || r.taskID != "task-1" {
		t.Fatal("vendor task checkpoint missing")
	}
	s.rememberProviderTask("", "provider-2", "task-2")
	if r.taskID != "task-1" {
		t.Fatal("checkpoint without a log row")
	}
}
