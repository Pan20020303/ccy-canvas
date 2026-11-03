package application

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

func TestZImageSuccessStagesImages(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/view" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(picture.Bytes())
			return
		}
		_, _ = w.Write([]byte(`{"id":{"status":{"status_str":"success","completed":true},"outputs":{"11":{"images":[{"filename":"a.png","type":"output"},{"filename":"b.png","type":"output"}]}}}}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	result, err := pollComfyZImage(ctx, server.URL, "id", "Z-Image")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ContentList) != 2 || result.Content != result.ContentList[0] {
		t.Fatalf("bad results: %+v", result)
	}
	for _, path := range result.ContentList {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(path, "/uploads/"))))
		if err != nil || !bytes.Equal(data, picture.Bytes()) {
			t.Fatal("output was not durably staged")
		}
	}
}

func TestZImageRejectedSubmissionIsNotRetried(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"bad graph"}}`))
	}))
	defer server.Close()
	_, err := NewService(nil, nil).generateImageComfyZImage(context.Background(), server.URL, GenerateRequest{Model: comfyZImageModel, Prompt: "test"})
	if err == nil || calls.Load() != 1 {
		t.Fatal("submission failure must return without retry")
	}
}

func TestZImageGraphParameters(t *testing.T) {
	seed := 123
	req := GenerateRequest{Model: comfyZImageModel, Prompt: "pixel art", Size: "16:9", Resolution: "1024px", Seed: &seed, Parameters: map[string]any{"steps": float64(12), "lora": "pixel-art", "lora_strength": 0.65, "sampler": "euler", "scheduler": "beta"}}
	o, err := zImageOptions(req)
	if err != nil {
		t.Fatal(err)
	}
	if o.Width != 1024 || o.Height != 576 || o.Seed != 123 || o.Steps != 12 {
		t.Fatalf("bad options: %+v", o)
	}
	g := buildComfyZImagePrompt(req.Prompt, o)
	ins := func(id string) map[string]any { return g[id].(map[string]any)["inputs"].(map[string]any) }
	if ins("7")["strength_model"] != 0.65 || ins("9")["steps"] != 12 || ins("9")["sampler_name"] != "euler" || ins("9")["scheduler"] != "beta" {
		t.Fatal("parameters were not mapped")
	}
	if ins("9")["cfg"] != 1.0 || ins("8")["shift"] != 3.0 {
		t.Fatal("Turbo defaults changed")
	}
	if ins("2")["type"] != "lumina2" {
		t.Fatal("wrong encoder architecture")
	}
	o.LoRA = "none"
	if _, ok := buildComfyZImagePrompt("test", o)["7"]; ok {
		t.Fatal("disabled lora was loaded")
	}
	o.LoRA = "pixel-art"
	o.LoRAStrength = 0
	if _, ok := buildComfyZImagePrompt("test", o)["7"]; ok {
		t.Fatal("zero-strength lora was loaded")
	}
	req.Model = comfyZImageV60Model
	o, err = zImageOptions(req)
	if err != nil || o.Checkpoint != "Z_ImageTurbo_v60Fp16.safetensors" {
		t.Fatal("wrong v60 mapping")
	}
}

func TestZImageInvalidInput(t *testing.T) {
	for _, params := range []map[string]any{
		{"steps": 3.0}, {"steps": 8.5}, {"steps": "8"}, {"lora": "../../other.safetensors"}, {"lora_strength": 2.0}, {"sampler": "bad"}, {"scheduler": "bad"}, {"unknown": true},
	} {
		_, err := zImageOptions(GenerateRequest{Model: comfyZImageModel, Prompt: "test", Parameters: params})
		if err == nil || apperror.Normalize(err).Code != apperror.CodeInvalidInput {
			t.Fatalf("accepted %+v", params)
		}
	}
	for _, req := range []GenerateRequest{
		{Model: comfyZImageModel, Prompt: "test", ReferenceImages: []string{"image.png"}},
		{Model: comfyZImageModel, Prompt: "test", Resolution: "4K"},
		{Model: comfyZImageModel, Prompt: "test", OutputCount: 5},
		{Model: comfyZImageModel, Prompt: "test", Size: "37:1"},
	} {
		if _, err := zImageOptions(req); err == nil {
			t.Fatal("accepted unsupported request")
		}
	}
	if isComfyZImageProvider(&domain.ProviderConfig{Vendor: "OpenAI"}, comfyZImageModel) {
		t.Fatal("cloud provider matched")
	}
	if !isComfyZImageProvider(&domain.ProviderConfig{Vendor: "ComfyUI"}, comfyZImageModel) {
		t.Fatal("local provider missing")
	}
}

func TestZImageDefaultAndRatios(t *testing.T) {
	for _, ratio := range []string{"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"} {
		o, err := zImageOptions(GenerateRequest{Model: comfyZImageModel, Prompt: "test", Size: ratio})
		if err != nil || max(o.Width, o.Height) != 768 || o.Width%16 != 0 || o.Height%16 != 0 || o.Steps != 8 || o.LoRA != "none" {
			t.Fatalf("bad defaults: %+v %v", o, err)
		}
	}
}

func TestZImageLegacyCanvasDimensions(t *testing.T) {
	for _, model := range []string{comfyZImageModel, comfyZImageV60Model} {
		for _, resolution := range []string{"1K", "1k", " 1K ", "1024px", "1024PX"} {
			for _, ratio := range []string{"auto", " AUTO ", "", "16:9"} {
				o, err := zImageOptions(GenerateRequest{Model: model, Prompt: "test", Resolution: resolution, Size: ratio})
				if err != nil {
					t.Fatalf("%s %q %q: %v", model, resolution, ratio, err)
				}
				wantHeight := 1024
				if ratio == "16:9" {
					wantHeight = 576
				}
				if o.Width != 1024 || o.Height != wantHeight {
					t.Fatalf("bad dimensions: %+v", o)
				}
			}
		}
	}
	for _, resolution := range []string{"2K", "4K", "1080p"} {
		if _, err := zImageOptions(GenerateRequest{Model: comfyZImageModel, Prompt: "test", Resolution: resolution}); err == nil {
			t.Fatalf("accepted unsupported resolution: %s", resolution)
		}
	}
}

func TestZImageReturnsFailedHistoryWithoutRetry(t *testing.T) {
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			posts.Add(1)
			ioPayload := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&ioPayload)
			_ = json.NewEncoder(w).Encode(map[string]any{"prompt_id": "test-prompt"})
			return
		}
		_, _ = w.Write([]byte(`{"test-prompt":{"status":{"status_str":"error","completed":false},"outputs":{}}}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_, err := NewService(nil, nil).generateImageComfyZImage(ctx, server.URL, GenerateRequest{Model: comfyZImageModel, Prompt: "test"})
	if err == nil || apperror.Normalize(err).Code != apperror.CodeUpstreamUnavailable {
		t.Fatalf("did not return execution failure: %v", err)
	}
	if posts.Load() != 1 {
		t.Fatalf("submitted %d times", posts.Load())
	}
}

func TestZImageTimeoutAndEmptyOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := pollComfyZImage(ctx, "http://127.0.0.1:1", "id", "Z-Image")
	if err == nil || apperror.Normalize(err).Code != apperror.CodeTimeout {
		t.Fatal("timeout not surfaced")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":{"status":{"status_str":"success","completed":true},"outputs":{}}}`))
	}))
	defer server.Close()
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := pollComfyZImage(ctx, server.URL, "id", "Z-Image"); err == nil {
		t.Fatal("empty success should fail")
	}
}
