package application

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/shared/apperror"
)

func TestFilmThinkingDefaultsAreScoped(t *testing.T) {
	for _, tc := range []struct {
		node, model string
		want        bool
	}{
		{"automation-film-extract-project-job", "deepseek-flash", true},
		{"automation-film-split-project-job", "deepseek-v4-pro", true},
		{"automation-film-write-project-job", "deepseek-flash", false},
		{"canvas-node", "deepseek-flash", false},
		{"automation-film-extract-project-job", "deepseek-reasoner", false},
		{"automation-film-extract-project-job", "gpt-4.1", false},
	} {
		got := filmTextThinking(GenerateRequest{NodeID: tc.node, Model: tc.model})
		if (got != nil) != tc.want || (tc.want && got["type"] != "disabled") {
			t.Errorf("filmTextThinking(%s, %s) = %v", tc.node, tc.model, got)
		}
	}
}

func TestGenerateTextRequiresFinalContent(t *testing.T) {
	for _, gateway := range []bool{false, true} {
		for _, tc := range []struct {
			name, response, message, want string
		}{
			{"empty", `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`, "未返回最终正文", ""},
			{"reasoning-only", `{"choices":[{"message":{"content":null,"reasoning_content":"PRIVATE_THOUGHT"},"finish_reason":"length"}]}`, "输出长度上限", ""},
			{"whitespace", `{"choices":[{"message":{"content":"  \n "}}]}`, "未返回最终正文", ""},
			{"normal", `{"choices":[{"message":{"content":"{\"assetsList\":[]}"},"finish_reason":"stop"}]}`, "", `{"assetsList":[]}`},
		} {
			t.Run(tc.name+map[bool]string{false: "/direct", true: "/gateway"}[gateway], func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var request struct {
						Thinking map[string]string `json:"thinking"`
						Model    string            `json:"model"`
					}
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
					}
					if request.Thinking["type"] != "disabled" || request.Model != "deepseek-flash" {
						t.Errorf("wrong request: %+v", request)
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.response))
				}))
				defer server.Close()
				s := &Service{}
				req := GenerateRequest{NodeID: "automation-film-extract-test", Model: "deepseek-flash", Prompt: "test"}
				var result *GenerateResult
				var err error
				if gateway {
					s.newAPI = NewNewAPIClient(server.URL, "test-only", 10)
					result, err = s.generateTextViaNewAPI(context.Background(), req)
				} else {
					result, err = s.generateText(context.Background(), server.URL, "test-only", req)
				}
				if calls != 1 {
					t.Fatalf("provider called %d times", calls)
				}
				if tc.message == "" {
					if err != nil || result == nil || result.Content != tc.want {
						t.Fatalf("result = %+v, err = %v", result, err)
					}
					return
				}
				var ae *apperror.Error
				if result != nil || !errors.As(err, &ae) || ae.Code != apperror.CodeUpstreamUnavailable || ae.Retryable {
					t.Fatalf("expected terminal provider error, result=%+v, err=%v", result, err)
				}
				if !strings.Contains(apperror.PublicMessage(err), tc.message) || strings.Contains(err.Error(), "PRIVATE_THOUGHT") {
					t.Fatalf("unsafe or unhelpful message: %v", err)
				}
			})
		}
	}
}
