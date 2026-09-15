package tasks

import (
	"testing"
	"time"
)

func TestTextTaskTimeoutMatchesDurableBudget(t *testing.T) {
	t.Setenv("TEXT_TASK_MAX_RUNTIME_SECONDS", "")
	if got := timeoutForServiceType("text"); got != 15*time.Minute {
		t.Fatalf("timeoutForServiceType(text) = %s, want 15m", got)
	}
	t.Setenv("TEXT_TASK_MAX_RUNTIME_SECONDS", "91")
	if got := timeoutForServiceType("text"); got != 91*time.Second {
		t.Fatalf("text timeout override = %s, want 91s", got)
	}
}

func TestTextTaskUsesBoundedQueueRetries(t *testing.T) {
	if got := maxRetryForServiceType("text"); got != 2 {
		t.Fatalf("maxRetryForServiceType(text) = %d, want 2", got)
	}
	for _, serviceType := range []string{"image", "video", "audio"} {
		if got := maxRetryForServiceType(serviceType); got != 5 {
			t.Fatalf("maxRetryForServiceType(%s) = %d, want 5", serviceType, got)
		}
	}
}
