package httpx

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/shared/apperror"
)

func TestDecodeJSONRejectsTrailingContent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		body string
	}{
		{name: "multiple JSON values", body: `{"status":"ok"}{"status":"again"}`},
		{name: "trailing garbage", body: `{"status":"ok"}junk`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))

			var dst struct {
				Status string `json:"status"`
			}

			err := DecodeJSON(req, &dst)
			if err == nil {
				t.Fatal("expected error for trailing content")
			}

			var appErr *apperror.Error
			if !strings.Contains(err.Error(), "Invalid request body") {
				t.Fatalf("expected invalid request body error, got %v", err)
			}
			if !errors.As(err, &appErr) {
				t.Fatalf("expected apperror.Error, got %T", err)
			}
			if appErr.Code != apperror.CodeInvalidInput {
				t.Fatalf("expected code %q, got %q", apperror.CodeInvalidInput, appErr.Code)
			}
		})
	}
}
