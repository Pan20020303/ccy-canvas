package interfaces

import (
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"

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
