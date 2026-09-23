package apperror

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
)

var (
	secretAssignment = regexp.MustCompile(`(?i)(["']?(?:api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token|token|password|secret|cookie|session|credential|signature|prompt|messages|input)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;|}]+)`)
	secretPhrase     = regexp.MustCompile(`(?i)((?:api[_ -]?key|token|password|secret)(?:\s+(?:provided|is|was|value))?\s*:\s*)[^\s,;|]+`)
	bearerValue      = regexp.MustCompile(`(?i)\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]+`)
	keyValue         = regexp.MustCompile(`\b(?:sk-|sk_|sess-)[a-zA-Z0-9_*.-]+|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+`)
	privateURL       = regexp.MustCompile(`(?i)(?:https?|postgres(?:ql)?|redis)://[^\s<>"']+|data:[^\s]+`)
	privateEmail     = regexp.MustCompile(`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`)
	privatePath      = regexp.MustCompile(`(?i)[A-Z]:\\[^\r\n|]+|/(?:home|users|var|etc|app)/[^\s]+`)
)

// SafeProviderText is for explicitly selected provider error fields, NOT raw
// transport bodies. Do not call it on prompts, stack traces or arbitrary errors.
func SafeProviderText(value string) string {
	value = bearerValue.ReplaceAllString(value, "[已脱敏]")
	value = secretAssignment.ReplaceAllString(value, "${1}[已脱敏]")
	value = secretPhrase.ReplaceAllString(value, "${1}[已脱敏]")
	value = keyValue.ReplaceAllString(value, "[已脱敏]")
	value = privateURL.ReplaceAllString(value, "[地址已隐藏]")
	value = privateEmail.ReplaceAllString(value, "[账户已隐藏]")
	value = privatePath.ReplaceAllString(value, "[路径已隐藏]")
	if strings.Contains(value, "<html") || strings.Contains(value, "<!DOCTYPE") || strings.Contains(value, "Traceback (") {
		return ""
	}
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > 360 {
		value = string(runes[:360]) + "…"
	}
	return value
}

// ProviderFailure preserves the actual HTTP status and selected error fields.
// A task-level failure may have HTTP 200, or 0 when only a failure reason exists;
// neither is substituted with a made-up 5xx status.
func ProviderFailure(status int, body []byte) *Error {
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	reason, providerCode, param := providerFields(payload, 0)
	reason, providerCode, param = SafeProviderText(reason), SafeProviderText(providerCode), SafeProviderText(param)
	low := strings.ToLower(reason + " " + providerCode)
	code, retryable := CodeUpstreamUnavailable, status == 429 || status >= 500
	summary := "模型任务执行失败"
	switch {
	case strings.Contains(low, "insufficient_quota"), strings.Contains(low, "insufficient_balance"), strings.Contains(low, "余额不足"), status == 402:
		summary, retryable = "模型渠道额度不足，请联系管理员检查服务商余额或配额", false
	case status == 401:
		summary, retryable = "模型渠道认证失败，请联系管理员检查 API 密钥", false
	case status == 403:
		summary, retryable = "模型渠道拒绝访问，请联系管理员检查模型权限或访问限制", false
	case status == 404:
		summary, retryable = "模型或接口地址不存在，请检查模型 ID 和渠道地址", false
	case status == 408 || status == 504:
		code, summary, retryable = CodeTimeout, "模型服务响应超时", true
	case status == 429:
		code, summary = CodeRateLimited, "模型渠道请求限流，请稍后重试"
	case strings.Contains(low, "content_policy"), strings.Contains(low, "sensitivecontent"), strings.Contains(low, "内容审核"):
		summary, retryable = "请求未通过模型服务的内容审核，请调整提示词或参考素材", false
	case status == 400 || status == 422:
		summary, retryable = "模型服务拒绝了请求参数，请按下方原因调整", false
	case status == 413:
		summary, retryable = "提交给模型服务的内容过大，请减少参考素材或文本", false
	case status >= 500:
		summary = "模型服务处理请求失败"
	}
	message := summary
	if status > 0 {
		message += fmt.Sprintf("（上游 HTTP %d）", status)
	}
	if reason != "" && !opaqueProviderReason(reason) {
		message += "：" + reason
	} else {
		message += "。服务商未提供更详细的失败原因。"
	}
	if providerCode != "" && providerCode != reason {
		message += " [code=" + providerCode + "]"
	}
	if param != "" {
		message += " [param=" + param + "]"
	}
	private := string(body)
	if len(private) > 4096 {
		private = private[:4096] + "...(truncated)"
	}
	return &Error{Code: code, Message: message, Retryable: retryable,
		Details: map[string]any{"source": "model_provider", "upstream_status": status, "provider_code": providerCode, "param": param},
		Err:     fmt.Errorf("provider HTTP %d: %s", status, private)}
}

