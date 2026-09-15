package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestGenerateVideoArkSeedance25ReferenceContract(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	var submitted map[string]any
	var polls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/reference.png":
			// Ark reference normalization can fall back to a public URL when
			// metadata is unavailable. All network traffic stays in this server.
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v3/contents/generations/tasks":
			if r.Header.Get("Authorization") != "Bearer ark-test-key" || r.Header.Get("Content-Type") != "application/json" {
				t.Error("missing Ark auth or content-type header")
			}
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Errorf("decode request: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"id":"seedance25-task"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v3/contents/generations/tasks/seedance25-task":
			if r.Header.Get("Authorization") != "Bearer ark-test-key" {
				t.Error("missing poll authorization")
			}
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"status":"running"}`))
			} else {
				_, _ = w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/result.mov"}}`))
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	videos := make([]string, 6)
	for i := range videos {
		videos[i] = server.URL + fmt.Sprintf("/reference%d.mp4", i+1)
	}
	req := GenerateRequest{
		ServiceType: "video", Model: "doubao-seedance-2-5-260628",
		Prompt:          "明亮多彩的饼干广告，参考@图像1与@视频1至@视频6。",
		ReferenceImages: []string{server.URL + "/reference.png"},
		ReferenceVideo:  videos[0], ReferenceVideos: videos,
		ReferenceMode: "image_reference", AudioSetting: "on", AspectRatio: "16:9",
		Resolution: "1080p", Duration: 15, OutputFormat: "mov",
	}
	svc := &Service{}
	result, err := svc.generateVideo(context.Background(), &domain.ProviderConfig{Vendor: "Volcengine", APISpec: "ark", ServiceType: "video"}, server.URL+"/api/v3", "ark-test-key", req)
	if err != nil {
		t.Fatalf("generateVideo: %v", err)
	}
	if result.Content != "https://example.com/result.mov" || polls != 2 {
		t.Fatalf("result=%+v, polls=%d", result, polls)
	}
	for key, want := range map[string]any{
		"model": req.Model, "ratio": "16:9", "duration": float64(15), "resolution": "1080p",
		"generate_audio": true, "omni_reference_task_type": "reference", "output_format": "mov", "watermark": false,
	} {
		if submitted[key] != want {
			t.Errorf("%s=%v, want %v", key, submitted[key], want)
		}
	}
	content := submitted["content"].([]any)
	if len(content) != 8 {
		t.Fatalf("content count=%d, want text + image + six videos", len(content))
	}
	if content[0].(map[string]any)["text"] != req.Prompt {
		t.Error("prompt was rewritten")
	}
	imageItem := content[1].(map[string]any)
	if imageItem["role"] != "reference_image" || imageItem["image_url"].(map[string]any)["url"] != req.ReferenceImages[0] {
		t.Errorf("image=%#v", imageItem)
	}
	for i, item := range content[2:] {
		video := item.(map[string]any)
		if video["type"] != "video_url" || video["role"] != "reference_video" || video["video_url"].(map[string]any)["url"] != videos[i] {
			t.Errorf("reference video %d=%#v", i, video)
		}
	}
}

func TestGenerateVideoArkSeedance25Resolutions(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, resolution := range []string{"480p", "720p", "1080p", " 1080P "} {
		t.Run(resolution, func(t *testing.T) {
			var submitted map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
						t.Errorf("decode request: %v", err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					_, _ = w.Write([]byte(`{"id":"task"}`))
				} else {
					_, _ = w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/output.mp4"}}`))
				}
			}))
			defer server.Close()
			_, err := (&Service{}).generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark"}, server.URL, "test", GenerateRequest{
				Model: "doubao-seedance-2-5-260628", Prompt: "日落", Resolution: resolution,
			})
			if err != nil {
				t.Fatal(err)
			}
			want := strings.ToLower(strings.TrimSpace(resolution))
			if submitted["resolution"] != want {
				t.Fatalf("resolution=%v, want %s without a downgrade", submitted["resolution"], want)
			}
		})
	}
}

