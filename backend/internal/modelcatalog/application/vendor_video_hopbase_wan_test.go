package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func fastHopBaseWanPoll(t *testing.T) {
	previous := hopBaseWanPollInterval
	hopBaseWanPollInterval = time.Millisecond
	t.Cleanup(func() { hopBaseWanPollInterval = previous })
}

func TestHopBaseWan3Gateway(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastHopBaseWanPoll(t)
	for _, spec := range []string{"custom", "dashscope", "ark"} {
		t.Run(spec, func(t *testing.T) {
			repo := &recordingTaskRepo{}
			var submitted map[string]any
			submits, polls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("missing authorization")
				}
				switch r.URL.Path {
				case hopBaseWanSubmitPath:
					submits++
					if r.Method != http.MethodPost || r.Header.Get("X-DashScope-Async") != "" {
						t.Error("incorrect submit contract")
					}
					if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
						t.Error(err)
					}
					w.WriteHeader(http.StatusAccepted)
					fmt.Fprint(w, `{"output":{"task_id":"blt-1","task_status":"PENDING"}}`)
				case "/api/v1/tasks/blt-1":
					polls++
					if r.Method != http.MethodGet {
						t.Error("poll must use GET")
					}
					if repo.taskID != "blt-1" {
						t.Error("task must be checkpointed before polling")
					}
					switch polls {
					case 1:
						w.WriteHeader(503)
					case 2:
						fmt.Fprint(w, `{"output":{"task_status":"UNKNOWN"}}`)
					case 3:
						fmt.Fprint(w, `{"output":{"task_status":"RUNNING"}}`)
					default:
						fmt.Fprint(w, `{"output":{"task_status":"SUCCEEDED","video_url":"https://cdn.example.com/wan.mp4"}}`)
					}
				default:
					t.Errorf("unexpected path: %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			seed := 0
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			result, err := (&Service{repo: repo}).generateVideo(ctx, &domain.ProviderConfig{
				ID: "provider", Vendor: "HopBase", APISpec: spec,
				SubmitEndpoint: "/v1/video/generate", QueryEndpoint: "/v1/video/tasks/{taskId}",
			}, server.URL+"/v1", "test-key", GenerateRequest{
				Model: "wan3.0-video", Prompt: "雨庭交锋", Duration: 30, Resolution: "1080p", AspectRatio: "16:9", Seed: &seed, AudioSetting: "off", GenerationLogID: "log",
				Parameters: map[string]any{"prompt_extend": false, "watermark": false, "quality": "high", "output_format": "mp4"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.Content != "https://cdn.example.com/wan.mp4" || submits != 1 || polls != 4 {
				t.Fatalf("result=%+v submits=%d polls=%d", result, submits, polls)
			}
			params := submitted["parameters"].(map[string]any)
			if len(submitted) != 3 || len(params) != 7 || params["resolution"] != "1080P" || params["duration"] != float64(30) || params["audio"] != false || params["seed"] != float64(0) || params["prompt_extend"] != false {
				t.Fatalf("wrong payload: %#v", submitted)
			}
			if repo.logID != "log" || repo.providerID != "provider" {
				t.Fatal("missing checkpoint")
			}
		})
	}
}

func TestHopBaseWan3Body(t *testing.T) {
	t.Run("request boundary preserves auto duration", func(t *testing.T) {
		if ClampModelVideoDuration("wan3.0-video", -1) != -1 || ClampModelVideoDuration("other", -1) != 0 || ClampModelVideoDuration("wan3.0-video", 30) != 30 {
			t.Fatal("duration clamp")
		}
	})
	t.Run("defaults omitted", func(t *testing.T) {
		body, err := buildHopBaseWan3Body(context.Background(), GenerateRequest{Prompt: "测试"})
		if err != nil || body["parameters"] != nil {
			t.Fatalf("%#v %v", body, err)
		}
	})
	t.Run("auto duration and adaptive ratio", func(t *testing.T) {
		body, err := buildHopBaseWan3Body(context.Background(), GenerateRequest{Prompt: "测试", Duration: -1, AspectRatio: "auto"})
		if err != nil {
			t.Fatal(err)
		}
		p := body["parameters"].(map[string]any)
		if p["duration"] != -1 || p["ratio"] != "adaptive" {
			t.Fatal(p)
		}
	})
	t.Run("frames media only", func(t *testing.T) {
		body, err := buildHopBaseWan3Body(context.Background(), GenerateRequest{ReferenceMode: "start_end", ReferenceImages: []string{"data:image/png;base64,aW1hZ2U=", "https://cdn.example.com/end.png"}})
		if err != nil {
			t.Fatal(err)
		}
		input := body["input"].(map[string]any)
		media := input["media"].([]hopBaseWanMedia)
		if input["prompt"] != nil || media[0].Type != "first_frame" || media[1].Type != "last_frame" {
			t.Fatal(input)
		}
	})
	t.Run("maximum mixed references", func(t *testing.T) {
		req := GenerateRequest{Prompt: "test", ReferenceMode: "image_reference"}
		for i := 0; i < 10; i++ {
			req.ReferenceImages = append(req.ReferenceImages, fmt.Sprintf("https://cdn.example.com/%d.png", i))
		}
		for i := 0; i < 5; i++ {
			req.ReferenceVideos = append(req.ReferenceVideos, fmt.Sprintf("https://cdn.example.com/%d.mp4", i))
			req.ReferenceAudios = append(req.ReferenceAudios, fmt.Sprintf("https://cdn.example.com/%d.mp3", i))
		}
		body, err := buildHopBaseWan3Body(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		media := body["input"].(map[string]any)["media"].([]hopBaseWanMedia)
		if len(media) != 20 || media[10].Type != "reference_video" || media[15].Type != "reference_audio" {
			t.Fatal(media)
		}
	})
	for _, kind := range []string{"file", "link", "last_frame"} {
		t.Run(kind, func(t *testing.T) {
			body, err := buildHopBaseWan3Body(context.Background(), GenerateRequest{Parameters: map[string]any{"media": []map[string]string{{"type": kind, "url": "https://cdn.example.com/media"}}}})
			if err != nil {
				t.Fatal(err)
			}
			if body["input"].(map[string]any)["media"].([]hopBaseWanMedia)[0].Type != kind {
				t.Fatal(body)
			}
		})
	}
}

func TestHopBaseWan3RejectsInvalidInput(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "0")
	params := func(key string, value any) GenerateRequest {
		return GenerateRequest{Prompt: "test", Parameters: map[string]any{key: value}}
	}
	cases := map[string]GenerateRequest{
		"empty": {}, "prompt length": {Prompt: strings.Repeat("字", 20001)},
		"duration low": {Prompt: "test", Duration: 1}, "duration high": {Prompt: "test", Duration: 31},
		"fractional": params("duration", 2.5), "duration zero": params("duration", 0),
		"resolution": {Prompt: "test", Resolution: "4k"}, "ratio": {Prompt: "test", AspectRatio: "21:9"},
		"audio": params("audio", "false"), "watermark": params("watermark", 1), "extend": params("prompt_extend", nil),
		"seed": params("seed", float64(2147483648)), "negative seed": params("seed", -1),
		"frames mixed":     {ReferenceMode: "start_end", ReferenceImages: []string{"https://cdn.example.com/a.png"}, ReferenceAudio: "https://cdn.example.com/a.mp3"},
		"three frames":     {ReferenceMode: "start_end", ReferenceImages: []string{"a", "b", "c"}},
		"two first frames": {ReferenceMode: "first_frame", ReferenceImages: []string{"a", "b"}},
		"eleven images":    {ReferenceImages: make([]string, 11)},
		"six videos":       {ReferenceVideos: []string{"a", "b", "c", "d", "e", "f"}},
		"six audios":       {ReferenceAudios: []string{"a", "b", "c", "d", "e", "f"}},
		"mode":             {Prompt: "test", ReferenceMode: "video_edit"},
		"oss":              {ReferenceImages: []string{"oss://bucket/a.png"}}, "asset": {ReferenceImages: []string{"asset://a"}},
		"internal":            {ReferenceImages: []string{"http://127.0.0.1/a.png"}},
		"invalid base64":      {ReferenceImages: []string{"data:image/png;base64,@@@"}},
		"no base64":           {ReferenceImages: []string{"data:image/png,abc"}},
		"file and link":       params("media", []hopBaseWanMedia{{Type: "file", URL: "a"}, {Type: "link", URL: "b"}}),
		"link data":           params("media", []hopBaseWanMedia{{Type: "link", URL: "data:text/plain;base64,dGVzdA=="}}),
		"unknown media":       params("media", []hopBaseWanMedia{{Type: "video", URL: "a"}}),
		"unknown media field": params("media", []map[string]string{{"type": "file", "url": "a", "ignored": "no"}}),
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := buildHopBaseWan3Body(context.Background(), req); err == nil {
				t.Fatal("expected preflight error")
			}
		})
	}
}

func TestHopBaseWan3Failures(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	fastHopBaseWanPoll(t)
	for _, tc := range []struct {
		name, submit, poll, want string
		status                   int
	}{
		{"submit denied", `{"code":"insufficient_balance","message":"余额不足"}`, "", "余额", 402},
		{"missing task", `{"output":{}}`, "", "任务编号", 200},
		{"failed", `{"output":{"task_id":"blt-1"}}`, `{"output":{"task_status":"FAILED","code":"TaskFailed","message":"素材下载失败"}}`, "素材下载失败", 200},
		{"missing video", `{"output":{"task_id":"blt-1"}}`, `{"output":{"task_status":"SUCCEEDED"}}`, "视频地址", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			submits := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					submits++
					w.WriteHeader(tc.status)
					fmt.Fprint(w, tc.submit)
				} else {
					fmt.Fprint(w, tc.poll)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := (&Service{}).generateVideo(ctx, &domain.ProviderConfig{Vendor: "HopBase"}, server.URL, "key", GenerateRequest{Model: "wan3.0-video", Prompt: "test"})
			if err == nil || !strings.Contains(err.Error(), tc.want) || submits != 1 {
				t.Fatalf("error=%v submits=%d", err, submits)
			}
		})
	}
}

func TestHopBaseWan3PollCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Service{}).pollHopBaseWan3Task(ctx, "https://api.hop-base.com", "key", "blt-1"); err == nil {
		t.Fatal("expected cancellation")
	}
}
