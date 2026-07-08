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

// Manju 中转站(manjuapi.com)chat/completions 视频路径的适配测试:
// 模型名嗅探路由 + 三家请求体形态 + 任务提交/轮询回路。

func TestIsManjuChatVideoModel(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"sora2", true},
		{"SORA2", true},
		{"Veo 3.1 Fast 1080p", true},
		{"veo 3.1 fast 1080p", true},
		{"grok-imagine-video", true},
		{"grok-imagine", true},
		// 标准 /videos 家族不能被劫持:
		{"sora-2", false},
		{"sora-v3-fast", false},
		{"veo-3", false},   // 无空格 → 非中转站命名
		{"grok-1.5", false},
		{"kling/kling-v3-video-generation", false},
	}
	for _, c := range cases {
		if got := isManjuChatVideoModel(c.model); got != c.want {
			t.Errorf("isManjuChatVideoModel(%q) = %v, want %v", c.model, got, c.want)
		}
	}
}

// captureManjuSubmit spins a fake relay that records the submit body and
// returns a SYNC video_url (exercising the sync fast-path so tests stay fast).
func captureManjuSubmit(t *testing.T, model string, req GenerateRequest) map[string]interface{} {
	t.Helper()
	var captured map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("submit path = %q, want /chat/completions", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Errorf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatalf("decode submit body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-abc","status":"completed","data":{"video_url":"https://cdn.example.com/out.mp4"}}`))
	}))
	defer server.Close()

	svc := &Service{}
	req.Model = model
	pc := &domain.ProviderConfig{ServiceType: "video"}
	result, err := svc.generateVideoChatCompletions(context.Background(), pc, server.URL, "test-key", req)
	if err != nil {
		t.Fatalf("generateVideoChatCompletions: %v", err)
	}
	if result.Content != "https://cdn.example.com/out.mp4" {
		t.Errorf("result url = %q", result.Content)
	}
	return captured
}

func TestManjuSora2BodyShape(t *testing.T) {
	body := captureManjuSubmit(t, "sora2", GenerateRequest{
		Prompt:          "一只柯基在海边冲浪",
		Duration:        8,
		AspectRatio:     "16:9",
		ReferenceImages: []string{"https://cos.example.com/ref.png"},
	})
	if body["sora2_duration"] != "8" || body["sora2_ratio"] != "16:9" {
		t.Errorf("sora2 params wrong: %v", body)
	}
	if body["input_reference"] != "https://cos.example.com/ref.png" {
		t.Errorf("sora2 input_reference = %v", body["input_reference"])
	}
	msgs, ok := body["messages"].([]interface{})
	if !ok || len(msgs) != 1 {
		t.Fatalf("sora2 messages = %v", body["messages"])
	}
	first := msgs[0].(map[string]interface{})
	if first["content"] != "一只柯基在海边冲浪" {
		t.Errorf("sora2 prompt in messages = %v", first["content"])
	}
	if _, hasPrompt := body["prompt"]; hasPrompt {
		t.Error("sora2 must NOT carry root-level prompt")
	}
}

func TestManjuVeoBodyShape(t *testing.T) {
	body := captureManjuSubmit(t, "Veo 3.1 Fast 1080p", GenerateRequest{
		Prompt:          "主体缓慢靠近镜头",
		Duration:        8,
		AspectRatio:     "16:9",
		ReferenceImages: []string{"https://cos.example.com/ref.png"},
	})
	if body["prompt"] != "主体缓慢靠近镜头" || body["duration"] != "8" || body["aspect_ratio"] != "16:9" {
		t.Errorf("veo params wrong: %v", body)
	}
	if body["input_reference"] != "https://cos.example.com/ref.png" {
		t.Errorf("veo input_reference = %v", body["input_reference"])
	}
	if _, hasMsgs := body["messages"]; hasMsgs {
		t.Error("veo must NOT carry messages")
	}
}

func TestManjuGrokBodyShape(t *testing.T) {
	body := captureManjuSubmit(t, "grok-imagine-video", GenerateRequest{
		Prompt:          "人物自然转身",
		Duration:        9, // 非法值 → 应取最接近的 10
		AspectRatio:     "9:16",
		ReferenceImages: []string{"https://cos.example.com/ref.png"},
	})
	if body["prompt"] != "人物自然转身" || body["duration"] != "10" || body["aspect_ratio"] != "9:16" {
		t.Errorf("grok params wrong: %v", body)
	}
	if body["resolution"] != "720p" {
		t.Errorf("grok resolution = %v", body["resolution"])
	}
	// grok 用 image_url,不是 input_reference。
	if body["image_url"] != "https://cos.example.com/ref.png" {
		t.Errorf("grok image_url = %v", body["image_url"])
	}
	if _, has := body["input_reference"]; has {
		t.Error("grok must NOT carry input_reference")
	}
}

func TestManjuRejectsNonPublicReference(t *testing.T) {
	svc := &Service{}
	pc := &domain.ProviderConfig{ServiceType: "video"}
	_, err := svc.generateVideoChatCompletions(context.Background(), pc, "http://unused", "k", GenerateRequest{
		Model:           "sora2",
		Prompt:          "x",
		ReferenceImages: []string{"/uploads/local.png"},
	})
	if err == nil || !strings.Contains(err.Error(), "public http(s)") {
		t.Errorf("expected public-url validation error, got %v", err)
	}
}

// 任务式提交 → GET /videos/{id} 轮询(succeeded + data.video_url 词表)。
// 轮询首延迟 8s,该测试约 8 秒 — 保持覆盖,别删。
func TestManjuTaskPollRoundtrip(t *testing.T) {
	if testing.Short() {
		t.Skip("poll delay 8s; skipped in -short")
	}
	polled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/chat/completions" {
			_, _ = w.Write([]byte(`{"id":"sora2-fb22482c0bde","status":"running","progress":0}`))
			return
		}
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/videos/") {
			if r.URL.Path != "/videos/sora2-fb22482c0bde" {
				t.Errorf("poll path = %q", r.URL.Path)
			}
			polled = true
			_, _ = w.Write([]byte(`{"id":"sora2-fb22482c0bde","status":"succeeded","data":{"video_url":"https://cdn.example.com/done.mp4"}}`))
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()

	svc := &Service{}
	pc := &domain.ProviderConfig{ServiceType: "video"}
	result, err := svc.generateVideoChatCompletions(context.Background(), pc, server.URL, "k", GenerateRequest{
		Model:    "sora2",
		Prompt:   "x",
		Duration: 8,
	})
	if err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if !polled {
		t.Error("poll endpoint was never hit")
	}
	if result.Content != "https://cdn.example.com/done.mp4" {
		t.Errorf("result = %q", result.Content)
	}
}
