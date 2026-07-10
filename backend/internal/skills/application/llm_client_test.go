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

	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{})
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
	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{})
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if resp.Usage.TotalTokens != 0 {
		t.Fatalf("usage = %+v, want zero", resp.Usage)
	}
}

// reasoning_content / reasoning 两种字段都要流式回调;不进 Content。
func TestParseSSEStreamsReasoning(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"reasoning_content":"用户在打招呼,"}}]}`,
		`data: {"choices":[{"delta":{"reasoning":"直接回应即可。"}}]}`,
		`data: {"choices":[{"delta":{"content":"你好！"},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	}, "\n\n") + "\n\n"

	var reasoning strings.Builder
	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{
		OnReasoning: func(d string) { reasoning.WriteString(d) },
	})
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if reasoning.String() != "用户在打招呼,直接回应即可。" {
		t.Fatalf("reasoning = %q", reasoning.String())
	}
	if resp.Content != "你好！" {
		t.Fatalf("content = %q, want 你好！(reasoning 不应混入)", resp.Content)
	}
}

// 思考开关按模型 gate:qwen 默认关、显式可开;deepseek 默认不动、显式可关;
// 非思考模型任何情况都不发字段。
func TestApplyThinkingControl(t *testing.T) {
	on, off := true, false
	cases := []struct {
		model    string
		thinking *bool
		want     any // nil 表示不应设置 enable_thinking
	}{
		{"qwen3.7-plus", nil, false},
		{"qwen3.7-plus", &on, true},
		{"qwen3.7-plus", &off, false},
		{"deepseek-v4-flash", nil, nil},
		{"deepseek-v4-flash", &on, nil},
		{"deepseek-v4-flash", &off, false},
		{"gpt-4.1-mini", nil, nil},
		{"gpt-4.1-mini", &off, nil},
	}
	for _, c := range cases {
		body := map[string]any{}
		applyThinkingControl(body, c.model, c.thinking)
		got, ok := body["enable_thinking"]
		if c.want == nil {
			if ok {
				t.Fatalf("%s thinking=%v: enable_thinking 不应设置,got %v", c.model, c.thinking, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Fatalf("%s thinking=%v: enable_thinking = %v(ok=%v), want %v", c.model, c.thinking, got, ok, c.want)
		}
	}
}

// qwen3.7 gate 与 modelcatalog.isQwenThinkingModel 同规则(孪生,两处同步维护)。
func TestIsQwenHybridThinkingModel(t *testing.T) {
	cases := map[string]bool{
		"qwen3.7-plus":           true,
		"qwen3.7-max-2026-06-08": true,
		"QWEN3.7-PLUS":           true,
		"qwen-plus":              false,
		"gpt-4.1-mini":           false,
		"":                       false,
	}
	for model, want := range cases {
		if got := isQwenHybridThinkingModel(model); got != want {
			t.Fatalf("isQwenHybridThinkingModel(%q) = %v, want %v", model, got, want)
		}
	}
}
