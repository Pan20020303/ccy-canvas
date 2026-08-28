package application

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"
)

// readProviderError converts an upstream non-2xx response into an *apperror.
// Upstream response bodies stay in the private error cause: they can contain
// request fragments, account information, or vendor implementation details.
func readProviderError(resp *http.Response) error {
	const maxBody = 4 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	err := parseProviderErrorBytes(resp.StatusCode, body)
	var diagnostic *providerResponseError
	if errors.As(err, &diagnostic) && diagnostic.RequestID == "" {
		for _, header := range []string{"X-Request-Id", "X-Tt-Logid", "Request-Id"} {
			if id := safeProviderRequestID(resp.Header.Get(header)); id != "" {
				diagnostic.RequestID = id
				break
			}
		}
	}
	return err
}

// Structured metadata is safe to log; the raw response remains a private cause.
type providerResponseError struct {
	StatusCode int
	Code       string
	RequestID  string
	diagnostic string
}

func (e *providerResponseError) Error() string { return e.diagnostic }

var providerRequestIDPattern = regexp.MustCompile(`^[a-fA-F0-9-]{16,128}$`)
var providerCodePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

func safeProviderRequestID(value string) string {
	if providerRequestIDPattern.MatchString(value) {
		return value
	}
	return ""
}

func classifyProviderError(status int, upstreamCode string) (apperror.Code, string, bool, string) {
	code := strings.ToLower(upstreamCode)
	safeCode := "unrecognized"
	if providerCodePattern.MatchString(upstreamCode) {
		for _, prefix := range []string{"invalidparameter", "missingparameter", "invalid_request_error",
			"inputtext", "inputimage", "inputvideo", "inputaudio", "outputtext", "outputimage",
			"outputvideo", "outputaudio", "content_policy_violation", "sensitivecontentdetected",
			"authenticationerror", "invalid_api_key", "accessdenied", "permissiondenied",
			"operationdenied", "accountoverdue", "insufficient_quota", "quotaexceeded",
			"ratelimit", "throttling", "modelnotfound", "notfound", "internalerror", "server_error"} {
			if strings.HasPrefix(code, prefix) {
				safeCode = upstreamCode
				break
			}
		}
	}
	// Use fixed translations, never the upstream message (which may echo secrets).
	switch {
	case strings.HasPrefix(code, "inputimage") && strings.Contains(code, "sensitivecontentdetected"):
		return apperror.CodeValidation, "参考图片未通过模型服务的安全审核，请检查参考图片", false, safeCode
	case strings.HasPrefix(code, "inputtext") && strings.Contains(code, "sensitivecontentdetected"):
		return apperror.CodeValidation, "提示词未通过模型服务的安全审核，请检查提示词", false, safeCode
	case strings.HasPrefix(code, "inputvideo") && strings.Contains(code, "sensitivecontentdetected"):
		return apperror.CodeValidation, "参考视频未通过模型服务的安全审核，请检查参考视频", false, safeCode
	case strings.HasPrefix(code, "inputaudio") && strings.Contains(code, "sensitivecontentdetected"):
		return apperror.CodeValidation, "参考音频未通过模型服务的安全审核，请检查参考音频", false, safeCode
	case safeCode != "unrecognized" && (strings.Contains(code, "sensitivecontentdetected") || code == "content_policy_violation"):
		return apperror.CodeValidation, "内容未通过模型服务的安全审核，请检查提示词或参考素材", false, safeCode
	case code == "operationdenied.serviceoverdue" || code == "accountoverdue" || code == "insufficient_quota" || status == 402:
		return apperror.CodeUpstreamUnavailable, "模型渠道余额或配额不足，请联系管理员", false, safeCode
	case status == 401:
		return apperror.CodeUpstreamUnavailable, "模型渠道鉴权失败，请联系管理员检查 API Key", false, safeCode
	case status == 403:
		return apperror.CodeUpstreamUnavailable, "模型渠道无访问权限，请联系管理员检查模型授权", false, safeCode
	case status == 404:
		return apperror.CodeUpstreamUnavailable, "模型或调用地址不存在，请联系管理员检查渠道配置", false, safeCode
	case status == 413:
		return apperror.CodeRequestTooLarge, "提交的参考素材过大，请缩小文件后再试", false, safeCode
	case status == 400 || status == 422:
		return apperror.CodeValidation, "模型服务拒绝了请求参数或参考素材，请检查后再试", false, safeCode
	case status == 429:
		return apperror.CodeRateLimited, "模型服务请求过于频繁或并发已满，请稍后重试", true, safeCode
	case status == 408 || status == 504:
		return apperror.CodeTimeout, "模型服务响应超时，请稍后查询任务状态", true, safeCode
	default:
		return apperror.CodeUpstreamUnavailable, "模型服务暂时不可用，请稍后重试", status >= 500, safeCode
	}
}

// parseProviderErrorBytes is the readProviderError logic for callers that
// have already read the response body (for example, video task submission).
// It creates one safe public message while preserving a bounded diagnostic as
// the wrapped cause for server-side logs only.
func parseProviderErrorBytes(statusCode int, body []byte) error {
	const maxBody = 4 * 1024
	trimmed := bytes.TrimSpace(body)

	var parsed struct {
		RequestID string `json:"request_id"`
		Error     struct {
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

	var upstreamCode string
	_ = json.Unmarshal(parsed.Error.Code, &upstreamCode)
	code, publicMessage, retryable, safeCode := classifyProviderError(statusCode, upstreamCode)
	return apperror.WithRetryable(
		apperror.Wrap(code, publicMessage, &providerResponseError{
			StatusCode: statusCode, Code: safeCode,
			RequestID: safeProviderRequestID(parsed.RequestID), diagnostic: diagnostic,
		}),
		retryable,
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
