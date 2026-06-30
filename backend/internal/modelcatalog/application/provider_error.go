package application

import (
	"bytes"
	"ccy-canvas/backend/internal/shared/apperror"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// readProviderError converts an upstream non-2xx response into an *apperror.
// It tries the OpenAI-style { error: { message, type, code, param } } shape and
// falls back to including HTTP status + raw body so opaque relays like
// "openai_error" still produce something actionable.
func readProviderError(resp *http.Response) error {
	// Cap the body so a buggy upstream that sends megabytes of HTML doesn't
	// blow up the error message we surface to the user/admin.
	const maxBody = 4 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	return parseProviderErrorBytes(resp.StatusCode, body)
}

// parseProviderErrorBytes is the readProviderError logic for callers that have
// already read the response body (e.g. video task submission).
func parseProviderErrorBytes(statusCode int, body []byte) error {
	const maxBody = 4 * 1024
	trimmed := bytes.TrimSpace(body)

	var parsed struct {
		Error struct {
			Message string          `json:"message"`
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
			Param   string          `json:"param"`
		} `json:"error"`
	}

	msg := ""
	if len(trimmed) > 0 && trimmed[0] == '{' {
		if json.Unmarshal(trimmed, &parsed) == nil {
			parts := []string{}
			if parsed.Error.Message != "" {
				parts = append(parts, parsed.Error.Message)
			}
			if parsed.Error.Type != "" && parsed.Error.Type != parsed.Error.Message {
				parts = append(parts, fmt.Sprintf("type=%s", parsed.Error.Type))
			}
			if len(parsed.Error.Code) > 0 && string(parsed.Error.Code) != `null` && string(parsed.Error.Code) != `""` {
				parts = append(parts, fmt.Sprintf("code=%s", strings.Trim(string(parsed.Error.Code), `"`)))
			}
			if parsed.Error.Param != "" {
				parts = append(parts, fmt.Sprintf("param=%s", parsed.Error.Param))
			}
			msg = strings.Join(parts, " · ")
		}
	}

	// If the parsed message is suspiciously opaque (e.g. just "openai_error"
	// from a relay), include a snippet of the raw body so admins can see what
	// the upstream actually returned.
	opaque := msg == "" || isOpaqueProviderMsg(msg)
	if opaque {
		snippet := string(trimmed)
		if len(snippet) > maxBody {
			snippet = snippet[:maxBody] + "…(truncated)"
		}
		if snippet == "" {
			snippet = "<empty body>"
		}
		return apperror.New(
			apperror.CodeInternal,
			fmt.Sprintf("Provider HTTP %d: %s", statusCode, snippet),
		)
	}

	return apperror.New(
		apperror.CodeInternal,
		fmt.Sprintf("Provider HTTP %d: %s", statusCode, msg),
	)
}

// Some relays return error.message values that don't tell you anything
// (e.g. literal "openai_error", "error", "internal"). Treat those as opaque
// so we fall through to dumping the raw body.
func isOpaqueProviderMsg(msg string) bool {
	low := strings.ToLower(strings.TrimSpace(msg))
	switch low {
	case "", "error", "openai_error", "internal", "internal error", "unknown", "unknown error":
		return true
	}
	return false
}
