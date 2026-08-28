package client

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// APIError is a normalized, human-facing error carrying an HTTP status and a
// stable process exit code. It never contains the session cookie.
type APIError struct {
	Status    int
	Code      string
	Message   string
	RequestID string
}

func (e *APIError) Error() string { return e.Message }

// ExitCode maps HTTP status to a stable process exit code so scripts can branch.
func (e *APIError) ExitCode() int {
	switch e.Status {
	case http.StatusUnauthorized: // 401
		return 2
	case http.StatusPaymentRequired: // 402 — insufficient credits
		return 3
	case http.StatusForbidden: // 403 — no access / visitor read-only
		return 4
	case http.StatusBadRequest, http.StatusUnprocessableEntity: // 400 / 422
		return 5
	default:
		if e.Status >= 500 {
			return 6
		}
		return 1
	}
}

// parseAPIError normalizes a non-2xx response body. It copes with all three
// shapes the backend emits:
//
//  1. huma problem+json:  { status, title, detail, errors:[{message,location}] }
//     — validation failures land here as 422, with the useful info in errors[].
//  2. envelope error:     { error:{code,message,details}, request_id }
//  3. bare error:         { error: "..." }  (chi raw routes: upload/proxy/stream)
//
// It falls back to the HTTP status text. For 5xx it deliberately does NOT echo
// server-provided detail (which may leak internal info) — only a generic
// message plus the request id.
func parseAPIError(status int, body []byte) *APIError {
	e := &APIError{Status: status}
	trimmed := strings.TrimSpace(string(body))

	// (2) envelope { error:{code,message}, request_id }
	var envelope struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error != nil && envelope.Error.Message != "" {
		e.Code = envelope.Error.Code
		e.Message = envelope.Error.Message
		e.RequestID = envelope.RequestID
	}

	// (1) huma problem+json
	if e.Message == "" {
		var prob struct {
			Title  string `json:"title"`
			Detail string `json:"detail"`
			Errors []struct {
				Message  string `json:"message"`
				Location string `json:"location"`
			} `json:"errors"`
		}
		if json.Unmarshal(body, &prob) == nil && (prob.Detail != "" || prob.Title != "" || len(prob.Errors) > 0) {
			msg := prob.Detail
			if msg == "" {
				msg = prob.Title
			}
			if len(prob.Errors) > 0 {
				var parts []string
				for _, fe := range prob.Errors {
					seg := strings.Trim(strings.TrimSpace(fe.Location+": "+fe.Message), ": ")
					if seg != "" {
						parts = append(parts, seg)
					}
				}
				if len(parts) > 0 {
					msg = strings.TrimSpace(msg + " — " + strings.Join(parts, "; "))
				}
			}
			e.Code = prob.Title
			e.Message = msg
		}
	}

	// (3) bare { error: "..." }
	if e.Message == "" {
		var bare struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &bare) == nil && bare.Error != "" {
			e.Message = bare.Error
		}
	}

	// 5xx: never surface internal detail.
	if status >= 500 {
		msg := fmt.Sprintf("服务端错误 (HTTP %d)", status)
		if e.RequestID != "" {
			msg += "，request_id=" + e.RequestID
		}
		e.Message = msg
		return e
	}

	if e.Message == "" {
		if trimmed != "" && len(trimmed) < 200 {
			e.Message = trimmed
		} else if t := http.StatusText(status); t != "" {
			e.Message = fmt.Sprintf("%s (HTTP %d)", t, status)
		} else {
			e.Message = fmt.Sprintf("请求失败 (HTTP %d)", status)
		}
	}
	return e
}
