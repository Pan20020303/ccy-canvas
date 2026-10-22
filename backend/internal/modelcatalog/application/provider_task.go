package application

import (
	"context"
	"log"
	"time"
)

type providerTaskRecorder interface {
	RecordGenerationProviderTask(context.Context, string, string, string) error
}

func (s *Service) rememberProviderTask(logID, providerID, taskID string) {
	if logID == "" || taskID == "" {
		return
	}
	// Task IDs are safe correlation metadata; never log keys or signed URLs.
	log.Printf("[provider_task] log_id=%s provider_id=%s task_id=%s", logID, providerID, taskID)
	if recorder, ok := s.repo.(providerTaskRecorder); ok {
		// The upstream may just have accepted as the caller is cancelled.
		// A short independent context preserves our recovery handle.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := recorder.RecordGenerationProviderTask(ctx, logID, providerID, taskID); err != nil {
			log.Printf("[provider_task] checkpoint failed log_id=%s task_id=%s", logID, taskID)
		}
	}
}
