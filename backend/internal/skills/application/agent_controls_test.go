package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerationPolicySingleAndBatch(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "automatic"}[automatic], func(t *testing.T) {
			var runs []map[string]any
			state := NewCanvasState([]CanvasNode{{ID: "ready", Type: "imageNode", Data: map[string]any{"promptDraft": "test image"}}}, nil, func(event string, payload any) {
				if event == EventCanvasPatch {
					patch := payload.(map[string]any)
					if patch["op"] == "run_node" {
						runs = append(runs, patch)
					}
				}
			})
			state.AutomaticGeneration = automatic
			result, err := (&runNodeTool{state: state}).Execute(context.Background(), json.RawMessage(`{"node_id":"ready"}`))
			if err != nil {
				t.Fatal(err)
			}
			if automatic == strings.Contains(result, "awaiting_browser_confirmation") {
				t.Fatalf("wrong status: %s", result)
			}
			_, err = (&createGenerationBatchTool{state: state}).Execute(context.Background(), json.RawMessage(`{"node_type":"imageNode","items":[{"prompt":"first"},{"prompt":"second"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			if len(runs) != 3 {
				t.Fatalf("got %d runs", len(runs))
			}
			for _, patch := range runs {
				if patch["requires_confirmation"] != !automatic {
					t.Fatalf("wrong policy: %#v", patch)
				}
			}
		})
	}
}

func TestReasoningEffortIsModelSpecific(t *testing.T) {
	on, off := true, false
	for _, tt := range []struct {
		model, effort string
		thinking      *bool
		want          any
	}{
		{"deepseek-flash", "low", &on, "low"}, {"deepseek-pro", "high", &on, "high"},
		{"deepseek-v4-flash", "max", &on, "max"}, {"deepseek-flash", "max", &off, nil},
		{"deepseek-flash", "invalid", &on, nil}, {"deepseek-v3.2", "max", &on, nil},
		{"qwen3.7-plus", "max", &on, nil}, {"gpt-4.1", "max", &on, nil},
	} {
		body := map[string]any{}
		applyReasoningEffort(body, tt.model, StreamOpts{Thinking: tt.thinking, ReasoningEffort: tt.effort})
		if body["reasoning_effort"] != tt.want {
			t.Fatalf("%s/%s: %#v", tt.model, tt.effort, body)
		}
	}
}

func TestRunnerPassesEffortAndReasoningThroughToolLoop(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Thinking map[string]string `json:"thinking"`
			Effort   string            `json:"reasoning_effort"`
			Messages []ChatMessage     `json:"messages"`
			Tools    []ToolDef         `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Thinking["type"] != "enabled" || body.Effort != "max" {
			t.Errorf("controls lost: %#v", body)
		}
		for _, tool := range body.Tools {
			if tool.Function.Name == "delegate_agent" {
				t.Error("unexpected subagent tool")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"reasoning_content":"Inspect the selected node.","tool_calls":[{"id":"read-1","type":"function","function":{"name":"read_node","arguments":"{\"node_id\":\"ready\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		found := false
		for _, message := range body.Messages {
			if len(message.ToolCalls) > 0 {
				found = message.ReasoningContent == "Inspect the selected node."
			}
		}
		if !found {
			t.Error("reasoning_content dropped between tool calls")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Ready."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()
	on := true
	state := NewCanvasState([]CanvasNode{{ID: "ready", Type: "imageNode", Data: map[string]any{}}}, nil, func(string, any) {})
	runner := Runner{LLM: &LLMClient{httpClient: server.Client()}, BaseURL: server.URL, APIKey: "test", MaxSteps: 3}
	_, err := runner.Run(context.Background(), RunInput{Model: "deepseek-flash", UserMessage: "Inspect this node", Thinking: &on, ReasoningEffort: "max", Tools: BuildCanvasTools(state)}, func(string, any) {})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("got %d calls", calls)
	}
}

func TestSSEPreservesReasoningWithoutUICallback(t *testing.T) {
	response, err := parseSSE(strings.NewReader("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"reason\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n"), StreamOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if response.ReasoningContent != "reason" || response.Content != "answer" {
		t.Fatalf("unexpected response: %#v", response)
	}
}
