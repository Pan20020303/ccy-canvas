package application

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLLMHTTPFailureReachesRunnerAndPublicEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		_, _ = w.Write([]byte(`{"error":{"message":"temperature is not supported; token=hidden-value","param":"temperature"}}`))
	}))
	defer server.Close()
	runner := Runner{LLM: &LLMClient{httpClient: server.Client()}, BaseURL: server.URL, APIKey: "test-key"}
	var events []map[string]any
	_, err := runner.Run(context.Background(), RunInput{Model: "test-model", UserMessage: "hi"}, func(event string, data any) {
		if event == EventError {
			if d, ok := data.(map[string]any); ok {
				events = append(events, d)
			}
		}
	})
	if err == nil || !strings.Contains(apperror.PublicMessage(err), "temperature is not supported") {
		t.Fatalf("%v", err)
	}
	if len(events) != 1 || events[0]["source"] != "application_error" {
		t.Fatalf("%v", events)
	}
	if strings.Contains(events[0]["message"].(string), "hidden-value") {
		t.Fatal("secret leaked")
	}
}

func TestLLMRecognizesErrorsInsideSuccessfulHTTPResponse(t *testing.T) {
	body := `{"error":{"code":"model_not_found","message":"The requested model has been removed"}}`
	for _, stream := range []bool{false, true} {
		var err error
		if stream {
			_, err = parseSSE(strings.NewReader("data: "+body+"\n\ndata: [DONE]\n\n"), StreamOpts{})
		} else {
			_, err = parseOneShot(strings.NewReader(body), StreamOpts{})
		}
		if err == nil || !strings.Contains(apperror.PublicMessage(err), "model has been removed") || providerErrorStatus(err) != 200 {
			t.Fatalf("stream=%v err=%v", stream, err)
		}
	}
}

func TestEmptyLLMStreamIsNotSuccess(t *testing.T) {
	if _, err := parseSSE(strings.NewReader("data: [DONE]\n\n"), StreamOpts{}); err == nil || !strings.Contains(apperror.PublicMessage(err), "空响应") {
		t.Fatalf("%v", err)
	}
}
