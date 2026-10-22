package httpx

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
)

type requestIDKey struct{}

// MaxBodyMiddleware caps request body size for non-upload endpoints.
func MaxBodyMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/app/upload") {
				next.ServeHTTP(w, r)
				return
			}
			if r.ContentLength > maxBytes {
				writeRequestTooLarge(w, r, maxBytes)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

func writeRequestTooLarge(w http.ResponseWriter, r *http.Request, maxBytes int64) {
	err := apperror.WithDetails(
		apperror.New(apperror.CodeRequestTooLarge, "请求体过大，请减少素材数量或重新上传"),
		map[string]any{"max_bytes": maxBytes},
	)
	WriteError(w, r, err)
}

func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if !validRequestID(requestID) {
			requestID = "req_" + uuid.NewString()
		}
		ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func validRequestID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return true
}

// Recoverer prevents a panic from breaking the HTTP contract. Stack traces
// remain in structured logs and are never written to a client response.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := &responseRecorder{ResponseWriter: w}
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("panic while serving request", "request_id", RequestIDFrom(r.Context()), "method", r.Method,
					"route", r.URL.Path, "panic", fmt.Sprint(recovered), "stack", string(debug.Stack()))
				if !recorder.wroteHeader {
					WriteError(recorder, r, apperror.Wrap(apperror.CodeInternal, "服务暂时不可用，请稍后重试", fmt.Errorf("panic: %v", recovered)))
				}
			}
		}()
		next.ServeHTTP(recorder, r)
	})
}

// AccessLogger emits one structured, correlation-friendly log entry per HTTP
// request. It intentionally records the path without a query string so signed
// URLs and token-shaped query parameters cannot enter the log stream.
func AccessLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		slog.Info("http request", "request_id", RequestIDFrom(r.Context()), "method", r.Method,
			"route", r.URL.Path, "status", status, "duration_ms", time.Since(started).Milliseconds())
	})
}

type responseRecorder struct {
	http.ResponseWriter
	wroteHeader bool
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(value []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(value)
}

// Flush preserves streaming semantics when the recorder wraps an SSE
// response. Several handlers intentionally assert http.Flusher directly, so
// merely embedding ResponseWriter is not sufficient to expose the optional
// interface through the middleware chain.
func (w *statusRecorder) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseRecorder) WriteHeader(status int) {
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseRecorder) Write(value []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(value)
}

func (w *responseRecorder) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *responseRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func RequestIDFrom(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	if value == "" {
		return "req_unknown"
	}
	return value
}
