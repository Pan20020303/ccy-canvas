package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"ccy-canvas/backend/internal/shared/apperror"
)

type envelope struct {
	Data      any    `json:"data,omitempty"`
	Error     any    `json:"error,omitempty"`
	RequestID string `json:"request_id"`
}

type errorBody struct {
	Code    apperror.Code `json:"code"`
	Message string        `json:"message"`
	Details any           `json:"details,omitempty"`
}

func WriteJSON(w http.ResponseWriter, r *http.Request, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{
		Data:      data,
		RequestID: RequestIDFrom(r.Context()),
	})
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	body := errorBody{Code: apperror.CodeInternal, Message: "Internal server error"}

	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		body.Code = appErr.Code
		body.Message = appErr.Message
		switch appErr.Code {
		case apperror.CodeUnauthenticated:
			status = http.StatusUnauthorized
		case apperror.CodeForbidden:
			status = http.StatusForbidden
		case apperror.CodeInvalidInput, apperror.CodeInvitationInvalid, apperror.CodeEmailAlreadyExists:
			status = http.StatusBadRequest
		default:
			status = http.StatusInternalServerError
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{
		Error:     body,
		RequestID: RequestIDFrom(r.Context()),
	})
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
