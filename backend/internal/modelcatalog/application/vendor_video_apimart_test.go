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

// apimart.ai 视频适配测试(docs.apimart.ai)：
// POST /videos/generations(model+prompt+duration+aspect_ratio+resolution+image_urls)
// → data[0].task_id → GET /tasks/{id} → data.result.videos[0].url。

// fastVideoPoll shrinks the package-level video poll pacing so the submit→poll
// roundtrip completes in milliseconds instead of the production 8s+6s.
func fastVideoPoll(t *testing.T) {
	t.Helper()
	origDelay, origInterval := videoPollInitialDelayDuration, videoPollIntervalDuration
	videoPollInitialDelayDuration, videoPollIntervalDuration = 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() {
		videoPollInitialDelayDuration, videoPollIntervalDuration = origDelay, origInterval
	})
}

func TestGenerateVideoApimartRoundtrip(t *testing.T) {
	fastVideoPoll(t)
	// submit + poll both dial via safehttp, which blocks loopback by default;
	// httptest serves from 127.0.0.1, so open the documented test escape hatch.
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")

	var submitted map[string]interface{}
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/videos/generations":
			if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
				t.Errorf("Authorization = %q", auth)
			}
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Fatalf("decode submit: %v", err)
			}
			// 文档形态：task_id 埋在 data[0]。
			_, _ = w.Write([]byte(`{"code":200,"data":[{"status":"submitted","task_id":"task_VID01"}]}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/tasks/"):
			if r.URL.Path != "/tasks/task_VID01" {
				t.Errorf("poll path = %q", r.URL.Path)
			}
			polls++
			if polls == 1 { // 第一轮还在处理
				_, _ = w.Write([]byte(`{"code":200,"data":{"id":"task_VID01","status":"processing","progress":30}}`))
				return
			}
			// 完成：视频在 data.result.videos[0].url。
			_, _ = w.Write([]byte(`{"code":200,"data":{"id":"task_VID01","status":"completed","progress":100,"result":{"videos":[{"url":"https://upload.apimart.ai/f/video/x_0.mp4"}]}}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	svc := &Service{}
	pc := &domain.ProviderConfig{ServiceType: "video"}
	result, err := svc.generateVideoApimart(context.Background(), pc, server.URL, "test-key", GenerateRequest{
		Model:           "veo3.1-fast",
		Prompt:          "海豚跃出蔚蓝海面",
		AspectRatio:     "16:9",
		Resolution:      "720p",
		Duration:        8,
		ReferenceImages: []string{"https://oss.example.com/frame.png", "data:image/png;base64,iVBORw0"},
	})
	if err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if result.Content != "https://upload.apimart.ai/f/video/x_0.mp4" {
		t.Errorf("result = %q", result.Content)
	}
	if polls < 2 {
		t.Errorf("expected >=2 polls, got %d", polls)
	}
	// 提交 body 逐字段断言。
	if submitted["model"] != "veo3.1-fast" || submitted["prompt"] != "海豚跃出蔚蓝海面" {
		t.Errorf("model/prompt wrong: %v", submitted)
	}
	if submitted["aspect_ratio"] != "16:9" {
		t.Errorf("aspect_ratio = %v", submitted["aspect_ratio"])
	}
	if submitted["resolution"] != "720p" {
		t.Errorf("resolution = %v", submitted["resolution"])
	}
	if d, ok := submitted["duration"].(float64); !ok || d != 8 {
		t.Errorf("duration = %v (must be a bare number)", submitted["duration"])
	}
	urls, ok := submitted["image_urls"].([]interface{})
	if !ok || len(urls) != 2 || urls[0] != "https://oss.example.com/frame.png" || urls[1] != "data:image/png;base64,iVBORw0" {
		t.Errorf("image_urls = %v", submitted["image_urls"])
	}
}

// extractApimartVideoURL 只在拿到成片 URL 时返回；提交响应(data 是数组、无 result)
// 必须返回空，否则会把「还没出片」误判为完成。
func TestExtractApimartVideoURL(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			"completed nested videos[].url",
			`{"code":200,"data":{"status":"completed","result":{"videos":[{"url":"https://cdn/x.mp4"}]}}}`,
			"https://cdn/x.mp4",
		},
		{
			"url as array element",
			`{"data":{"result":{"videos":[{"url":["https://cdn/y.mp4"]}]}}}`,
			"https://cdn/y.mp4",
		},
		{
			"flat video_url fallback",
			`{"status":"succeeded","video_url":"https://cdn/z.mp4"}`,
			"https://cdn/z.mp4",
		},
		{
			"submit response (array, no result) — still running",
			`{"code":200,"data":[{"status":"submitted","task_id":"task_VID01"}]}`,
			"",
		},
		{
			"processing — no url yet",
			`{"code":200,"data":{"status":"processing","progress":40}}`,
			"",
		},
	}
	for _, c := range cases {
		if got := extractApimartVideoURL([]byte(c.body)); got != c.want {
			t.Errorf("%s: extractApimartVideoURL = %q, want %q", c.name, got, c.want)
		}
	}
}

// apimartTaskFailed 必须能读到 apimart 嵌套在 data 里的失败状态(而非只看顶层)。
func TestApimartTaskFailed(t *testing.T) {
	cases := []struct {
		body string
		want bool
	}{
		{`{"code":200,"data":{"status":"failed"}}`, true},
		{`{"code":200,"data":{"status":"error"}}`, true},
		{`{"status":"cancelled"}`, true},
		{`{"code":200,"data":{"status":"processing"}}`, false},
		{`{"code":200,"data":{"status":"completed"}}`, false},
	}
	for _, c := range cases {
		if got := apimartTaskFailed([]byte(c.body)); got != c.want {
			t.Errorf("apimartTaskFailed(%s) = %v, want %v", c.body, got, c.want)
		}
	}
}
