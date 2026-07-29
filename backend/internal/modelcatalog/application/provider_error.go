package application

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"
)

// readProviderError converts an upstream non-2xx response into an *apperror.
// Upstream response bodies stay in the private error cause: they can contain
// request fragments, account information, or vendor implementation details.
func readProviderError(resp *http.Response) error {
	const maxBody = 4 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	return parseProviderErrorBytes(resp.StatusCode, body)
}

// parseProviderErrorBytes is the readProviderError logic for callers that
// have already read the response body (for example, video task submission).
// It creates one safe public message while preserving a bounded diagnostic as
// the wrapped cause for server-side logs only.
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
	if len(trimmed) > 0 && trimmed[0] == '{' && json.Unmarshal(trimmed, &parsed) == nil {
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
		msg = strings.Join(parts, " | ")
	}

	diagnostic := fmt.Sprintf("provider HTTP %d", statusCode)
	if msg != "" && !isOpaqueProviderMsg(msg) {
		diagnostic += ": " + msg
	} else if len(trimmed) > 0 {
		snippet := string(trimmed)
		if len(snippet) > maxBody {
			snippet = snippet[:maxBody] + "...(truncated)"
		}
		diagnostic += ": opaque upstream response: " + snippet
	}

	code := apperror.CodeUpstreamUnavailable
	if statusCode == http.StatusTooManyRequests {
		code = apperror.CodeRateLimited
	}
	if statusCode == http.StatusRequestTimeout || statusCode == http.StatusGatewayTimeout {
		code = apperror.CodeTimeout
	}
	return apperror.WithRetryable(
		apperror.Wrap(code, "模型服务暂时不可用，请稍后重试", fmt.Errorf("%s", diagnostic)),
		statusCode == http.StatusTooManyRequests || statusCode >= 500,
	)
}

// Some relays return error.message values that do not explain the failure.
func isOpaqueProviderMsg(msg string) bool {
	low := strings.ToLower(strings.TrimSpace(msg))
	switch low {
	case "", "error", "openai_error", "internal", "internal error", "unknown", "unknown error":
		return true
	}
	return false
}
