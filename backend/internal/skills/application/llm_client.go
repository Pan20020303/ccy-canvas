package application

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Minimal LLM chat client speaking the OpenAI Chat Completions wire format
// with tool calling. Compatible with any OpenAI-style relay (the project
// already uses several — Niuma, Qwen, Doubao, etc.).

type ChatMessage struct {
	Role       string     `json:"role"` // "system" | "user" | "assistant" | "tool"
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`  // only for "assistant"
	ToolCallID string     `json:"tool_call_id,omitempty"` // only for "tool"
	Name       string     `json:"name,omitempty"`         // tool name for "tool" messages
}

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // always "function"
	Function ToolCallFn `json:"function"`
}

type ToolCallFn struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON-encoded string (OpenAI quirk)
}

// ToolDef matches OpenAI's tools[] entry shape.
type ToolDef struct {
	Type     string `json:"type"` // always "function"
	Function ToolDefFn `json:"function"`
}

type ToolDefFn struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema
}

// Usage mirrors the OpenAI `usage` object. Drives the context-window meter:
// prompt_tokens ≈ how full the context was when this turn was sent, total_tokens
// ≈ context after this turn (which becomes part of next turn's context).
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ChatResponse is the agent-relevant subset of the upstream response.
type ChatResponse struct {
	Content      string
	ToolCalls    []ToolCall
	FinishReason string
	Usage        Usage
}

// StreamCallback is invoked for each text delta as it arrives on the wire.
// `delta` is the new token chunk for the assistant's textual reply. Tool-call
// deltas are accumulated internally and surfaced through the final
// ChatResponse — they are not streamed token-by-token because the UI cannot
// render a partial JSON-encoded tool call usefully.
type StreamCallback func(delta string)

// StreamOpts bundles the per-request streaming knobs so ChatStreamMulti's
// signature stays stable as options grow.
type StreamOpts struct {
	// OnDelta receives assistant text token chunks (may be nil).
	OnDelta StreamCallback
	// OnReasoning receives reasoning/thinking token chunks (deepseek/qwen 系
	// 网关的 delta.reasoning_content / delta.reasoning 字段;may be nil)。
	OnReasoning StreamCallback
	// Thinking 深度思考开关:nil=按模型默认;true/false=显式开/关。
	// 仅对已知思考类模型下发控制字段(见 applyThinkingControl),不影响其它模型。
	Thinking *bool
}

// isQwenHybridThinkingModel 判断百炼 qwen3.7 混合思考模型(qwen3.7-max/plus 及
// 日期快照)。modelcatalog.isQwenThinkingModel 的孪生 —— skills 包不 import
// modelcatalog(层级纠缠),两处同步维护。
func isQwenHybridThinkingModel(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "qwen3.7-")
}

// isThinkingCapableModel 判断"思考类"模型:deepseek 系、*-thinking、*-reasoner、
// glm-4.5+ 以及 qwen3.7 hybrid。用于决定是否允许下发 enable_thinking 控制字段
// (vLLM/SGLang/百炼及主流中转的事实标准;名单外的模型一律不发,避免严格网关 400)。
// 前端 model-templates.isThinkingCapableModel 是它的孪生,两处同步维护。
func isThinkingCapableModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	return isQwenHybridThinkingModel(m) ||
		strings.Contains(m, "deepseek") ||
		strings.Contains(m, "-thinking") ||
		strings.Contains(m, "reasoner") ||
		strings.Contains(m, "glm-4.5") || strings.Contains(m, "glm-4.6")
}

// applyThinkingControl 按开关与模型家族设置请求体的思考控制字段:
//   - nil(未指定):保持既有行为 —— qwen3.7 hybrid 显式关(agent 工具循环不需要
//     数分钟的 reasoning 空转),其它模型不动(deepseek 等默认自带思考)。
//   - true:qwen3.7 显式开;其它思考类模型默认已开,不发字段。
//   - false:所有思考类模型发 enable_thinking=false。
func applyThinkingControl(body map[string]any, model string, thinking *bool) {
	switch {
	case thinking == nil:
		if isQwenHybridThinkingModel(model) {
			body["enable_thinking"] = false
		}
	case *thinking:
		if isQwenHybridThinkingModel(model) {
			body["enable_thinking"] = true
		}
	default:
		if isThinkingCapableModel(model) {
			body["enable_thinking"] = false
		}
	}
}

// flexString 接受「字符串或任意 JSON 值」:OpenAI 标准里 tool_calls 的
// arguments 是 JSON 字符串,但 Ollama 系网关会直接给 JSON 对象 ——
// 按 string 解会让整个 chunk Unmarshal 失败,工具调用被静默丢弃。
// 非字符串值原样保留其 JSON 文本(对象 → `{"city":"Beijing"}`)。
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	if string(b) == "null" {
		*f = ""
		return nil
	}
	*f = flexString(b)
	return nil
}

// hasToolCallHistory 判断消息序列里是否有 assistant tool_calls 回传。
func hasToolCallHistory(messages []ChatMessage) bool {
	for _, m := range messages {
		if len(m.ToolCalls) > 0 {
			return true
		}
	}
	return false
}

// messagesWithObjectToolArgs 把 assistant tool_calls 的 arguments 从 JSON 字符串
// 换成 JSON 对象:Ollama 原生模板只认对象并对字符串报 4xx("can't find
// closing '}'"),而 OpenAI 标准网关只认字符串。仅在标准形态被网关拒绝后
// 作为降级重试形态使用(见 ChatStreamMultiOpts)。
func messagesWithObjectToolArgs(messages []ChatMessage) []any {
	out := make([]any, 0, len(messages))
	for _, m := range messages {
		if len(m.ToolCalls) == 0 {
			out = append(out, m)
			continue
		}
		tcs := make([]map[string]any, 0, len(m.ToolCalls))
		for _, tc := range m.ToolCalls {
			var args any = tc.Function.Arguments
			if json.Valid([]byte(tc.Function.Arguments)) {
				args = json.RawMessage(tc.Function.Arguments)
			}
			tcs = append(tcs, map[string]any{
				"id":   tc.ID,
				"type": tc.Type,
				"function": map[string]any{
					"name":      tc.Function.Name,
					"arguments": args,
				},
			})
		}
		mm := map[string]any{"role": m.Role, "tool_calls": tcs}
		if m.Content != "" {
			mm["content"] = m.Content
		}
		out = append(out, mm)
	}
	return out
}

type LLMClient struct {
	httpClient *http.Client
}

func NewLLMClient() *LLMClient {
	// Long timeout so streaming responses that take minutes don't get cut.
	return &LLMClient{httpClient: &http.Client{Timeout: 10 * time.Minute}}
}

// Chat is the non-streaming entrypoint kept for callers that don't care about
// progressive output. Internally it just collects the stream and returns the
// fully-formed response.
func (c *LLMClient) Chat(
	ctx context.Context,
	baseURL, apiKey, model string,
	messages []ChatMessage,
	tools []ToolDef,
) (*ChatResponse, error) {
	return c.ChatStream(ctx, baseURL, apiKey, model, messages, tools, nil)
}

// Endpoint identifies one upstream provider candidate. ProviderID lets the
// runner report per-endpoint success/failure to the channel-health layer
// so the next request can route around a sick channel.
type Endpoint struct {
	ProviderID string
	BaseURL    string
	APIKey     string
}

// ChatStream runs one completion turn against an OpenAI-compatible endpoint
// in streaming mode. Text deltas are passed to onDelta (may be nil) as they
// arrive. Tool-call fragments are accumulated and returned in ChatResponse.
//
// Retries up to twice on transient connection errors (EOF / broken pipe /
// connection reset) — those are common when relay proxies recycle idle TLS
// connections.
func (c *LLMClient) ChatStream(
	ctx context.Context,
	baseURL, apiKey, model string,
	messages []ChatMessage,
	tools []ToolDef,
	onDelta StreamCallback,
) (*ChatResponse, error) {
	return c.ChatStreamMulti(ctx, []Endpoint{{BaseURL: baseURL, APIKey: apiKey}}, model, messages, tools, onDelta, nil)
}

// ChannelHealthReporter receives per-endpoint outcomes so the routing
// layer can update its long-lived health state (failure counters, cooldown
// windows). Implemented by modelcatalog.application.Service via a small
// shim — kept as an interface here to avoid the skills package importing
// modelcatalog (would tangle the layering).
type ChannelHealthReporter interface {
	OnEndpointSuccess(ctx context.Context, providerID string)
	OnEndpointFailure(ctx context.Context, providerID string, httpStatus int, errMsg string)
}

// ChatStreamMulti tries each endpoint in order, returning the first success.
// On transient errors (EOF / connection reset / etc.) it retries the same
// endpoint up to twice; on a hard failure it advances to the next endpoint,
// implementing cross-vendor fallback for the same model name.
//
// If `health` is non-nil, success / failure of each endpoint is reported
// so future requests can sidestep recently-failed channels (see channel_health).
//
// Use this when the model is served by multiple providers (e.g. two relays
// that both expose `claude-sonnet-4-5`) — calls succeed as long as ANY of
// them is reachable.
func (c *LLMClient) ChatStreamMulti(
	ctx context.Context,
	endpoints []Endpoint,
	model string,
	messages []ChatMessage,
	tools []ToolDef,
	onDelta StreamCallback,
	health ChannelHealthReporter,
) (*ChatResponse, error) {
	return c.ChatStreamMultiOpts(ctx, endpoints, model, messages, tools, StreamOpts{OnDelta: onDelta}, health)
}

// ChatStreamMultiOpts 是 ChatStreamMulti 的完整版:reasoning 流回调 + 思考开关。
func (c *LLMClient) ChatStreamMultiOpts(
	ctx context.Context,
	endpoints []Endpoint,
	model string,
	messages []ChatMessage,
	tools []ToolDef,
	opts StreamOpts,
	health ChannelHealthReporter,
) (*ChatResponse, error) {
	if len(endpoints) == 0 {
		return nil, errors.New("no endpoints configured for model")
	}

	var lastErr error
	for _, ep := range endpoints {
		const maxAttempts = 3
		var endpointLastErr error
		objectArgs := false
		triedObjectArgs := false
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			resp, err := c.doStream(ctx, ep.BaseURL, ep.APIKey, model, messages, tools, opts, objectArgs)
			if err == nil {
				if health != nil && ep.ProviderID != "" {
					health.OnEndpointSuccess(ctx, ep.ProviderID)
				}
				return resp, nil
			}
			lastErr = err
			endpointLastErr = err
			// If the error isn't transient we don't bother retrying the same
			// endpoint — but we DO continue to the next endpoint if available,
			// because a 5xx / 401 / etc. from one provider doesn't tell us
			// anything about whether the others will fail too.
			if !isTransientStreamError(err) {
				// Ollama 系网关不认字符串式 tool_calls.arguments(4xx):
				// 换对象形态对同一 endpoint 降级重试一次。
				if !triedObjectArgs && hasToolCallHistory(messages) && strings.Contains(err.Error(), "LLM HTTP 4") {
					triedObjectArgs = true
					objectArgs = true
					continue
				}
				break
			}
			if attempt == maxAttempts {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * 250 * time.Millisecond):
			}
		}
		// Endpoint exhausted — report failure (http status is extracted from
		// the error string in modelcatalog.ClassifyError; we pass 0 here
		// because streaming errors typically don't surface a clean status).
		if health != nil && ep.ProviderID != "" && endpointLastErr != nil {
			health.OnEndpointFailure(ctx, ep.ProviderID, 0, endpointLastErr.Error())
		}
	}
	return nil, lastErr
}

func (c *LLMClient) doStream(
	ctx context.Context,
	baseURL, apiKey, model string,
	messages []ChatMessage,
	tools []ToolDef,
	opts StreamOpts,
	objectToolArgs bool,
) (*ChatResponse, error) {
	// objectToolArgs:tool_calls.arguments 以 JSON 对象发送(Ollama 降级形态)。
	var wireMessages any = messages
	if objectToolArgs {
		wireMessages = messagesWithObjectToolArgs(messages)
	}
	body := map[string]any{
		"model":    model,
		"messages": wireMessages,
		"stream":   true,
		// 要求网关在流末尾附带 usage 尾包(OpenAI 兼容),用于上下文窗口计量。
		// 不支持该选项的网关会忽略它 —— 那时 usage 为 0,前端计量表自然隐藏。
		"stream_options": map[string]any{"include_usage": true},
	}
	// 思考控制:nil 保持模型默认(qwen3.7 例外,默认显式关);true/false 显式开关。
	// 严格按模型名 gate,不影响非思考类模型 —— 与 modelcatalog.applyQwenThinkingDefaults
	// 同规则(包间不互相 import,故此处内联)。
	applyThinkingControl(body, model, opts.Thinking)
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	bodyJSON, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("LLM request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
		return nil, fmt.Errorf("LLM HTTP %d: %s", resp.StatusCode, string(raw))
	}

	// Some relays don't honour stream:true and just send a regular JSON body.
	// Detect by Content-Type and fall back to the one-shot parser.
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "event-stream") && !strings.Contains(ct, "text/plain") {
		return parseOneShot(resp.Body, opts)
	}

	return parseSSE(resp.Body, opts)
}

// parseSSE consumes a Server-Sent Events stream and reconstructs the OpenAI
// response. Each `data: {...}` line carries a chunk; `data: [DONE]` ends it.
func parseSSE(r io.Reader, opts StreamOpts) (*ChatResponse, error) {
	onDelta := opts.OnDelta
	scanner := bufio.NewScanner(r)
	// SSE chunks from some providers can be large (tool args, structured output).
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var (
		contentBuilder strings.Builder
		toolCalls      []ToolCall
		finishReason   string
		usage          Usage
	)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			// 残次网关(见过 OllamaAPIGateway)在流式模式下先回 200,再把上游的
			// HTTP 4xx 错误响应「原文」嵌进流里,之后既不发 [DONE] 也不关连接,
			// 而且末尾的 JSON 错误体没有换行(Scanner 永远凑不满一行)——只能
			// 在读到 4xx 状态行的瞬间立即终止上抛,让上层换 tool_calls 形态
			// 降级重试,绝不等一个永远不会结束的流。
			if fields := strings.Fields(line); len(fields) >= 2 && strings.HasPrefix(fields[0], "HTTP/1.") && strings.HasPrefix(fields[1], "4") {
				return nil, fmt.Errorf("LLM HTTP 4xx (embedded in stream): %s", line)
			}
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
					// 思考流:dashscope/deepseek 系用 reasoning_content,
					// OpenRouter 等用 reasoning —— 两个都认。
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
					ToolCalls []struct {
						// index 标准在 tool_call 层;Ollama 系网关放到 function 里 —— 两处都认。
						Index    *int   `json:"index"`
						ID       string `json:"id,omitempty"`
						Type     string `json:"type,omitempty"`
						Function struct {
							Index     *int       `json:"index"`
							Name      string     `json:"name,omitempty"`
							Arguments flexString `json:"arguments,omitempty"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage *Usage `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			// Some relays send a final non-JSON line (e.g. error JSON without "data:").
			continue
		}
		// usage 尾包通常 choices 为空 —— 必须在下面的空-choices 跳过之前抓取。
		if chunk.Usage != nil && chunk.Usage.TotalTokens > 0 {
			usage = *chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]

		if rDelta := choice.Delta.ReasoningContent + choice.Delta.Reasoning; rDelta != "" && opts.OnReasoning != nil {
			opts.OnReasoning(rDelta)
		}

		if delta := choice.Delta.Content; delta != "" {
			contentBuilder.WriteString(delta)
			if onDelta != nil {
				onDelta(delta)
			}
		}

		for seq, tcDelta := range choice.Delta.ToolCalls {
			idx := seq // 两处都没给 index 时按出现顺序排
			if tcDelta.Index != nil {
				idx = *tcDelta.Index
			} else if tcDelta.Function.Index != nil {
				idx = *tcDelta.Function.Index
			}
			// Grow the slice as needed to fit the index.
			for len(toolCalls) <= idx {
				toolCalls = append(toolCalls, ToolCall{Type: "function"})
			}
			target := &toolCalls[idx]
			if tcDelta.ID != "" {
				target.ID = tcDelta.ID
			}
			if tcDelta.Type != "" {
				target.Type = tcDelta.Type
			}
			if tcDelta.Function.Name != "" {
				target.Function.Name = tcDelta.Function.Name
			}
			if tcDelta.Function.Arguments != "" {
				target.Function.Arguments += string(tcDelta.Function.Arguments)
			}
		}

		if choice.FinishReason != "" {
			finishReason = choice.FinishReason
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("LLM stream read: %w", err)
	}

	return &ChatResponse{
		Content:      contentBuilder.String(),
		ToolCalls:    toolCalls,
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

// parseOneShot handles the fallback case where the relay ignored stream:true
// and returned a regular JSON body. We still emit the whole text as a single
// delta so the UI sees something.
func parseOneShot(r io.Reader, opts StreamOpts) (*ChatResponse, error) {
	onDelta := opts.OnDelta
	raw, err := io.ReadAll(io.LimitReader(r, 4*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("LLM read: %w", err)
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				// arguments 用 flexString:Ollama 系网关给 JSON 对象而非字符串。
				ToolCalls []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string     `json:"name"`
						Arguments flexString `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage Usage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("LLM parse: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, errors.New("LLM returned no choices")
	}
	choice := parsed.Choices[0]
	if choice.Message.ReasoningContent != "" && opts.OnReasoning != nil {
		opts.OnReasoning(choice.Message.ReasoningContent)
	}
	if choice.Message.Content != "" && onDelta != nil {
		onDelta(choice.Message.Content)
	}
	toolCalls := make([]ToolCall, 0, len(choice.Message.ToolCalls))
	for _, tc := range choice.Message.ToolCalls {
		typ := tc.Type
		if typ == "" {
			typ = "function"
		}
		toolCalls = append(toolCalls, ToolCall{
			ID:   tc.ID,
			Type: typ,
			Function: ToolCallFn{
				Name:      tc.Function.Name,
				Arguments: string(tc.Function.Arguments),
			},
		})
	}
	return &ChatResponse{
		Content:      choice.Message.Content,
		ToolCalls:    toolCalls,
		FinishReason: choice.FinishReason,
		Usage:        parsed.Usage,
	}, nil
}

