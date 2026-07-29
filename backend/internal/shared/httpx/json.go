package httpx

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"ccy-canvas/backend/internal/shared/apperror"
)

type envelope struct {
	Data      any    `json:"data,omitempty"`
	Error     any    `json:"error,omitempty"`
	RequestID string `json:"request_id"`
}

// errorBody is the sole JSON error payload used by Chi routes. Huma routes
// are normalized at their boundary separately; both expose the same fields.
type errorBody struct {
	Code      apperror.Code `json:"code"`
	Message   string        `json:"message"`
	Details   any           `json:"details,omitempty"`
	Retryable bool          `json:"retryable"`
}

func WriteJSON(w http.ResponseWriter, r *http.Request, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{Data: data, RequestID: RequestIDFrom(r.Context())})
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	appErr := apperror.Normalize(err)
	status := apperror.HTTPStatus(appErr.Code)
	body := errorBody{
		Code: appErr.Code, Message: apperror.PublicMessage(appErr), Retryable: appErr.Retryable,
	}
	// Details are opt-in and only expected for validation field names or limits.
	// Never forward details for an internal failure.
	if appErr.Code != apperror.CodeInternal {
		body.Details = appErr.Details
	}
	requestID := RequestIDFrom(r.Context())
	slog.Error("request failed", "request_id", requestID, "method", r.Method, "route", r.URL.Path,
		"status", status, "error_code", appErr.Code, "cause", apperror.Diagnostic(err))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{Error: body, RequestID: requestID})
}

func DecodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return apperror.Wrap(apperror.CodeInvalidInput, "Invalid request body", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return apperror.Wrap(apperror.CodeInvalidInput, "Invalid request body", err)
	}
	return nil
}
