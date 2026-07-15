package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
)

type requestIDKey struct{}

// MaxBodyMiddleware caps request body size for non-upload endpoints.
// Uploads have their own (larger) limit set in the upload handler.
func MaxBodyMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip body limiting for the multipart upload endpoint — it has its own cap.
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusRequestEntityTooLarge)
	_ = json.NewEncoder(w).Encode(envelope{
		Error: errorBody{
			Code:    apperror.CodeInvalidInput,
			Message: "请求体过大，请减少参考素材数量或重新上传为 COS 公网图片后再试",
			Details: map[string]any{
				"max_bytes": maxBytes,
			},
		},
		RequestID: RequestIDFrom(r.Context()),
	})
}

func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = "req_" + uuid.NewString()
		}
		ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequestIDFrom(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	if value == "" {
		return "req_unknown"
	}
	return value
}
