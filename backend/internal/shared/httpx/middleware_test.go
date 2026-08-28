package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStreamingMiddlewaresPreserveFlusher(t *testing.T) {
	handler := RequestIDMiddleware(Recoverer(AccessLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("wrapped response writer no longer implements http.Flusher")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: connected\n\n"))
		flusher.Flush()
	}))))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/stream", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body != "data: connected\n\n" {
		t.Fatalf("body = %q", body)
	}
}
