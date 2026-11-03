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

func captureMiniMaxH3Submit(t *testing.T, req GenerateRequest) map[string]interface{} {
	t.Helper()
	var captured map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
			t.Errorf("request = %s %s, want POST /v1/videos", r.Method, r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Errorf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatalf("decode submit body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-h3","status":"completed","data":{"video_url":"https://cdn.example.com/h3.mp4"}}`))
	}))
	defer server.Close()

	req.Model = "MiniMax H3"
	svc := &Service{}
	pc := &domain.ProviderConfig{
		ServiceType:    "video",
		Vendor:         "ManjuAPI",
		APISpec:        "custom",
		SubmitEndpoint: "/v1/videos",
		QueryEndpoint:  "/v1/videos/{taskId}",
	}
	result, err := svc.generateVideo(context.Background(), pc, server.URL, "test-key", req)
	if err != nil {
		t.Fatalf("generateVideo: %v", err)
	}
	if result.Content != "https://cdn.example.com/h3.mp4" {
		t.Errorf("result URL = %q", result.Content)
	}
	return captured
}

func TestIsManjuMiniMaxH3VideoModel(t *testing.T) {
	for _, model := range []string{"MiniMax H3", "minimax h3", "  MiniMax H3  "} {
		if !isManjuMiniMaxH3VideoModel(model) {
			t.Errorf("expected %q to be recognized", model)
		}
	}
	for _, model := range []string{"MiniMax-H3", "MiniMax Hailuo", "sora2"} {
		if isManjuMiniMaxH3VideoModel(model) {
			t.Errorf("did not expect %q to be recognized", model)
		}
	}
}

func TestManjuMiniMaxH3TextToVideoBody(t *testing.T) {
	body := captureMiniMaxH3Submit(t, GenerateRequest{Prompt: "宇航员在火星山谷中前行"})

	if body["model"] != "MiniMax H3" || body["prompt"] != "宇航员在火星山谷中前行" {
		t.Errorf("identity fields = %v", body)
	}
	if body["duration"] != float64(10) || body["aspect_ratio"] != "16:9" || body["resolution"] != "2k" {
		t.Errorf("default parameters = %v", body)
	}
	if _, exists := body["input_reference"]; exists {
		t.Errorf("text-to-video payload must omit input_reference: %v", body)
	}
}

func TestManjuMiniMaxH3MultiImageBodyPreservesOrder(t *testing.T) {
	body := captureMiniMaxH3Submit(t, GenerateRequest{
		Prompt:      "让 @Image 1 中的人物穿上 @Image 2 的服装",
		Duration:    15,
		AspectRatio: "9:16",
		Resolution:  "2K",
		ReferenceImages: []string{
			"https://cdn.example.com/character.jpg",
			"data:image/png;base64,aGVsbG8=",
			"https://cdn.example.com/scene.jpg",
		},
	})

	if body["duration"] != float64(15) || body["aspect_ratio"] != "9:16" || body["resolution"] != "2k" {
		t.Errorf("explicit parameters = %v", body)
	}
	refs, ok := body["input_reference"].([]interface{})
	if !ok || len(refs) != 3 {
		t.Fatalf("input_reference = %#v", body["input_reference"])
	}
	want := []string{
		"https://cdn.example.com/character.jpg",
		"data:image/png;base64,aGVsbG8=",
		"https://cdn.example.com/scene.jpg",
	}
	for i, expected := range want {
		if refs[i] != expected {
			t.Errorf("input_reference[%d] = %v, want %q", i, refs[i], expected)
		}
	}
}

func TestManjuMiniMaxH3NormalizesStaleResolutionTo2K(t *testing.T) {
	body := captureMiniMaxH3Submit(t, GenerateRequest{
		Prompt:     "legacy node",
		Resolution: "720p",
	})

	if body["resolution"] != "2k" {
		t.Fatalf("resolution = %v, want fixed 2k", body["resolution"])
	}
}

func TestManjuMiniMaxH3RejectsInvalidParameters(t *testing.T) {
	sixRefs := make([]string, 6)
	for i := range sixRefs {
		sixRefs[i] = "https://cdn.example.com/ref.jpg"
	}
	cases := []struct {
		name string
		req  GenerateRequest
		want string
	}{
		{name: "empty prompt", req: GenerateRequest{}, want: "prompt is required"},
		{name: "one reference", req: GenerateRequest{Prompt: "x", ReferenceImages: []string{"https://cdn.example.com/one.jpg"}}, want: "2 to 5"},
		{name: "six references", req: GenerateRequest{Prompt: "x", ReferenceImages: sixRefs}, want: "2 to 5"},
		{name: "invalid duration", req: GenerateRequest{Prompt: "x", Duration: 12}, want: "10 or 15"},
		{name: "invalid ratio", req: GenerateRequest{Prompt: "x", AspectRatio: "2:1"}, want: "aspect ratio"},
		{name: "empty reference", req: GenerateRequest{Prompt: "x", ReferenceImages: []string{"", "https://cdn.example.com/b.jpg"}}, want: "cannot be empty"},
		{name: "invalid reference scheme", req: GenerateRequest{Prompt: "x", ReferenceImages: []string{"ftp://example.com/a.jpg", "https://cdn.example.com/b.jpg"}}, want: "public http(s) URL"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &Service{}
			_, err := svc.generateVideoManjuMiniMaxH3(context.Background(), &domain.ProviderConfig{ServiceType: "video"}, "http://unused", "key", tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}
