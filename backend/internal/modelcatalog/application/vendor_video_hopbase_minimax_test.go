package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestHopBaseMiniMaxH3RoundtripUsesRootTaskID(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	var submitted map[string]any
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == hopBaseVideoSubmitPath:
			if auth := r.Header.Get("Authorization"); auth != "Bearer hop-key" {
				t.Errorf("Authorization = %q", auth)
			}
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"id":"mmt_test","object":"video.generation.task","status":"queued"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/video/tasks/mmt_test":
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"id":"mmt_test","status":"processing"}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"mmt_test","status":"completed","outputs":["https://cdn.example.com/h3.mp4"]}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	result, err := (&Service{}).generateVideo(context.Background(), &domain.ProviderConfig{Vendor: "HopBase", ServiceType: "video"}, server.URL, "hop-key", GenerateRequest{
		Model: "MiniMax-H3", Prompt: "清晨雪山航拍", Resolution: "2k", Duration: 4, AspectRatio: "16:9",
	})
	if err != nil {
		t.Fatalf("generateVideo: %v", err)
	}
	if result.Content != "https://cdn.example.com/h3.mp4" || polls != 2 {
		t.Fatalf("result=%#v polls=%d", result, polls)
	}
	if submitted["model"] != "MiniMax-H3" || submitted["resolution"] != "2K" || submitted["duration"] != float64(4) || submitted["ratio"] != "16:9" {
		t.Fatalf("submitted = %#v", submitted)
	}
	content := submitted["content"].([]any)
	if len(content) != 1 || content[0].(map[string]any)["text"] != "清晨雪山航拍" {
		t.Fatalf("content = %#v", content)
	}
}

func TestBuildHopBaseMiniMaxH3MultimodalContent(t *testing.T) {
	body, err := buildHopBaseMiniMaxH3Body(context.Background(), GenerateRequest{
		Model: "MiniMax-H3", Prompt: "按参考动作完成镜头", Resolution: "768P", Duration: 8,
		ReferenceMode:   "image_reference",
		ReferenceImages: []string{"data:image/png;base64,aW1hZ2U="},
		ReferenceVideos: []string{"data:video/mp4;base64,dmlkZW8="},
		ReferenceAudios: []string{"data:audio/wav;base64,YXVkaW8="},
		Parameters:      map[string]any{"aigc_watermark": true},
	})
	if err != nil {
		t.Fatalf("build body: %v", err)
	}
	if body["ratio"] != "adaptive" || body["aigc_watermark"] != true {
		t.Fatalf("options = %#v", body)
	}
	content := body["content"].([]map[string]any)
	if len(content) != 4 || content[1]["role"] != "reference_image" || content[2]["role"] != "reference_video" || content[3]["role"] != "reference_audio" {
		t.Fatalf("content = %#v", content)
	}
}

func TestBuildHopBaseMiniMaxH3FramesForceAdaptive(t *testing.T) {
	body, err := buildHopBaseMiniMaxH3Body(context.Background(), GenerateRequest{
		Model: "MiniMax-H3-Max", Prompt: "从日出过渡到夜景", Resolution: "480p", Duration: 5,
		AspectRatio: "16:9", ReferenceMode: "start_end",
		ReferenceImages: []string{"data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,bGFzdA=="},
	})
	if err != nil {
		t.Fatalf("build body: %v", err)
	}
	if body["resolution"] != "480P" || body["ratio"] != "adaptive" {
		t.Fatalf("options = %#v", body)
	}
	content := body["content"].([]map[string]any)
	if content[1]["role"] != "first_frame" || content[2]["role"] != "last_frame" {
		t.Fatalf("frame roles = %#v", content)
	}
}

func TestHopBaseMiniMaxH3Validation(t *testing.T) {
	images := make([]string, 10)
	for index := range images {
		images[index] = "data:image/png;base64,aW1hZ2U="
	}
	cases := []struct {
		name string
		req  GenerateRequest
		want string
	}{
		{"exact model", GenerateRequest{Model: "minimax-h3", Prompt: "x"}, "精确型号"},
		{"empty prompt", GenerateRequest{Model: "MiniMax-H3"}, "1–7000"},
		{"bad duration", GenerateRequest{Model: "MiniMax-H3", Prompt: "x", Duration: 16}, "4–15"},
		{"bad resolution", GenerateRequest{Model: "MiniMax-H3-Max", Prompt: "x", Resolution: "2K"}, "不支持分辨率"},
		{"max multimodal", GenerateRequest{Model: "MiniMax-H3-Max", Prompt: "x", ReferenceMode: "image_reference", ReferenceImages: []string{"data:image/png;base64,eA=="}}, "仅支持文生视频或首帧"},
		{"too many images", GenerateRequest{Model: "MiniMax-H3", Prompt: "x", ReferenceMode: "image_reference", ReferenceImages: images}, "最多支持 9"},
		{"audio only", GenerateRequest{Model: "MiniMax-H3", Prompt: "x", ReferenceMode: "image_reference", ReferenceAudios: []string{"data:audio/wav;base64,eA=="}}, "必须同时提供图片或视频"},
		{"selfhost inline video", GenerateRequest{Model: "MiniMax-H3-SelfHosted", Prompt: "x", ReferenceMode: "image_reference", ReferenceImages: []string{"data:image/png;base64,eA=="}, ReferenceVideos: []string{"data:video/mp4;base64,eA=="}}, "必须使用公网"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateHopBaseMiniMaxRequest(tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestBuildHopBaseMiniMaxH3NormalizesAdaptiveTextRatio(t *testing.T) {
	body, err := buildHopBaseMiniMaxH3Body(context.Background(), GenerateRequest{
		Model: "MiniMax-H3", Prompt: "text only", AspectRatio: "adaptive",
	})
	if err != nil {
		t.Fatalf("build body: %v", err)
	}
	if body["ratio"] != "16:9" {
		t.Fatalf("ratio = %v, want 16:9", body["ratio"])
	}
}

func TestHopBaseTaskIDReadsMiniMaxRootID(t *testing.T) {
	if got := hopBaseTaskID(map[string]any{"id": "mmt123", "status": "queued"}); got != "mmt123" {
		t.Fatalf("task id = %q", got)
	}
}
