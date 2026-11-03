package interfaces

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/shared/apperror"
)

func TestToHTTPErrorMapsInvalidInputToBadRequest(t *testing.T) {
	err := toHTTPError(apperror.New(apperror.CodeInvalidInput, "bad input"))

	statusErr, ok := err.(huma.StatusError)
	if !ok {
		t.Fatalf("error type = %T, want huma.StatusError", err)
	}
	if statusErr.GetStatus() != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", statusErr.GetStatus(), http.StatusBadRequest)
	}
}

func TestToHTTPErrorMapsForbiddenToForbidden(t *testing.T) {
	err := toHTTPError(apperror.New(apperror.CodeForbidden, "forbidden"))

	statusErr, ok := err.(huma.StatusError)
	if !ok {
		t.Fatalf("error type = %T, want huma.StatusError", err)
	}
	if statusErr.GetStatus() != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", statusErr.GetStatus(), http.StatusForbidden)
	}
}

type recordingFailureFinalizer struct {
	calls    int
	req      application.GenerateRequest
	err      error
	duration time.Duration
}

func (f *recordingFailureFinalizer) FinalizeFailure(req application.GenerateRequest, err error, duration time.Duration) {
	f.calls++
	f.req = req
	f.err = err
	f.duration = duration
}

func TestFinalizeQueuedEnqueueFailureAttachesPersistedLogID(t *testing.T) {
	finalizer := &recordingFailureFinalizer{}
	cause := errors.New("redis unavailable")
	req := application.GenerateRequest{
		UserID:     "user-1",
		CreditCost: 7,
	}

	finalizeQueuedEnqueueFailure(finalizer, req, "log-123", cause)

	if finalizer.calls != 1 {
		t.Fatalf("FinalizeFailure calls = %d, want 1", finalizer.calls)
	}
	if finalizer.req.GenerationLogID != "log-123" {
		t.Fatalf("GenerationLogID = %q, want log-123", finalizer.req.GenerationLogID)
	}
	if !errors.Is(finalizer.err, cause) {
		t.Fatalf("cause = %v, want %v", finalizer.err, cause)
	}
	if finalizer.duration != 0 {
		t.Fatalf("duration = %s, want 0", finalizer.duration)
	}
}
