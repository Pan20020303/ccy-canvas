package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
