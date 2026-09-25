package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAgentMediaModelStaysSelected(t *testing.T) {
	for _, tc := range []struct{ selected, declared, want string }{
		{"deepseek-flash", "", "deepseek-flash"},
		{"deepseek-v4-flash", "qwen3.7-plus", "deepseek-v4-flash"},
		{"deepseek-v4-flash-vision-exp", "", "deepseek-v4-flash-vision-exp"},
		{"deepseek-v4-pro", "deepseek-v4-pro", ""},
		{"deepseek-chat", "deepseek-chat", ""},
		{"plain-text", "qwen3.7-plus", ""},
		{"configured-vision", "configured-vision", "configured-vision"},
		{"", "qwen3.7-plus", ""},
	} {
		if got := AgentVisionModel(tc.selected, tc.declared); got != tc.want {
			t.Errorf("%+v: got %q", tc, got)
		}
	}
	tools := BuildAgentMediaTools(NewCanvasState(nil, nil, nil), NewLLMClient(), []Endpoint{{BaseURL: "https://api.deepseek.com"}}, "deepseek-flash", "other-model")
	if len(tools) != 2 || tools[0].Name() != "analyze_image" || tools[1].Name() != "analyze_video" {
		t.Fatalf("media tools: %v", tools)
	}
}

func TestVisionFramesUseTimestampedImagePartsSameModelAndEffort(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if r.URL.Path != "/chat/completions" || body["model"] != "deepseek-flash" || body["reasoning_effort"] != "high" {
			t.Errorf("wrong route/control: %v", body)
		}
		if body["thinking"].(map[string]any)["type"] != "enabled" {
			t.Error("thinking lost")
		}
		parts := body["messages"].([]any)[0].(map[string]any)["content"].([]any)
		if len(parts) != 5 {
			t.Errorf("parts count=%d", len(parts))
			return
		}
		for index, timestamp := range []string{"0.000", "1.500"} {
			if !strings.Contains(parts[1+index*2].(map[string]any)["text"].(string), timestamp) {
				t.Error("timestamp missing")
			}
			part := parts[2+index*2].(map[string]any)
			if part["type"] != "image_url" || !strings.HasPrefix(part["image_url"].(map[string]any)["url"].(string), "data:image/jpeg;base64,") {
				t.Error("not real image content")
			}
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"基于抽取画面：人物向右移动。"},"finish_reason":"stop"}]}`)
	}))
	defer srv.Close()
	on := true
	ctx := withVisionOptions(context.Background(), &on, "high")
	answer, err := NewLLMClient().VisionFramesOneShot(ctx, []Endpoint{{BaseURL: srv.URL}}, "deepseek-flash", []VisionFrame{
		{ImageURL: "data:image/jpeg;base64,/9j/", TimestampSeconds: 0},
		{ImageURL: "data:image/jpeg;base64,/9j/", TimestampSeconds: 1.5},
	}, "分析动作")
	if err != nil || !strings.Contains(answer, "人物") || calls != 1 {
		t.Fatalf("answer=%q err=%v calls=%d", answer, err, calls)
	}
}

func TestVisionRequestRejectsInvalidFramesBeforeHTTP(t *testing.T) {
	client := NewLLMClient()
	client.httpClient.Transport = connectionTestTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected request"); return nil, nil })
	ep := []Endpoint{{BaseURL: "https://example.invalid"}}
	for _, frames := range [][]VisionFrame{
		nil,
		{{ImageURL: "data:image/jpeg;base64,/9j/", TimestampSeconds: math.NaN()}},
		{{ImageURL: "data:image/jpeg;base64,/9j/", TimestampSeconds: 1}, {ImageURL: "data:image/jpeg;base64,/9j/", TimestampSeconds: 0}},
		{{ImageURL: "http://127.0.0.1/private.mov", TimestampSeconds: 0}},
		{{ImageURL: "data:video/mp4;base64,AAAA", TimestampSeconds: 0}},
	} {
		if _, err := client.VisionFramesOneShot(context.Background(), ep, "deepseek-flash", frames, "分析"); err == nil {
			t.Errorf("accepted %#v", frames)
		}
	}
}

func TestVisionRequestNoRedirectFallbackOrEmptySuccess(t *testing.T) {
	for _, response := range []struct {
		status int
		body   string
	}{
		{307, ""}, {500, `{"error":{"message":"failure"}}`},
		{200, `{"choices":[{"message":{"content":""}}]}`},
		{200, `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`},
	} {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("Location", "/redirect")
			w.WriteHeader(response.status)
			_, _ = io.WriteString(w, response.body)
		}))
		_, err := NewLLMClient().VisionOneShot(context.Background(), []Endpoint{{BaseURL: srv.URL}, {BaseURL: srv.URL}}, "deepseek-flash", "data:image/jpeg;base64,/9j/", "分析")
		srv.Close()
		if err == nil || calls != 1 {
			t.Errorf("status=%d err=%v calls=%d", response.status, err, calls)
		}
	}
}

func TestVisionRequestHonorsCancellationAndSizeBudget(t *testing.T) {
	client := NewLLMClient()
	calls := 0
	client.httpClient.Transport = connectionTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ep := []Endpoint{{BaseURL: "https://example.invalid"}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if _, err := client.VisionOneShot(ctx, ep, "deepseek-flash", "data:image/jpeg;base64,/9j/", "分析"); err == nil || calls != 1 {
		t.Fatalf("cancel err=%v calls=%d", err, calls)
	}
	if _, err := client.VisionOneShot(context.Background(), ep, "deepseek-flash", "data:image/jpeg;base64,"+strings.Repeat("A", 33<<20), "分析"); err == nil || calls != 1 {
		t.Fatalf("size err=%v calls=%d", err, calls)
	}
}

// Exercise the real agent -> image tool -> selected multimodal model -> final
// reply path, with a local mock upstream and no paid model request.
func TestAgentImageToolRoundTripUsesRealPixelsOnlyOnDemand(t *testing.T) {
	var pixels bytes.Buffer
	fixture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	fixture.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&pixels, fixture); err != nil {
		t.Fatal(err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pixels.Bytes())
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		var body struct {
			Model    string           `json:"model"`
			Effort   string           `json:"reasoning_effort"`
			Messages []map[string]any `json:"messages"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body.Model != "deepseek-flash" || body.Effort != "high" {
			t.Errorf("selected model/settings changed: %s/%s", body.Model, body.Effort)
		}
		w.Header().Set("Content-Type", "application/json")
		switch requests {
		case 1:
			raw, _ := json.Marshal(body.Messages)
			if bytes.Contains(raw, []byte("data:image")) {
				t.Error("image bytes read before a tool request")
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"tool_calls":[{"id":"image-1","type":"function","function":{"name":"analyze_image","arguments":"{\"node_id\":\"selected-image\",\"question\":\"描述颜色\"}"}}]},"finish_reason":"tool_calls"}]}`)
		case 2:
			parts, ok := body.Messages[0]["content"].([]any)
			if !ok || len(parts) != 2 {
				t.Errorf("vision request has no image parts: %#v", body.Messages)
				return
			}
			part := parts[1].(map[string]any)
			if part["image_url"].(map[string]any)["url"] != dataURL {
				t.Error("image content did not reach the selected model")
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"图片左上有红色色块。"},"finish_reason":"stop"}]}`)
		case 3:
			last := body.Messages[len(body.Messages)-1]
			if last["role"] != "tool" || !strings.Contains(last["content"].(string), "红色色块") {
				t.Errorf("visual result missing from continuation: %#v", last)
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"图片左上有红色色块。"},"finish_reason":"stop"}]}`)
		default:
			t.Errorf("unexpected duplicate request %d", requests)
		}
	}))
	defer server.Close()
	client := &LLMClient{httpClient: server.Client()}
	endpoints := []Endpoint{{BaseURL: server.URL}}
	state := NewCanvasState([]CanvasNode{{ID: "selected-image", Type: "referenceImageNode", Data: map[string]any{"image": dataURL}}}, nil, func(string, any) {})
	mediaTools := BuildAgentMediaTools(state, client, endpoints, "deepseek-flash", "")
	if requests != 0 {
		t.Fatal("registering tools must not read any media")
	}
	on := true
	runner := Runner{LLM: client, Endpoints: endpoints, MaxSteps: 3}
	stats, err := runner.Run(context.Background(), RunInput{Model: "deepseek-flash", UserMessage: "分析 selected-image", SystemPrompt: AgentMediaGuide, Thinking: &on, ReasoningEffort: "high", Tools: mediaTools}, func(string, any) {})
	if err != nil || requests != 3 || stats.ToolCalls != 1 || !strings.Contains(stats.FinalReply, "红色色块") {
		t.Fatalf("requests=%d stats=%+v err=%v", requests, stats, err)
	}
	if stats.PublicProgress == nil || stats.PublicProgress.Progress.ToolName != "analyze_image" || stats.PublicProgress.Progress.Status != "completed" {
		t.Fatalf("missing real analysis completion: %#v", stats.PublicProgress)
	}
}
