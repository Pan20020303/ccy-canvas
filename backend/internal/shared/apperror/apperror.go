// Package apperror defines the one application-error type used at transport
// boundaries. Its wrapped cause is deliberately not part of Error(), so a
// database, provider or filesystem failure cannot leak through a casual
// fmt/log/JSON conversion.
package apperror

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type Code string

const (
	CodeUnauthenticated     Code = "UNAUTHENTICATED"
	CodeForbidden           Code = "FORBIDDEN"
	CodeInvalidInput        Code = "INVALID_INPUT"
	CodeValidation          Code = "VALIDATION_ERROR"
	CodeNotFound            Code = "NOT_FOUND"
	CodeConflict            Code = "CONFLICT"
	CodeInsufficientCredits Code = "INSUFFICIENT_CREDITS"
	CodeRequestTooLarge     Code = "REQUEST_TOO_LARGE"
	CodeRateLimited         Code = "RATE_LIMITED"
	CodeUpstreamUnavailable Code = "UPSTREAM_UNAVAILABLE"
	CodeTimeout             Code = "TIMEOUT"
	CodeInvitationInvalid   Code = "INVITATION_INVALID"
	CodeEmailAlreadyExists  Code = "EMAIL_ALREADY_EXISTS"
	CodeInternal            Code = "INTERNAL"
)

// Error contains a stable public code plus a private root cause. Details must
// contain only allow-listed, browser-safe validation information.
type Error struct {
	Code      Code
	Message   string
	Details   any
	Retryable bool
	Err       error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message == "" {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func New(code Code, message string) *Error { return &Error{Code: code, Message: message} }

func Wrap(code Code, message string, err error) *Error {
	return &Error{Code: code, Message: message, Err: err}
}

func WithDetails(err *Error, details any) *Error {
	if err != nil {
		err.Details = details
	}
	return err
}

func WithRetryable(err *Error, retryable bool) *Error {
	if err != nil {
		err.Retryable = retryable
	}
	return err
}

// Normalize translates an arbitrary error to the shared contract.
func Normalize(err error) *Error {
	if err == nil {
		return nil
	}
	var appErr *Error
	if errors.As(err, &appErr) && appErr != nil {
		return appErr
	}
	return Wrap(CodeInternal, "服务暂时不可用，请稍后重试", err)
}

// PublicMessage returns a value that is safe to send to an untrusted client.
// INTERNAL errors intentionally discard their original message because many
// legacy call sites still include database or provider diagnostics in it.
func PublicMessage(err error) string {
	appErr := Normalize(err)
	if appErr == nil {
		return ""
	}
	if appErr.Code == CodeInternal || strings.TrimSpace(appErr.Message) == "" {
		return "服务暂时不可用，请稍后重试"
	}
	return appErr.Message
}

func HTTPStatus(code Code) int {
	switch code {
	case CodeUnauthenticated:
		return http.StatusUnauthorized
	case CodeForbidden:
		return http.StatusForbidden
	case CodeInsufficientCredits:
		return http.StatusPaymentRequired
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodeRequestTooLarge:
		return http.StatusRequestEntityTooLarge
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeValidation:
		return http.StatusUnprocessableEntity
	case CodeInvalidInput, CodeInvitationInvalid, CodeEmailAlreadyExists:
		return http.StatusBadRequest
	case CodeUpstreamUnavailable:
		return http.StatusBadGateway
	case CodeTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

func CodeForHTTPStatus(status int) Code {
	switch status {
	case http.StatusBadRequest:
		return CodeInvalidInput
	case http.StatusUnauthorized:
		return CodeUnauthenticated
	case http.StatusPaymentRequired:
		return CodeInsufficientCredits
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusConflict:
		return CodeConflict
	case http.StatusRequestEntityTooLarge:
		return CodeRequestTooLarge
	case http.StatusUnprocessableEntity:
		return CodeValidation
	case http.StatusTooManyRequests:
		return CodeRateLimited
	case http.StatusBadGateway, http.StatusServiceUnavailable:
		return CodeUpstreamUnavailable
	case http.StatusGatewayTimeout, http.StatusRequestTimeout:
		return CodeTimeout
	default:
		return CodeInternal
	}
}

// Diagnostic returns the private chain for server-side structured logging.
// It must never be serialized into HTTP, SSE or task-log payloads.
func Diagnostic(err error) string {
	if err == nil {
		return ""
	}
	var appErr *Error
	if errors.As(err, &appErr) && appErr != nil && appErr.Err != nil {
		return appErr.Err.Error()
	}
	return err.Error()
}
