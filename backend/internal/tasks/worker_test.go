package tasks

import (
	"context"
	"errors"
	"testing"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
)

func TestIsMediaGeneration(t *testing.T) {
	cases := map[string]bool{
		"image": true,
		"video": true,
		"audio": true,
		"text":  false,
		"":      false,
		"other": false,
	}
	for svc, want := range cases {
		if got := isMediaGeneration(svc); got != want {
			t.Errorf("isMediaGeneration(%q) = %v, want %v", svc, got, want)
		}
	}
}

// Guards the core fix: a request-deadline timeout on a media generation must
// be classified as terminal (not retried), while text stays retryable. This
// mirrors the decision handleGeneration makes.
func TestMediaTimeoutIsTerminal(t *testing.T) {
	timeout := errors.New("Post \"x\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)")

	if !(isMediaGeneration("image") && modelapp.IsRequestDeadlineTimeout(timeout)) {
		t.Fatal("image + request-deadline timeout must be terminal (no retry)")
	}
	// Text timeouts remain retryable (cheap, ~idempotent).
	if isMediaGeneration("text") {
		t.Fatal("text must not be treated as media generation")
	}
}

func TestErrTimeoutNoRetryWrapsOriginal(t *testing.T) {
	orig := context.DeadlineExceeded
	wrapped := errTimeoutNoRetry(orig)
	if !errors.Is(wrapped, orig) {
		t.Fatal("errTimeoutNoRetry must wrap the original error")
	}
}
