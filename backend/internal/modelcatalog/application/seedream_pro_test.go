package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

func TestSeedreamProSizeKeepsRatioAtEveryTier(t *testing.T) {
	for _, tier := range []string{"1k", "1.5k", "2k"} {
		for _, ratio := range []string{"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5", "2:1", "1:2", "9:21"} {
			size, err := seedreamProImageSize(ratio, tier)
			if err != nil {
				t.Fatalf("%s %s: %v", tier, ratio, err)
			}
			pixels := strings.Split(size, "x")
			if len(pixels) != 2 {
				t.Fatalf("ratio was discarded: %s %s => %s", tier, ratio, size)
			}
			w, _ := strconv.Atoi(pixels[0])
			h, _ := strconv.Atoi(pixels[1])
			parts := strings.Split(ratio, ":")
			a, _ := strconv.Atoi(parts[0])
			b, _ := strconv.Atoi(parts[1])
			if w*b != h*a || w*h < 921600 || w*h > 4624220 {
				t.Fatalf("invalid Pro size: %s %s => %s", tier, ratio, size)
			}
		}
	}
	for _, tc := range []struct{ size, tier, want string }{
		{"3:4", "1k", "864x1152"}, {"16:9", "1.5k", "2048x1152"}, {"16:9", "2k", "2816x1584"},
		{"auto", "1.5k", "1.5K"}, {"auto", "", "2K"}, {"2048x1024", "", "2048x1024"},
	} {
		got, err := seedreamProImageSize(tc.size, tc.tier)
		if err != nil || got != tc.want {
			t.Fatalf("%+v: got=%s err=%v", tc, got, err)
		}
	}
	for _, tc := range []struct{ size, tier string }{{"1:1", "4k"}, {"auto", "3k"}, {"512x512", ""}, {"4096x4096", ""}, {"1000000000x1000000000", ""}, {"1:17", "1k"}, {"nonsense", "2k"}} {
		if _, err := seedreamProImageSize(tc.size, tc.tier); err == nil {
			t.Fatalf("invalid size accepted: %+v", tc)
		}
	}
}

func TestSeedreamProSubmissionUsesPixelsAndOptions(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/images/generations" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"data":[{"url":"https://media.example.test/result.png","size":"2048x1152"}]}`))
	}))
	defer server.Close()
	_, err := (&Service{}).generateImageVolcengine(context.Background(), &domain.ProviderConfig{Vendor: "Volcengine", APISpec: "ark"}, server.URL+"/api/v3", "mock-key", GenerateRequest{
		Model: "doubao-seedream-5-0-pro-260628", Prompt: "landscape", Size: "16:9", Resolution: "1.5K", OutputFormat: "png",
		ReferenceImages: []string{"https://media.example.test/reference.png"}, Parameters: map[string]any{"optimize_prompt_options": map[string]any{"mode": "fast"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if submitted["size"] != "2048x1152" || submitted["output_format"] != "png" || submitted["image"] != "https://media.example.test/reference.png" || submitted["watermark"] != false {
		t.Fatalf("submitted=%v", submitted)
	}
	if submitted["optimize_prompt_options"].(map[string]any)["mode"] != "fast" {
		t.Fatalf("mode=%v", submitted)
	}
	for _, field := range []string{"n", "quality", "aspect_ratio", "stream", "sequential_image_generation"} {
		if _, exists := submitted[field]; exists {
			t.Fatalf("unsupported field=%s", field)
		}
	}
}

func TestSeedreamProRejectsInvalidOptionsBeforeSubmit(t *testing.T) {
	for _, req := range []GenerateRequest{
		{Size: "1:1", Resolution: "4K"}, {Size: "1:1", Resolution: "1K", OutputFormat: "webp"},
		{Size: "1:1", Resolution: "1K", ReferenceImages: make([]string, 11)},
		{Parameters: map[string]any{"optimize_prompt_options": map[string]any{"mode": "invalid"}}},
	} {
		req.Model = "doubao-seedream-5-0-pro-260628"
		if _, err := (&Service{}).generateImageVolcengine(context.Background(), &domain.ProviderConfig{Vendor: "Volcengine"}, "https://example.invalid", "mock-key", req); err == nil {
			t.Fatalf("invalid options accepted: %+v", req)
		}
	}
	size, _, _, err := seedreamProOptions(GenerateRequest{AspectRatio: "3:4", Resolution: "1K"})
	if err != nil || size != "864x1152" {
		t.Fatalf("ratio field ignored: size=%s err=%v", size, err)
	}
}

func TestSeedreamProPreflightChecksBeforeCreditsOrMediaFetch(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encrypted, err := crypto.Encrypt(key, "mock-key")
	if err != nil {
		t.Fatal(err)
	}
	model := "doubao-seedream-5-0-pro-260628"
	svc := NewService(&fakeRepository{providerConfigs: []domain.ProviderConfig{{ID: "official", Vendor: "Volcengine", ServiceType: "image", Status: "enabled", ModelList: []string{model}, EncryptedAPIKey: encrypted}}}, key)
	req := GenerateRequest{ServiceType: "image", Model: model, Size: "3:4", Resolution: "1.5K", ReferenceImages: []string{"https://example.invalid/no-fetch.png"}}
	if err := svc.PreflightGeneration(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	req.Resolution = "4K"
	if err := svc.PreflightGeneration(context.Background(), req); err == nil {
		t.Fatal("invalid tier passed preflight")
	}
}
