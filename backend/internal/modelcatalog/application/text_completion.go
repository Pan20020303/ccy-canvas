package application

import (
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"
)

// Film extraction/splitting need final structured output, not a reasoning-only
// response that exhausts the output budget. Keep this scoped to these jobs and
// known hybrid models; never send vendor options to unrelated models.
// https://api-docs.deepseek.com/guides/thinking_mode/
func filmTextThinking(req GenerateRequest) map[string]string {
	if !strings.HasPrefix(req.NodeID, "automation-film-extract-") && !strings.HasPrefix(req.NodeID, "automation-film-split-") {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(req.Model)) {
	case "deepseek-flash", "deepseek-v4-pro":
		return map[string]string{"type": "disabled"}
	default:
		return nil
	}
}

func textCompletionResult(content, finishReason string) (*GenerateResult, error) {
	if strings.TrimSpace(content) == "" {
		message := "模型未返回最终正文，请检查模型配置或切换文字模型后重试。"
		if finishReason == "length" {
			message = "模型已达到输出长度上限，但未返回最终正文。请缩短剧本、调整输出上限或切换文字模型后重试。"
		}
		// The provider already completed a potentially billable call. Do not
		// blindly resubmit it, or persist empty output as a successful result.
		return nil, apperror.WithRetryable(apperror.New(apperror.CodeUpstreamUnavailable, message), false)
	}
	return &GenerateResult{Type: "text", Content: content}, nil
}