func opaqueProviderReason(reason string) bool {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "error", "unknown", "unknown error", "internal", "internal error", "openai_error":
		return true
	}
	return false
}

func providerFields(p map[string]any, depth int) (reason, code, param string) {
	if depth > 4 || p == nil {
		return
	}
	// Only well-known diagnostic fields/envelopes. Never serialize whole data,
	// requests, headers, URLs or object-valued messages.
	for _, name := range []string{"error", "Error", "ResponseMetadata", "task", "output", "data", "base_resp"} {
		if nested, ok := p[name].(map[string]any); ok {
			r, c, field := providerFields(nested, depth+1)
			if r != "" || c != "" {
				return r, c, field
			}
		}
	}
	for _, name := range []string{"message", "Message", "error_message", "fail_reason", "failure_reason", "status_msg", "detail", "error"} {
		if s, ok := p[name].(string); ok && strings.TrimSpace(s) != "" {
			reason = s
			break
		}
	}
	for _, name := range []string{"error_code", "code", "Code", "type", "status_code"} {
		switch v := p[name].(type) {
		case string:
			code = v
		case float64:
			if v != 0 && v != 200 {
				code = fmt.Sprint(v)
			}
		}
		if code != "" {
			break
		}
	}
	param, _ = p["param"].(string)
	return
}

func ProviderTaskFailure(reason string) *Error {
	body, _ := json.Marshal(map[string]string{"message": reason})
	return ProviderFailure(0, body)
}

// ProviderResponseFailure distinguishes a broken response contract (missing
// task ID/result/valid JSON) while still preserving a structured vendor error
// returned with HTTP 200.
func ProviderResponseFailure(status int, body []byte, fallback string) *Error {
	err := ProviderFailure(status, body)
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	reason, code, _ := providerFields(payload, 0)
	if reason == "" && code == "" {
		err.Message = fallback
		if status > 0 {
			err.Message += fmt.Sprintf("（上游 HTTP %d）", status)
		}
	}
	return err
}

// ProviderRequestFailure exposes the kind of transport failure without the
// URL, proxy credentials or private host/IP carried by net/url errors.
func ProviderRequestFailure(err error) *Error {
	if err == nil {
		return nil
	}
	var appErr *Error
	if errors.As(err, &appErr) {
		return appErr
	}
	var timeout net.Error
	var dns *net.DNSError
	code, message := CodeUpstreamUnavailable, "无法连接模型服务，请检查渠道地址、网络或代理连接"
	switch {
	case errors.Is(err, context.Canceled):
		return Wrap(CodeUpstreamUnavailable, "模型请求已取消", err)
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		code, message = CodeTimeout, "模型请求超时；上游是否已生成尚未确认，请勿立即重复提交"
	case errors.As(err, &dns):
		message = "模型服务域名解析失败，请联系管理员检查渠道地址和 DNS"
	case strings.Contains(strings.ToLower(err.Error()), "tls"), strings.Contains(strings.ToLower(err.Error()), "certificate"):
		message = "模型服务 TLS 连接或证书校验失败，请联系管理员检查渠道证书或代理"
	}
	return WithRetryable(Wrap(code, message, err), true)
}
