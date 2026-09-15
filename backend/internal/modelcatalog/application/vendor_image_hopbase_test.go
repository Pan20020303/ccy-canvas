package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestGenerateImageHopBaseSeedreamUsesGenerationJSONReferences(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Prefer"); got != "" {
			t.Fatalf("unexpected async header %q", got)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		refs, ok := body["image"].([]interface{})
		if !ok || len(refs) != 2 {
			t.Fatalf("image = %#v", body["image"])
		}
		if body["size"] != "2K" || body["response_format"] != "url" {
			t.Fatalf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"data":[{"url":"https://cdn.example.com/result.png"}]}`))
	}))
	defer server.Close()

	svc := &Service{}
	result, err := svc.generateImage(context.Background(), &domain.ProviderConfig{Vendor: "HopBase", ServiceType: "image"}, server.URL+"/v1", "hop-key", GenerateRequest{
		Model: "seedream-5-0-pro", Prompt: "combine", Resolution: "2K",
		ReferenceImages: []string{"https://example.com/a.png", "data:image/png;base64,AAAA"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "https://cdn.example.com/result.png" {
		t.Fatalf("content = %q", result.Content)
	}
}

func TestGenerateImageHopBaseParsesBase64Response(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"ZmFrZQ=="}]}`))
	}))
	defer server.Close()

	svc := &Service{}
	result, err := svc.generateImageHopBase(context.Background(), &domain.ProviderConfig{}, server.URL+"/v1", "hop-key", GenerateRequest{
		Model: "gpt-image-2", Prompt: "test", Size: "1:1", Quality: "medium",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "data:image/png;base64,ZmFrZQ==" {
		t.Fatalf("content = %q", result.Content)
	}
}

func TestHopBaseSeedreamLiteDefaultsToSupportedMinimum(t *testing.T) {
	got := hopBaseImageSize(GenerateRequest{Model: "seedream-5-0-lite", Resolution: "1K", Size: "1:1"})
	if got != "2K" {
		t.Fatalf("size = %q, want 2K", got)
	}
}