// VisionOneShot 发送一轮多模态消息(问题 + 一张图)并返回文本回复。
// ChatMessage.Content 是纯文本(agent 主循环用),多模态 content parts 在
// 这里手工构造 —— 只服务 analyze_image 这类"看图"工具,非流式一把梭。
func (c *LLMClient) VisionOneShot(
	ctx context.Context,
	endpoints []Endpoint,
	model string,
	imageURL string,
	prompt string,
) (string, error) {
	if len(endpoints) == 0 {
		return "", errors.New("no endpoints configured for vision model")
	}
	body := map[string]any{
		"model":  model,
		"stream": false,
		"messages": []map[string]any{{
			"role": "user",
			"content": []map[string]any{
				{"type": "text", "text": prompt},
				{"type": "image_url", "image_url": map[string]string{"url": imageURL}},
			},
		}},
	}
	bodyJSON, _ := json.Marshal(body)

	var lastErr error
	for _, ep := range endpoints {
		answer, err := c.visionOnce(ctx, ep, bodyJSON)
		if err == nil {
			return answer, nil
		}
		lastErr = err
	}
	return "", lastErr
}

func (c *LLMClient) visionOnce(ctx context.Context, ep Endpoint, bodyJSON []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.BaseURL+"/chat/completions", bytes.NewReader(bodyJSON))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+ep.APIKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
		return "", fmt.Errorf("vision LLM HTTP %d: %s", resp.StatusCode, string(raw))
	}
	parsed, err := parseOneShot(resp.Body, StreamOpts{})
	if err != nil {
		return "", err
	}
	return parsed.Content, nil
}

// isTransientStreamError tells whether an error is worth retrying. Covers the
// usual "relay closed the idle TLS connection" symptoms.
func isTransientStreamError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	msg := err.Error()
	transientSnippets := []string{
		"EOF",
		"connection reset",
		"broken pipe",
		"forcibly closed",
		"unexpected EOF",
		"i/o timeout",
	}
	for _, s := range transientSnippets {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}
