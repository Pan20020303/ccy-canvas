package application

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
)

// NewAPIClient is a thin OpenAI-compatible HTTP client used to call the
// external NewAPI gateway (https://github.com/QuantumNous/new-api).
//
// We deliberately don't pull in a heavyweight OpenAI SDK — NewAPI mirrors
// the OpenAI wire format exactly, and our needs are narrow: chat, image,
// (later) video. Net/http + a couple of typed structs is enough, and
// keeps service.go from depending on a third party library it doesn't
// otherwise need.
//
// Lifecycle: NewAPIClient is constructed once at boot in cmd/api/main.go
// and chained onto Service via Service.WithNewAPI. If NEWAPI_BASE_URL is
// empty the client is nil and Service falls back to the legacy
// per-provider path — this keeps the migration risk-free.
type NewAPIClient struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewNewAPIClient builds a client. baseURL should already include /v1
// (e.g. https://newapi.example.com/v1). Caller is responsible for
// validating non-empty inputs — pass nil result if the gateway isn't
// configured rather than constructing an empty client.
func NewNewAPIClient(baseURL, token string, timeoutSeconds int) *NewAPIClient {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 60
	}
	return &NewAPIClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Timeout: time.Duration(timeoutSeconds) * time.Second,
		},
	}
}

// Configured returns true if the client has both a base URL and a token,
// i.e. ready to make calls. Callers can use this to decide between the
// NewAPI fast path and the legacy provider path.
func (c *NewAPIClient) Configured() bool {
	return c != nil && c.baseURL != "" && c.token != ""
}

// ─── Chat / Completions ─────────────────────────────────────────────

// ChatMessage matches OpenAI's request schema.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest is the minimal subset of OpenAI's chat/completions schema
// we need today. More fields (tools, response_format, ...) can be added
// as later phases use them.
type ChatRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Temperature *float64      `json:"temperature,omitempty"`
	Stream      bool          `json:"stream,omitempty"`
}

// ChatResponse mirrors OpenAI's response. NewAPI returns the same shape.
type ChatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Index   int `json:"index"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// Chat runs a non-streaming chat completion call. Errors map to:
//   - apperror.CodeInternal for build/network/parse failures
//   - apperror.CodeInternal for non-2xx with the gateway's body folded in
func (c *NewAPIClient) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	if !c.Configured() {
		return nil, apperror.New(apperror.CodeInternal, "NewAPI client not configured")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to marshal chat request", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build chat request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("NewAPI chat request failed: %v", err), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, readNewAPIError(resp, "chat")
	}

	var out ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to parse NewAPI chat response", err)
	}
	if len(out.Choices) == 0 {
		return nil, apperror.New(apperror.CodeInternal, "NewAPI returned no chat choices")
	}
	return &out, nil
}

// ─── Streaming chat completions ─────────────────────────────────────

// streamHTTPClient is shared across all streaming calls so TCP connections /
// keep-alive are pooled instead of a fresh client per request. No Timeout on
// purpose: a stream can legitimately run for a while and the caller's ctx (the
// SSE request context) is what bounds and cancels it.
var streamHTTPClient = &http.Client{}

// streamChatCompletions POSTs an OpenAI-compatible chat/completions request
// with stream=true and invokes onDelta for each content delta as it arrives.
// Works for BOTH the NewAPI gateway and a direct provider — the wire format is
// identical, only (baseURL, token) differ. Returns the full accumulated text.
// Blocks until the stream ends ([DONE]), errors, or ctx is cancelled. No
// client-side Timeout: the caller's ctx (the SSE request context) bounds it.
func streamChatCompletions(ctx context.Context, baseURL, token, model, prompt string, images []string, onDelta func(string) error) (string, error) {
	streamBody := map[string]any{
		"model":      model,
		"messages":   []map[string]any{{"role": "user", "content": buildChatUserContent(prompt, images)}},
		"max_tokens": textMaxTokensForModel(model),
		"stream":     true,
	}
	// qwen3.7 混合思考模型:关思考。流式虽无 60s 超时,但开思考会先长时间只吐
	// reasoning_content(本函数只累加 delta.content),UI 看着像卡死;关掉后答案立即流式产出。
	applyQwenThinkingDefaults(streamBody, model)
	reqBody, err := json.Marshal(streamBody)
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, "Failed to marshal stream request", err)
	}
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, "Failed to build stream request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := streamHTTPClient.Do(httpReq)
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider stream request failed: %v", err), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", readNewAPIError(resp, "chat stream")
	}

	var full strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	// A single SSE line can be large; grow past the default 64 KB line cap.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue // comments (": ping") and blank separators
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue // skip keep-alive / non-JSON frames
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		delta := chunk.Choices[0].Delta.Content
		if delta == "" {
			continue
		}
		full.WriteString(delta)
		if onDelta != nil {
			if err := onDelta(delta); err != nil {
				return full.String(), err // client disconnected — stop cleanly
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return full.String(), ctx.Err()
		}
		return full.String(), apperror.Wrap(apperror.CodeInternal, "Stream read failed", err)
	}
	return full.String(), nil
}

// readNewAPIError reads a non-2xx response, attempts to extract the OpenAI
// error envelope, falls back to raw body. Caps body read at 64 KB.
func readNewAPIError(resp *http.Response, op string) error {
	const cap = 64 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, cap))
	bodyStr := strings.TrimSpace(string(body))

	// Try OpenAI-style envelope first.
	var envelope struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Message != "" {
		return apperror.New(apperror.CodeInternal,
			fmt.Sprintf("NewAPI %s HTTP %d (%s): %s", op, resp.StatusCode, envelope.Error.Type, envelope.Error.Message))
	}

	if bodyStr == "" {
		bodyStr = "(empty body)"
	}
	return apperror.New(apperror.CodeInternal,
		fmt.Sprintf("NewAPI %s HTTP %d: %s", op, resp.StatusCode, bodyStr))
}
