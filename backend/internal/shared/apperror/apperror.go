package apperror

import "fmt"

type Code string

const (
	CodeUnauthenticated    Code = "UNAUTHENTICATED"
	CodeForbidden          Code = "FORBIDDEN"
	CodeInvalidInput       Code = "INVALID_INPUT"
	CodeNotFound           Code = "NOT_FOUND"
	CodeInvitationInvalid  Code = "INVITATION_INVALID"
	CodeEmailAlreadyExists Code = "EMAIL_ALREADY_EXISTS"
	CodeInternal           Code = "INTERNAL"
)

type Error struct {
	Code    Code
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return string(e.Code) + ": " + e.Message
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
}

func (e *Error) Unwrap() error {
	return e.Err
}

func New(code Code, message string) *Error {
	return &Error{Code: code, Message: message}
}

func Wrap(code Code, message string, err error) *Error {
	return &Error{Code: code, Message: message, Err: err}
}
