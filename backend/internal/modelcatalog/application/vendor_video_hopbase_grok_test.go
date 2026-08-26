package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestGenerateVideoHopBaseGrok15SubmitsOnceAndPollsNativeContract(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastVideoPoll(t)
	var submitted map[string]any
	submits := 0
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos/generations":
			submits++
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			_, _ = w.Write([]byte(`{"request_id":"grok_request_1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/grok_request_1":
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"status":"pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"done","video":{"url":"https://cdn.example.com/grok.mp4"}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	svc := &Service{}
	result, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{
		Vendor: "HopBase", ServiceType: "video", APISpec: "custom",
		SubmitEndpoint: "/v1/videos/generations", QueryEndpoint: "/v1/videos/{taskId}",
	}, server.URL, "hop-key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "a cinematic tracking shot",
		Duration: 12, Resolution: "1080p", AspectRatio: "16:9",
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
	if submitted["generate_audio"] != true {
		t.Errorf("generate_audio = %#v", submitted["generate_audio"])
	}
	if _, exists := submitted["content"]; exists {
		t.Errorf("Seedance content field leaked into Grok body: %#v", submitted)
	}
}

func TestGenerateVideoHopBaseGrok15BuildsReferenceImages(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastVideoPoll(t)
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos/generations":
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			_, _ = w.Write([]byte(`{"request_id":"grok_refs"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/grok_refs":
			_, _ = w.Write([]byte(`{"status":"done","video":{"url":"https://cdn.example.com/refs.mp4"}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	svc := &Service{}
	_, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{
		Vendor: "HopBase", ServiceType: "video", APISpec: "custom",
		SubmitEndpoint: "/v1/videos/generations", QueryEndpoint: "/v1/videos/{taskId}",
	}, server.URL, "hop-key", GenerateRequest{
		Model: "grok-imagine-video-1.5", Prompt: "<IMAGE_0> enters <IMAGE_1>",
		Duration: 10, Resolution: "720p", AspectRatio: "9:16", ReferenceMode: "multi-image",
		ReferenceImages: []string{"https://cdn.example.com/character.jpg", "https://cdn.example.com/scene.jpg"},
	})
	if err != nil {
		t.Fatalf("multi-reference: %v", err)
	}
	refs, ok := submitted["reference_images"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("reference_images = %#v", submitted["reference_images"])
	}
	if _, exists := submitted["image"]; exists {
		t.Fatalf("image and reference_images must not be combined: %#v", submitted)
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
		SubmitEndpoint: "/v1/videos/generations", QueryEndpoint: "/v1/videos/{taskId}",
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
		ReferenceMode: "multi-image", ReferenceImages: []string{"https://example.com/a.jpg", "https://example.com/b.jpg"},
	})
	if err == nil {
		t.Fatal("expected multi-reference 1080p validation error")
	}
}
