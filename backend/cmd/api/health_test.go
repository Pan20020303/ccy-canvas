package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadinessReflectsDatabaseAvailability(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{"connected", nil, http.StatusOK},
		{"disconnected", errors.New("private connection details"), http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			readinessHandler(func(ctx context.Context) error {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("readiness requires a bounded database probe")
				}
				return tc.err
			})(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
			if response.Code != tc.want || !strings.Contains(response.Body.String(), `"version":"dev"`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "private connection") {
				t.Fatal("database credentials/details leaked")
			}
		})
	}
}
