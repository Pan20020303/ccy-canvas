package application

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRealDelegationRunsIsolatedChildAndReturnsToParent(t *testing.T) {
	var id pgtype.UUID
	_ = id.Scan("11111111-1111-1111-1111-111111111111")
	child := sqlc.Agent{ID: id, Name: "分镜顾问", Enabled: true, SystemPrompt: "child-only-system", Model: "child-model"}
	requests := 0
	childRequests := 0
	rootRequests := 0
	toolName := "delegate_11111111111111111111111111111111"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model       string        `json:"model"`
			Messages    []ChatMessage `json:"messages"`
			Tools       []ToolDef     `json:"tools"`
			Temperature *float64      `json:"temperature"`
			MaxTokens   int           `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests++
		message := map[string]any{"content": "parent final"}
		if body.Model == "child-model" {
			childRequests++
			if len(body.Messages) != 2 || body.Messages[0].Content != "child-only-system" || len(body.Tools) != 0 {
				t.Errorf("child context/permissions leaked: %+v", body)
			}
			if body.Temperature == nil || *body.Temperature != 0 || body.MaxTokens != 1234 {
				t.Errorf("model settings not applied: %+v", body)
			}
			message["content"] = "verified child result"
		} else {
			rootRequests++
			if rootRequests == 1 {
				message = map[string]any{"tool_calls": []any{map[string]any{"id": "dispatch", "type": "function", "function": map[string]any{"name": toolName, "arguments": `{"instruction":"Plan three shots"}`}}}}
			} else {
				last := body.Messages[len(body.Messages)-1]
				if last.Role != "tool" || last.Content != "verified child result" {
					t.Errorf("parent did not receive real result: %+v", last)
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}, "usage": map[string]int{"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}})
	}))
	defer server.Close()
	llm := &LLMClient{httpClient: server.Client()}
	temp := 0.0
	tools := BuildDelegationTools([]sqlc.Agent{child, {Name: "disabled", Enabled: false}}, func(ctx context.Context, c sqlc.Agent, args json.RawMessage) (string, error) {
		runner := Runner{LLM: llm, BaseURL: server.URL, APIKey: "test"}
		stats, err := runner.Run(ctx, RunInput{SystemPrompt: c.SystemPrompt, Model: c.Model, UserMessage: string(args), Temperature: &temp, MaxOutputTokens: 1234}, func(string, any) {})
		return stats.FinalReply, err
	})
	if len(tools) != 1 {
		t.Fatal("disabled child must not be exposed")
	}
	runner := Runner{LLM: llm, BaseURL: server.URL, APIKey: "test"}
	stats, err := runner.Run(context.Background(), RunInput{SystemPrompt: "parent secret history", Model: "parent-model", UserMessage: "make a storyboard", Tools: tools}, func(string, any) {})
	if err != nil || stats.FinalReply != "parent final" || requests != 3 || childRequests != 1 {
		t.Fatalf("delegation did not execute: %+v %v requests=%d", stats, err, requests)
	}
	if stats.TotalUsage.TotalTokens != 16 || stats.Usage.TotalTokens != 8 {
		t.Fatalf("usage not accumulated: %+v", stats)
	}
}

func TestDelegationRejectsEmptyInstruction(t *testing.T) {
	called := false
	tools := BuildDelegationTools([]sqlc.Agent{{Enabled: true}}, func(context.Context, sqlc.Agent, json.RawMessage) (string, error) { called = true; return "", nil })
	for _, raw := range []string{`{}`, `{"instruction":" "}`, `broken`} {
		if _, err := tools[0].Execute(context.Background(), json.RawMessage(raw)); err == nil {
			t.Fatal("invalid instruction accepted")
		}
	}
	if called {
		t.Fatal("invalid request executed child")
	}
}
func TestMemoryPolicyLimits(t *testing.T) {
	p := NormalizeMemoryPolicy([]byte(`{"shortTermLimit":999,"deepRetrieveSummaryLimit":999}`))
	if p.ShortTermLimit != 50 || p.RetrieveLimit != 20 {
		t.Fatal(p)
	}
	p = NormalizeMemoryPolicy([]byte(`{"shortTermLimit":0,"deepRetrieveSummaryLimit":-2}`))
	if p.ShortTermLimit != 12 || p.RetrieveLimit != 5 {
		t.Fatal(p)
	}
}
