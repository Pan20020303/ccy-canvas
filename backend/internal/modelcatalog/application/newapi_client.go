package application

import (
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
