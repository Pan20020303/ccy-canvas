package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// ChatResponse is the agent-relevant subset of the upstream response.
type ChatResponse struct {
	Content      string
	ToolCalls    []ToolCall
	FinishReason string
}

type LLMClient struct {
	httpClient *http.Client
}

func NewLLMClient() *LLMClient {
	return &LLMClient{httpClient: &http.Client{Timeout: 90 * time.Second}}
}

// Chat runs one completion turn against an OpenAI-compatible endpoint.
// baseURL must already include the version segment (e.g. https://api.openai.com/v1).
func (c *LLMClient) Chat(
	ctx context.Context,
	baseURL, apiKey, model string,
	messages []ChatMessage,
	tools []ToolDef,
) (*ChatResponse, error) {
	body := map[string]any{
		"model":    model,
		"messages": messages,
	}
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

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("LLM request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("LLM HTTP %d: %s", resp.StatusCode, string(raw[:min(len(raw), 400)]))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content   string     `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("LLM parse: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("LLM returned no choices")
	}
	choice := parsed.Choices[0]
	return &ChatResponse{
		Content:      choice.Message.Content,
		ToolCalls:    choice.Message.ToolCalls,
		FinishReason: choice.FinishReason,
	}, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
