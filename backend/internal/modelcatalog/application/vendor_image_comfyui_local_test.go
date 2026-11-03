package application

import (
	"bytes"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalImageGraphs(t *testing.T) {
	for _, model := range []string{comfyKlein4B, comfyKlein9B, comfyKrea2} {
		o, err := localImageOptions(GenerateRequest{Model: model, Prompt: "a bookstore", Resolution: "1K", Size: "auto"})
		if err != nil {
			t.Fatal(err)
		}
		g := buildComfyLocalImagePrompt("a bookstore", o, nil)
		if o.Width != 1024 || o.Height != 1024 {
			t.Fatal("legacy dimensions broken")
		}
		if g["11"].(map[string]any)["class_type"] != "SaveImage" {
			t.Fatal("missing output")
		}
		if model == comfyKrea2 {
			if o.Steps != 8 || o.CFG != 1 {
				t.Fatal("bad krea defaults")
			}
			o.LoRA = "darkbrush"
			if _, ok := buildComfyLocalImagePrompt("test", o, nil)["7"]; !ok {
				t.Fatal("lora missing")
			}
			continue
		}
		for n := 0; n <= 4; n++ {
			refs := []string{"a.png", "b.png", "c.png", "d.png"}[:n]
			g = buildComfyLocalImagePrompt("test", o, refs)
			count := 0
			for _, node := range g {
				if node.(map[string]any)["class_type"] == "ReferenceLatent" {
					count++
				}
			}
			if count != 2*n {
				t.Fatal("each reference must condition both CFG branches")
			}
		}
	}
}

func TestLocalImageValidation(t *testing.T) {
	cases := []GenerateRequest{
		{Model: comfyKlein4B, ReferenceImages: []string{"1", "2", "3", "4", "5"}},
		{Model: comfyKrea2, ReferenceImages: []string{"1"}},
		{Model: comfyKlein4B, Parameters: map[string]any{"steps": 4}},
		{Model: comfyKlein9B, Parameters: map[string]any{"lora": "pixel-art"}},
		{Model: comfyKrea2, Parameters: map[string]any{"cfg": 5}},
		{Model: comfyKrea2, Parameters: map[string]any{"lora_strength": 2}},
		{Model: comfyKlein4B, OutputCount: 4},
	}
	for _, req := range cases {
		req.Prompt = "test"
		if _, err := localImageOptions(req); err == nil {
			t.Fatalf("accepted unsupported request: %+v", req)
		}
	}
}

func TestLocalImageProviderDispatch(t *testing.T) {
	for _, model := range []string{comfyKlein4B, comfyKlein9B, comfyKrea2} {
		t.Run(model, func(t *testing.T) {
			posts := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/prompt" && r.Method == http.MethodPost {
					posts++
					var body struct {
						Prompt map[string]any `json:"prompt"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || body.Prompt["11"] == nil {
						t.Error("not a ComfyUI graph")
					}
					_, _ = w.Write([]byte(`{"prompt_id":"local-id"}`))
					return
				}
				if r.URL.Path != "/history/local-id" {
					t.Errorf("unexpected cloud route: %s", r.URL.Path)
				}
				_, _ = w.Write([]byte(`{"local-id":{"status":{"status_str":"error","completed":false},"outputs":{}}}`))
			}))
			defer server.Close()
			cfg := &domain.ProviderConfig{Vendor: "ComfyUI", ServiceType: "image"}
			if !isComfyLocalImageProvider(cfg, model) || isComfyLocalImageProvider(&domain.ProviderConfig{Vendor: "OpenAI"}, model) {
				t.Fatal("provider detection broken")
			}
			_, err := NewService(nil, nil).dispatchToVendor(context.Background(), candidateChannel{cfg: cfg, baseURL: server.URL}, GenerateRequest{Model: model, ServiceType: "image", Prompt: "test"})
			if err == nil || posts != 1 {
				t.Fatal("must surface one failed attempt without resubmission")
			}
		})
	}
}

// Explicit opt-in exports exact backend graphs for ComfyUI workflow packaging.
func TestExportLocalImageWorkflows(t *testing.T) {
	dir := os.Getenv("CCY_EXPORT_COMFY_WORKFLOWS")
	if dir == "" {
		t.Skip("manual export only")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{comfyKlein4B, comfyKlein9B, comfyKrea2} {
		o, _ := localImageOptions(GenerateRequest{Model: model, Prompt: "A cozy bookstore on a rainy street, warm window lights", Resolution: "768px"})
		o.Seed = 123456
		variants := map[string][]string{"t2i": nil}
		if model != comfyKrea2 {
			for n := 1; n <= 4; n++ {
				variants[fmt.Sprintf("%dref", n)] = []string{"reference_1.png", "reference_2.png", "reference_3.png", "reference_4.png"}[:n]
			}
		} else {
			o.LoRA = "darkbrush"
		}
		for name, refs := range variants {
			body, _ := json.MarshalIndent(buildComfyLocalImagePrompt("A cozy bookstore on a rainy street, warm window lights", o, refs), "", "  ")
			if err := os.WriteFile(filepath.Join(dir, "CCY_"+model+"_"+name+"_API.json"), body, 0644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestLocalImageUploadsUseUniqueNames(t *testing.T) {
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 16, 16))); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, header, err := r.FormFile("image")
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		defer f.Close()
		if seen[header.Filename] {
			t.Error("duplicate upload filename")
		}
		seen[header.Filename] = true
		if r.FormValue("overwrite") == "true" {
			t.Error("must not overwrite inputs")
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"name": header.Filename, "subfolder": ""})
	}))
	defer server.Close()
	raw := "data:image/png;base64," + base64.StdEncoding.EncodeToString(picture.Bytes())
	for i := 0; i < 4; i++ {
		if _, err := uploadLocalImageReference(context.Background(), server.URL, raw, i); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 4 {
		t.Fatal("missing uploads")
	}
	if _, err := uploadLocalImageReference(context.Background(), server.URL, "data:image/png;base64,YmFk", 0); err == nil {
		t.Fatal("invalid image accepted")
	}
}

// Explicit opt-in live test; does not submit jobs during normal unit tests.
func TestManualLocalImageGeneration(t *testing.T) {
	model := os.Getenv("CCY_LIVE_COMFY_MODEL")
	if model == "" {
		t.Skip("manual GPU test only")
	}
	req := GenerateRequest{Model: model, Prompt: "A cozy bookstore on a rainy street, warm window lights, potted plants, realistic photograph", Resolution: "512px", Size: "1:1"}
	if model == comfyKrea2 {
		req.Parameters = map[string]any{"lora": "darkbrush", "lora_strength": 1.0}
	}
	if refDir := os.Getenv("CCY_LIVE_COMFY_REFS"); refDir != "" {
		for _, name := range []string{"ZImage_Turbo_00001_.png", "ZImage_Turbo_00002_.png", "ZImage_Turbo_00003_.png", "ZImage_Turbo_00004_.png"} {
			data, err := os.ReadFile(filepath.Join(refDir, name))
			if err != nil {
				t.Fatal(err)
			}
			req.ReferenceImages = append(req.ReferenceImages, "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data))
		}
		req.Prompt = "Create a new bookstore design inspired by the four reference images, with a green storefront, warm lights and plants."
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	started := time.Now()
	result, err := NewService(nil, nil).generateImageComfyLocal(ctx, "http://127.0.0.1:8188", req)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(uploadRoot(), filepath.FromSlash(strings.TrimPrefix(result.Content, "/uploads/")))
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	config, _, err := image.DecodeConfig(file)
	if err != nil || config.Width != 512 || config.Height != 512 {
		t.Fatalf("invalid output %v %v", config, err)
	}
	t.Logf("LIVE PASS model=%s refs=%d elapsed=%s output=%s", model, len(req.ReferenceImages), time.Since(started), path)
}
