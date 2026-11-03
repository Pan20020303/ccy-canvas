package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestGenerateVideoHopBaseGrok15UsesUnifiedGatewayAndPolls(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastVideoPoll(t)
	var submitted map[string]any
	submits := 0
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/video/generate":
			submits++
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			_, _ = w.Write([]byte(`{"task":{"id":"grok_task_1"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/video/tasks/grok_task_1":
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"task":{"status":"processing"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"task":{"status":"completed","outputs":[{"url":"https://cdn.example.com/grok.mp4"}]}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	svc := &Service{}
	result, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{
		Vendor: "HopBase", ServiceType: "video", APISpec: "custom",
		// These stale values simulate a channel created before the endpoint fix.
		SubmitEndpoint: "/v1/videos/generations", QueryEndpoint: "/v1/videos/{taskId}",
	}, server.URL, "hop-key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "a cinematic tracking shot",
		Duration: 12, Resolution: "1080p", AspectRatio: "16:9",
		AudioSetting: "on",
		Parameters:   map[string]any{"watermark": false},
	})
	if err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if result.Content != "https://cdn.example.com/grok.mp4" {
		t.Fatalf("result = %q", result.Content)
	}
	if submits != 1 {
		t.Fatalf("paid submits = %d, want exactly 1", submits)
	}
	if polls != 2 {
		t.Fatalf("polls = %d, want 2", polls)
	}
	if submitted["model"] != "grok-imagine-video-1.5" || submitted["aspect_ratio"] != "16:9" || submitted["resolution"] != "1080p" {
		t.Errorf("submit body = %#v", submitted)
	}
	if _, exists := submitted["ratio"]; exists {
		t.Errorf("grok-imagine-video-1.5 must not send unsupported ratio field: %#v", submitted)
	}
	if submitted["generate_audio"] != true {
		t.Errorf("explicitly enabled generate_audio = %#v, want true", submitted["generate_audio"])
	}
	if _, exists := submitted["watermark"]; exists {
		t.Errorf("grok-imagine-video-1.5 must not send unsupported watermark field: %#v", submitted)
	}
	content, ok := submitted["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("content = %#v", submitted["content"])
	}
	textPart, _ := content[0].(map[string]any)
	if textPart["type"] != "text" || textPart["text"] != "a cinematic tracking shot" {
		t.Errorf("text content = %#v", textPart)
	}
	if _, exists := submitted["prompt"]; exists {
		t.Errorf("legacy prompt field leaked into unified body: %#v", submitted)
	}
}

func TestGenerateVideoHopBaseGrok15BuildsAssetReferenceContent(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastVideoPoll(t)
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/video/generate":
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			_, _ = w.Write([]byte(`{"task":{"id":"grok_refs"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/video/tasks/grok_refs":
			_, _ = w.Write([]byte(`{"task":{"status":"completed","outputs":[{"url":"https://cdn.example.com/refs.mp4"}]}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	svc := &Service{}
	_, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{
		Vendor: "HopBase", ServiceType: "video", APISpec: "custom",
	}, server.URL, "hop-key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "@Image 1 enters @Image 2",
		Duration: 10, Resolution: "720p", AspectRatio: "9:16", ReferenceMode: "multi-image",
		ReferenceImages: []string{"asset://character", "asset://scene"},
	})
	if err != nil {
		t.Fatalf("multi-reference: %v", err)
	}
	content, ok := submitted["content"].([]any)
	if !ok || len(content) != 3 {
		t.Fatalf("content = %#v", submitted["content"])
	}
	for i, want := range []string{"asset://character", "asset://scene"} {
		part, _ := content[i+1].(map[string]any)
		imageURL, _ := part["image_url"].(map[string]any)
		if part["type"] != "image_url" || part["role"] != "reference_image" || imageURL["url"] != want {
			t.Errorf("reference part %d = %#v", i, part)
		}
	}
	if _, exists := submitted["reference_images"]; exists {
		t.Fatalf("legacy reference_images field leaked into unified body: %#v", submitted)
	}
	if _, exists := submitted["generate_audio"]; exists {
		t.Fatalf("disabled generate_audio must be omitted from request: %#v", submitted)
	}
}

func TestHopBaseGrokGenerateAudioEnabled(t *testing.T) {
	tests := []struct {
		name string
		req  GenerateRequest
		want bool
	}{
		{name: "default off", req: GenerateRequest{}, want: false},
		{name: "explicit off", req: GenerateRequest{AudioSetting: "off"}, want: false},
		{name: "ui switch on", req: GenerateRequest{AudioSetting: "on"}, want: true},
		{name: "parameter on", req: GenerateRequest{Parameters: map[string]any{"generate_audio": true}}, want: true},
		{name: "parameter false", req: GenerateRequest{Parameters: map[string]any{"generate_audio": false}}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hopBaseGrokGenerateAudioEnabled(tt.req); got != tt.want {
				t.Fatalf("hopBaseGrokGenerateAudioEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGenerateVideoHopBaseGrok15DoesNotRetryFailedSubmit(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	submits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		submits++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"message":"provider unavailable"}}`))
	}))
	defer server.Close()

	svc := &Service{}
	_, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{
		Vendor: "HopBase", ServiceType: "video", APISpec: "custom",
	}, server.URL, "hop-key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "single paid submit", Duration: 10,
	})
	if err == nil {
		t.Fatal("expected submit error")
	}
	if submits != 1 {
		t.Fatalf("paid submits = %d, want exactly 1", submits)
	}
}

func TestGenerateVideoHopBaseGrok15Rejects1080pMultiReferenceBeforeSubmit(t *testing.T) {
	svc := &Service{}
	_, err := svc.generateVideoHopBaseGrok15(context.Background(), &domain.ProviderConfig{}, "https://api.hop-base.com", "key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "test", Resolution: "1080p", Duration: 10,
		ReferenceMode: "multi-image", ReferenceImages: []string{"asset://a", "asset://b"},
	})
	if err == nil {
		t.Fatal("expected multi-reference 1080p validation error")
	}
}
