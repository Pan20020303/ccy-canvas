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

// Ollama 系网关的非标准 tool_calls:arguments 是 JSON 对象(标准是字符串),
// index 放在 function 里。两种都必须解析出来,不能整块丢弃。
func TestParseSSEObjectArgumentsToolCall(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"index":0,"name":"get_weather","arguments":{"city":"Beijing"}}}]},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	}, "\n\n") + "\n\n"

	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{})
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if len(resp.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1 (%#v)", len(resp.ToolCalls), resp.ToolCalls)
	}
	tc := resp.ToolCalls[0]
	if tc.ID != "call_1" || tc.Function.Name != "get_weather" {
		t.Fatalf("tool call mismatch: %#v", tc)
	}
	if tc.Function.Arguments != `{"city":"Beijing"}` {
		t.Fatalf("arguments = %q, want JSON text", tc.Function.Arguments)
	}
	if resp.FinishReason != "stop" {
		t.Fatalf("finish reason = %q", resp.FinishReason)
	}
}

// 残次网关把上游 HTTP 400 原文嵌进 200 SSE 流:整条流零产出时必须上抛
// 为 "LLM HTTP 4xx" 错误,触发 tool_calls 形态降级重试。
func TestParseSSEEmbeddedHTTPErrorSurfaces(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}`,
		`HTTP/1.1 400 Bad Request`,
		`Content-Type: application/json; charset=utf-8`,
		``,
		`{"error":{"message":"Value looks like object, but can't find closing '}' symbol","type":"ollama_error"}}`,
	}, "\n\n") + "\n\n"

	_, err := parseSSE(strings.NewReader(stream), StreamOpts{})
	if err == nil {
		t.Fatal("expected embedded 4xx to surface as error")
	}
	if !strings.Contains(err.Error(), "LLM HTTP 4") {
		t.Fatalf("error %q should carry the LLM HTTP 4 marker for fallback retry", err)
	}
}

// 正常有产出的流,即使中途混入非 data 行,也不应报错。
func TestParseSSEIgnoresGarbageWhenContentPresent(t *testing.T) {
	stream := strings.Join([]string{
		`: ping`,
		`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	}, "\n\n") + "\n\n"
	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{})
	if err != nil || resp.Content != "hi" {
		t.Fatalf("resp=%v err=%v", resp, err)
	}
}

// 标准 OpenAI 分片(arguments 字符串逐段追加)不受兼容改动影响。
func TestParseSSEStringArgumentsStillAccumulate(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"run","arguments":"{\"a\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
	}, "\n\n") + "\n\n"

	resp, err := parseSSE(strings.NewReader(stream), StreamOpts{})
	if err != nil {
		t.Fatalf("parseSSE error: %v", err)
	}
	if len(resp.ToolCalls) != 1 || resp.ToolCalls[0].Function.Arguments != `{"a":1}` {
		t.Fatalf("tool calls = %#v", resp.ToolCalls)
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
