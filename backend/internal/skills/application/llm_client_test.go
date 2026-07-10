package application

import (
	"strings"
	"testing"
)

// usage 尾包(choices 为空)必须在空-choices 跳过之前被抓取 —— 驱动上下文计量表。
func TestParseSSECapturesUsageTailChunk(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"你好"}}]}`,
		`data: {"choices":[{"delta":{"content":"！"},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":602700,"completion_tokens":120,"total_tokens":602820}}`,
		`data: [DONE]`,
	}, "\n\n") + "\n\n"

	resp, err := parseSSE(strings.NewReader(stream), nil)
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if resp.Content != "你好！" {
		t.Fatalf("content = %q, want 你好！", resp.Content)
	}
	if resp.Usage.TotalTokens != 602820 || resp.Usage.PromptTokens != 602700 {
		t.Fatalf("usage = %+v, want total 602820 / prompt 602700", resp.Usage)
	}
}

// 不带 usage 的流(网关不支持 include_usage)→ Usage 保持零值,不报错。
func TestParseSSENoUsageIsZero(t *testing.T) {
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	resp, err := parseSSE(strings.NewReader(stream), nil)
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if resp.Usage.TotalTokens != 0 {
		t.Fatalf("usage = %+v, want zero", resp.Usage)
	}
}
