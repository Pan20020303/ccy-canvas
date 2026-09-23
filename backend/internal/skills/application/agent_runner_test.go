package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRunnerIncludesConversationHistoryBeforeCurrentUserMessage(t *testing.T) {
	var capturedMessages []ChatMessage

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}

		var body struct {
			Messages []ChatMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		capturedMessages = body.Messages

		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{
					"message": map[string]any{
						"content": "Second-turn reply",
					},
					"finish_reason": "stop",
				},
			},
		})
	}))
	defer server.Close()

	runner := Runner{
		LLM: &LLMClient{httpClient: server.Client()},
		BaseURL: server.URL,
		APIKey: "test-key",
	}

	_, err := runner.Run(context.Background(), RunInput{
		SystemPrompt: "Stay helpful.",
		Model: "gpt-test",
		UserMessage: "Make it warmer.",
		History: []ChatMessage{
			{Role: "user", Content: "Draft a launch headline."},
			{Role: "assistant", Content: "Launch brighter with our summer collection."},
		},
	}, func(string, any) {})
	if err != nil {
		t.Fatalf("runner returned error: %v", err)
	}

	expected := []ChatMessage{
		{Role: "system", Content: "Stay helpful."},
		{Role: "user", Content: "Draft a launch headline."},
		{Role: "assistant", Content: "Launch brighter with our summer collection."},
		{Role: "user", Content: "Make it warmer."},
	}
	if len(capturedMessages) != len(expected) {
		t.Fatalf("expected %d messages, got %d", len(expected), len(capturedMessages))
	}
	for index, message := range expected {
		if capturedMessages[index].Role != message.Role || capturedMessages[index].Content != message.Content {
			t.Fatalf("message %d mismatch: got %#v want %#v", index, capturedMessages[index], message)
		}
	}
}

type runnerMutationTool struct{ executed *atomic.Bool }

func (t *runnerMutationTool) Name() string        { return "mutate_canvas" }
func (t *runnerMutationTool) Description() string { return "test mutation" }
func (t *runnerMutationTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object"}`)
}
func (t *runnerMutationTool) Execute(context.Context, json.RawMessage) (string, error) {
	t.executed.Store(true)
	return `{"ok":true}`, nil
}

func TestRunnerPausesForPagedQuestionsBeforeOtherTools(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requestCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{
					"content": "需要先确认两项信息。",
					"tool_calls": []map[string]any{
						{"id": "ask-1", "type": "function", "function": map[string]any{"name": "ask_user", "arguments": `{"question":"选择片型？","options":["剧情片","广告片"],"allow_custom":true}`}},
						{"id": "mutate-1", "type": "function", "function": map[string]any{"name": "mutate_canvas", "arguments": `{}`}},
						{"id": "ask-2", "type": "function", "function": map[string]any{"name": "ask_user", "arguments": `{"question":"选择风格？","options":["写实","动漫"],"allow_custom":true}`}},
					},
				},
				"finish_reason": "tool_calls",
			}},
		})
	}))
	defer server.Close()

	events := make([]string, 0, 12)
	emit := func(event string, _ any) { events = append(events, event) }
	mutationExecuted := &atomic.Bool{}
	runner := Runner{
		LLM:     &LLMClient{httpClient: server.Client()},
		BaseURL: server.URL,
		APIKey:  "test-key",
	}
	stats, err := runner.Run(context.Background(), RunInput{
		SystemPrompt: "Ask before acting.",
		Model:        "gpt-test",
		UserMessage:  "做一个宣传片",
		Tools: []Tool{
			BuildAskUserTool(emit),
			&runnerMutationTool{executed: mutationExecuted},
		},
	}, emit)
	if err != nil {
		t.Fatalf("runner returned error: %v", err)
	}

	if requestCount.Load() != 1 {
		t.Fatalf("expected the runner to pause after one model request, got %d", requestCount.Load())
	}
	if mutationExecuted.Load() {
		t.Fatal("non-question tool executed before the questionnaire was answered")
	}
	if stats.ToolCalls != 2 {
		t.Fatalf("expected only two ask_user calls, got %d", stats.ToolCalls)
	}
	if !strings.Contains(stats.FinalReply, "选择片型") || !strings.Contains(stats.FinalReply, "选择风格") {
		t.Fatalf("question summary missing questions: %q", stats.FinalReply)
	}
	askEvents := 0
	for _, event := range events {
		if event == "ask_user" {
			askEvents++
		}
	}
	if askEvents != 2 {
		t.Fatalf("expected two paged ask_user events, got %d", askEvents)
	}
}
