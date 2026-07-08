package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

// apimart.ai GPT-Image-2 适配测试(docs.apimart.ai)：
// POST /images/generations(size=比例/resolution=档位/image_urls 同端点图生图)
// → data[0].task_id → GET /tasks/{id} → result.images[0].url[0]。

// fastImagePoll shrinks the package-level poll pacing for the duration of a
// test so the submit→poll roundtrip completes in milliseconds.
func fastImagePoll(t *testing.T) {
	t.Helper()
	origDelay, origInterval := imageTaskPollInitialDelay, imageTaskPollInterval
	imageTaskPollInitialDelay, imageTaskPollInterval = 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() {
		imageTaskPollInitialDelay, imageTaskPollInterval = origDelay, origInterval
	})
}

func TestIsApimartBaseURL(t *testing.T) {
	if !isApimartBaseURL("https://api.apimart.ai/v1") {
		t.Error("apimart host not sniffed")
	}
	if isApimartBaseURL("https://manjuapi.com/v1") || isApimartBaseURL("https://api.openai.com/v1") {
		t.Error("non-apimart host misrouted")
	}
}

func TestApimartSubmitPollRoundtrip(t *testing.T) {
	fastImagePoll(t)
	var submitted map[string]interface{}
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/images/generations":
			if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
				t.Errorf("Authorization = %q", auth)
			}
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			// 文档形态:task_id 埋在 data[0]。
			_, _ = w.Write([]byte(`{"code":200,"data":[{"status":"submitted","task_id":"task_01KPQ7J7DWB7QZ3WCEK3YVPBRA"}]}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/tasks/"):
			if r.URL.Path != "/tasks/task_01KPQ7J7DWB7QZ3WCEK3YVPBRA" {
				t.Errorf("poll path = %q", r.URL.Path)
			}
			polls++
			if polls == 1 { // 第一轮还在处理
				_, _ = w.Write([]byte(`{"code":200,"data":{"id":"task_01KPQ7J7DWB7QZ3WCEK3YVPBRA","status":"processing","progress":40}}`))
				return
			}
			// 完成:图在 result.images[0].url[0](url 是数组)。
			_, _ = w.Write([]byte(`{"code":200,"data":{"id":"task_01KPQ7J7DWB7QZ3WCEK3YVPBRA","status":"completed","progress":100,"result":{"images":[{"url":["https://upload.apimart.ai/f/image/x_0.png"],"expires_at":1776835126}]}}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	svc := &Service{}
	pc := &domain.ProviderConfig{ServiceType: "image"}
	result, err := svc.generateImageApimart(context.Background(), pc, server.URL, "test-key", GenerateRequest{
		Model:           "gpt-image-2",
		Prompt:          "一只橘猫坐在窗台上看夕阳",
		Size:            "16:9",
		Resolution:      "2K", // 大写进 — 必须小写出
		OutputCount:     2,
		ReferenceImages: []string{"https://oss.example.com/ref.png", "data:image/png;base64,iVBORw0"},
	})
	if err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if result.Content != "https://upload.apimart.ai/f/image/x_0.png" {
		t.Errorf("result = %q", result.Content)
	}
	if polls < 2 {
		t.Errorf("expected >=2 polls, got %d", polls)
	}
	// 提交 body 逐字段断言。
	if submitted["model"] != "gpt-image-2" || submitted["prompt"] != "一只橘猫坐在窗台上看夕阳" {
		t.Errorf("model/prompt wrong: %v", submitted)
	}
	if submitted["size"] != "16:9" {
		t.Errorf("size = %v", submitted["size"])
	}
	if submitted["resolution"] != "2k" {
		t.Errorf("resolution = %v (must be lowercased)", submitted["resolution"])
	}
	if n, ok := submitted["n"].(float64); !ok || n != 2 {
		t.Errorf("n = %v (must be a bare number)", submitted["n"])
	}
	urls, ok := submitted["image_urls"].([]interface{})
	if !ok || len(urls) != 2 || urls[0] != "https://oss.example.com/ref.png" || urls[1] != "data:image/png;base64,iVBORw0" {
		t.Errorf("image_urls = %v", submitted["image_urls"])
	}
}

func TestApimartRejectsNonPublicReference(t *testing.T) {
	svc := &Service{}
	pc := &domain.ProviderConfig{ServiceType: "image"}
	_, err := svc.generateImageApimart(context.Background(), pc, "http://unused", "k", GenerateRequest{
		Model:           "gpt-image-2",
		Prompt:          "x",
		ReferenceImages: []string{"/uploads/local.png"},
	})
	if err == nil || !strings.Contains(err.Error(), "public http(s)") {
		t.Errorf("expected public-url validation error, got %v", err)
	}
}

// extractImageTaskID 的既有语义不能回归:顶层 task_id / chatcmpl -img- 仍优先,
// 递归 data[0].task_id 只作兜底。
func TestExtractImageTaskIDShapes(t *testing.T) {
	cases := []struct {
		body string
		want string
	}{
		{`{"task_id":"top-level"}`, "top-level"},
		{`{"id":"chatcmpl-gemini-img-abc"}`, "gemini-img-abc"},
		{`{"code":200,"data":[{"status":"submitted","task_id":"task_01K"}]}`, "task_01K"},
		{`{"id":"chatcmpl-plain-text-reply"}`, ""}, // 普通聊天回复不能被当任务
		{`{"choices":[{"message":{"content":"hi"}}]}`, ""},
	}
	for _, c := range cases {
		if got := extractImageTaskID([]byte(c.body)); got != c.want {
			t.Errorf("extractImageTaskID(%s) = %q, want %q", c.body, got, c.want)
		}
	}
}
