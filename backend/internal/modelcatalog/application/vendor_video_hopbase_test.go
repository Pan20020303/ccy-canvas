package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestGenerateVideoHopBaseRoundtrip(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")

	var pngBytes bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 320, 320))
	for y := 0; y < 320; y++ {
		for x := 0; x < 320; x++ {
			img.Set(x, y, color.RGBA{R: 240, G: 80, B: 20, A: 255})
		}
	}
	if err := png.Encode(&pngBytes, img); err != nil {
		t.Fatal(err)
	}

	var submitted map[string]any
	polls := 0
	assetCreates := 0
	assetPolls := map[string]int{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/ref.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes.Bytes())
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sd/assets":
			assetCreates++
			if auth := r.Header.Get("Authorization"); auth != "Bearer hop-key" {
				t.Errorf("asset Authorization = %q", auth)
			}
			var assetBody map[string]any
			if err := json.NewDecoder(r.Body).Decode(&assetBody); err != nil {
				t.Fatalf("decode asset: %v", err)
			}
			if assetBody["AssetType"] != "Image" || assetBody["URL"] != server.URL+"/ref.png" {
				t.Errorf("asset body = %#v", assetBody)
			}
			_, _ = w.Write([]byte(`{"data":{"Id":"asset-` + fmt.Sprint(assetCreates) + `","Status":null}}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/sd/assets/asset-"):
			assetID := strings.TrimPrefix(r.URL.Path, "/v1/sd/assets/")
			assetPolls[assetID]++
			status := "Pending"
			if assetPolls[assetID] > 1 {
				status = "Active"
			}
			_, _ = w.Write([]byte(`{"data":{"Id":"` + assetID + `","Status":"` + status + `"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/video/generate":
			if auth := r.Header.Get("Authorization"); auth != "Bearer hop-key" {
				t.Errorf("Authorization = %q", auth)
			}
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			_, _ = w.Write([]byte(`{"task":{"id":"vt_test","status":"pending"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/video/tasks/vt_test":
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"task":{"id":"vt_test","status":"processing"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"task":{"id":"vt_test","status":"completed"},"outputs":[{"url":"https://cdn.hop-base.com/video.mp4"}]}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	ref := server.URL + "/ref.png"
	svc := &Service{}
	result, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{Vendor: "HopBase", ServiceType: "video"}, server.URL, "hop-key", GenerateRequest{
		Model:           "dreamina-seedance-2-5-260628",
		Prompt:          "让第一张图自然过渡到第二张图",
		Duration:        6,
		Resolution:      "720p",
		AspectRatio:     "16:9",
		ReferenceMode:   "start_end",
		ReferenceImages: []string{ref, ref},
	})
	if err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if result.Content != "https://cdn.hop-base.com/video.mp4" {
		t.Fatalf("result = %q", result.Content)
	}
	if submitted["model"] != "dreamina-seedance-2-5-260628" || submitted["resolution"] != "720p" {
		t.Errorf("model/resolution = %v", submitted)
	}
	if submitted["ratio"] != "adaptive" {
		t.Errorf("frame mode ratio = %v, want adaptive", submitted["ratio"])
	}
	if submitted["return_last_frame"] != true || submitted["generate_audio"] != true || submitted["watermark"] != false {
		t.Errorf("2.5 defaults = %v", submitted)
	}
	content, ok := submitted["content"].([]any)
	if !ok || len(content) != 3 {
		t.Fatalf("content = %#v", submitted["content"])
	}
	first := content[1].(map[string]any)
	last := content[2].(map[string]any)
	if first["role"] != "first_frame" || last["role"] != "last_frame" {
		t.Errorf("roles = %v, %v", first["role"], last["role"])
	}
	firstURL := first["image_url"].(map[string]any)["url"]
	lastURL := last["image_url"].(map[string]any)["url"]
	if firstURL != "asset://asset-1" || lastURL != "asset://asset-2" {
		t.Errorf("asset urls = %v, %v", firstURL, lastURL)
	}
	if assetCreates != 2 {
		t.Errorf("asset creates = %d, want exactly one per reference image", assetCreates)
	}
}

func TestGenerateVideoHopBaseRejectsUnsupportedResolution(t *testing.T) {
	svc := &Service{}
	_, err := svc.generateVideoHopBase(context.Background(), &domain.ProviderConfig{}, "https://api.hop-base.com", "key", GenerateRequest{
		Model: "dreamina-seedance-2-5-260628", Prompt: "test", Resolution: "4k", Duration: 5,
	})
	if err == nil {
		t.Fatal("expected 2.5 4k validation error")
	}
}

func TestHopBaseModelCapabilities(t *testing.T) {
	standard, ok := hopBaseSeedanceCapabilitiesFor("dreamina-seedance-2-0-260128")
	if !ok {
		t.Fatal("2.0 standard model not recognized")
	}
	if _, ok := standard.resolutions["4k"]; !ok {
		t.Fatal("2.0 overseas standard should support 4k")
	}
	fast, ok := hopBaseSeedanceCapabilitiesFor("dreamina-seedance-2-0-fast-260128")
	if !ok {
		t.Fatal("2.0 fast model not recognized")
	}
	if _, ok := fast.resolutions["4k"]; ok {
		t.Fatal("2.0 fast must not support 4k")
	}
}