func TestGenerateVideoArkSeedance25AudioAndFrameModes(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, tc := range []struct {
		name      string
		req       GenerateRequest
		wantRoles []string
		omni      bool
	}{
		{"audio-only", GenerateRequest{ReferenceAudio: "https://example.com/beat.mp3", ReferenceAudios: []string{"https://example.com/beat.mp3", "https://example.com/voice.wav"}, ReferenceMode: "image_reference"}, []string{"reference_audio", "reference_audio"}, true},
		{"first-frame", GenerateRequest{ReferenceImages: []string{"asset://frame1"}, ReferenceMode: "first_frame"}, []string{"first_frame"}, false},
		{"first-last", GenerateRequest{ReferenceImages: []string{"asset://frame1", "asset://frame2"}, ReferenceMode: "start_end"}, []string{"first_frame", "last_frame"}, false},
		{"text-only", GenerateRequest{ReferenceMode: "auto"}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					_ = json.NewDecoder(r.Body).Decode(&body)
					_, _ = w.Write([]byte(`{"id":"task"}`))
				} else {
					_, _ = w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/output.mp4"}}`))
				}
			}))
			defer server.Close()
			tc.req.Model, tc.req.Prompt, tc.req.AudioSetting, tc.req.Duration = "doubao-seedance-2-5-260628", "广告", "off", -1
			_, err := (&Service{}).generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark"}, server.URL, "test", tc.req)
			if err != nil {
				t.Fatal(err)
			}
			if body["generate_audio"] != false || body["duration"] != float64(-1) || body["output_format"] != "mp4" {
				t.Fatalf("options=%#v", body)
			}
			_, hasOmni := body["omni_reference_task_type"]
			if hasOmni != tc.omni {
				t.Errorf("omni=%v, want %v", hasOmni, tc.omni)
			}
			content := body["content"].([]any)
			if len(content) != 1+len(tc.wantRoles) {
				t.Fatalf("content=%#v", content)
			}
			for i, role := range tc.wantRoles {
				item := content[i+1].(map[string]any)
				if item["role"] != role {
					t.Errorf("content[%d]=%#v", i+1, item)
				}
			}
		})
	}
}

func TestArkSeedance25Validation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		req     GenerateRequest
		message string
	}{
		{"too-long", GenerateRequest{Duration: 31}, "4～30"},
		{"too-short", GenerateRequest{Duration: 3}, "4～30"},
		{"resolution", GenerateRequest{Resolution: "4k"}, "480p / 720p / 1080p"},
		{"format", GenerateRequest{OutputFormat: "webm"}, "MP4 / MOV"},
		{"audio-setting", GenerateRequest{AudioSetting: "origin"}, "on / off"},
		{"images", GenerateRequest{ReferenceImages: make([]string, 31)}, "30 张"},
		{"videos", GenerateRequest{ReferenceVideos: arkTestRefs(11, "mp4")}, "10 段参考视频"},
		{"audios", GenerateRequest{ReferenceAudios: arkTestRefs(11, "mp3")}, "10 段参考音频"},
		{"mixed-frames", GenerateRequest{ReferenceMode: "start_end", ReferenceImages: []string{"asset://one"}, ReferenceVideos: arkTestRefs(1, "mp4")}, "不能混用"},
		{"missing-frame", GenerateRequest{ReferenceMode: "first_frame"}, "首帧"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.req.Model = "doubao-seedance-2-5-260628"
			// Invalid requests must fail before dialing the provider.
			_, err := (&Service{}).generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark"}, "invalid-provider", "unused", tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("error=%v, want %q", err, tc.message)
			}
		})
	}
	valid := GenerateRequest{Duration: 30, Resolution: "720P", OutputFormat: "MOV", ReferenceMode: "image_reference", ReferenceImages: make([]string, 30), ReferenceVideos: arkTestRefs(10, "mp4"), ReferenceAudios: arkTestRefs(10, "mp3")}
	if err := validateArkSeedance25Request(valid); err != nil {
		t.Fatal(err)
	}
}

func arkTestRefs(count int, extension string) []string {
	refs := make([]string, count)
	for i := range refs {
		refs[i] = fmt.Sprintf("https://example.com/%d.%s", i, extension)
	}
	return refs
}

func TestGenerateVideoArkLegacyDoesNotGainSeedance25Options(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, model := range []string{"doubao-seedance-2-0-260128", "doubao-seedance-1-5-pro-251215"} {
		t.Run(model, func(t *testing.T) {
			var body map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					_ = json.NewDecoder(r.Body).Decode(&body)
					_, _ = w.Write([]byte(`{"id":"task"}`))
				} else {
					_, _ = w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/output.mp4"}}`))
				}
			}))
			defer server.Close()
			_, err := (&Service{}).generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark"}, server.URL, "test", GenerateRequest{Model: model, Prompt: "hello", Resolution: "1080p"})
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"omni_reference_task_type", "generate_audio", "output_format"} {
				if _, exists := body[key]; exists {
					t.Errorf("legacy model gained %s", key)
				}
			}
		})
	}
}
