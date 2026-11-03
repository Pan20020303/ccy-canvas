package application

import (
	"context"
	"testing"
)

// 可灵（阿里云百炼渠道）的参数换算：mode 由分辨率档位映射、aspect_ratio 键名、
// duration 上下限、audio 布尔。
func TestBuildKlingVideoParameters(t *testing.T) {
	t.Run("t2v defaults: pro mode, aspect_ratio key, audio false", func(t *testing.T) {
		p := buildDashScopeVideoParameters(GenerateRequest{
			Model:       "kling/kling-v3-video-generation",
			Resolution:  "1080P",
			AspectRatio: "9:16",
			Duration:    5,
		})
		if p["mode"] != "pro" {
			t.Fatalf("mode = %v, want pro", p["mode"])
		}
		if p["aspect_ratio"] != "9:16" {
			t.Fatalf("aspect_ratio = %v, want 9:16", p["aspect_ratio"])
		}
		if _, has := p["ratio"]; has {
			t.Fatalf("ratio should not be sent for kling (aspect_ratio is the key)")
		}
		if _, has := p["resolution"]; has {
			t.Fatalf("resolution should not be sent for kling (mapped to mode)")
		}
		if p["duration"] != 5 {
			t.Fatalf("duration = %v, want 5", p["duration"])
		}
		if p["audio"] != false {
			t.Fatalf("audio = %v, want false", p["audio"])
		}
		if p["watermark"] != false {
			t.Fatalf("watermark = %v, want false", p["watermark"])
		}
	})

	t.Run("720P maps to std; audioSetting on maps to audio true", func(t *testing.T) {
		p := buildDashScopeVideoParameters(GenerateRequest{
			Model:        "kling/kling-v3-omni-video-generation",
			Resolution:   "720P",
			AudioSetting: "on",
		})
		if p["mode"] != "std" {
			t.Fatalf("mode = %v, want std", p["mode"])
		}
		if p["audio"] != true {
			t.Fatalf("audio = %v, want true", p["audio"])
		}
	})

	t.Run("first_frame mode omits aspect_ratio (follows the frame)", func(t *testing.T) {
		p := buildDashScopeVideoParameters(GenerateRequest{
			Model:         "kling/kling-v3-video-generation",
			AspectRatio:   "16:9",
			ReferenceMode: "first_frame",
		})
		if _, has := p["aspect_ratio"]; has {
			t.Fatalf("aspect_ratio must be omitted in first_frame mode")
		}
	})

	t.Run("video_edit clamps duration to 10 and forces audio false", func(t *testing.T) {
		p := buildDashScopeVideoParameters(GenerateRequest{
			Model:         "kling/kling-v3-omni-video-generation",
			ReferenceMode: "video_edit",
			Duration:      15,
			AudioSetting:  "on",
		})
		if p["duration"] != 10 {
			t.Fatalf("duration = %v, want clamped 10", p["duration"])
		}
		if p["audio"] != false {
			t.Fatalf("audio = %v, want forced false in video_edit", p["audio"])
		}
	})
}

func TestValidateKlingVideoRequest(t *testing.T) {
	imgs := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = "https://example.com/ref.png"
		}
		return out
	}

	cases := []struct {
		name    string
		req     GenerateRequest
		wantErr bool
	}{
		{"t2v clean", GenerateRequest{Model: "kling/kling-v3-video-generation", AspectRatio: "16:9"}, false},
		{"t2v rejects refs", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceImages: imgs(1)}, true},
		{"bad ratio", GenerateRequest{Model: "kling/kling-v3-video-generation", AspectRatio: "21:9"}, true},
		{"bad duration", GenerateRequest{Model: "kling/kling-v3-video-generation", Duration: 20}, true},
		{"first_frame ok", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceMode: "first_frame", ReferenceImages: imgs(1)}, false},
		{"first_frame needs exactly 1", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceMode: "first_frame", ReferenceImages: imgs(2)}, true},
		{"start_end ok", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceMode: "start_end", ReferenceImages: imgs(2)}, false},
		{"image_reference needs omni", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceMode: "image_reference", ReferenceImages: imgs(2)}, true},
		{"image_reference omni ok", GenerateRequest{Model: "kling/kling-v3-omni-video-generation", ReferenceMode: "image_reference", ReferenceImages: imgs(7)}, false},
		{"image_reference over cap", GenerateRequest{Model: "kling/kling-v3-omni-video-generation", ReferenceMode: "image_reference", ReferenceImages: imgs(8)}, true},
		{"video_edit needs omni", GenerateRequest{Model: "kling/kling-v3-video-generation", ReferenceMode: "video_edit", ReferenceVideo: "https://example.com/v.mp4"}, true},
		{"video_edit omni ok", GenerateRequest{Model: "kling/kling-v3-omni-video-generation", ReferenceMode: "video_edit", ReferenceVideo: "https://example.com/v.mp4", ReferenceImages: imgs(4)}, false},
		{"video_edit too many refs", GenerateRequest{Model: "kling/kling-v3-omni-video-generation", ReferenceMode: "video_edit", ReferenceVideo: "https://example.com/v.mp4", ReferenceImages: imgs(5)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateDashScopeVideoRequest(tc.req)
			if tc.wantErr && err == nil {
				t.Fatalf("want error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("want nil, got %v", err)
			}
		})
	}
}

// 媒体角色映射：首尾帧 → first_frame/last_frame；参考生 → refer；视频编辑 →
// base + refer。公网 HTTP URL 原样通过（非 COS 对象不预签名）。
func TestBuildKlingVideoMedia(t *testing.T) {
	ctx := context.Background()

	t.Run("start_end assigns per-image roles", func(t *testing.T) {
		media, err := buildDashScopeVideoMedia(ctx, GenerateRequest{
			Model:           "kling/kling-v3-video-generation",
			ReferenceMode:   "start_end",
			ReferenceImages: []string{"https://example.com/a.png", "https://example.com/b.png"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(media) != 2 || media[0]["type"] != "first_frame" || media[1]["type"] != "last_frame" {
			t.Fatalf("media roles = %v, want [first_frame last_frame]", media)
		}
	})

	t.Run("image_reference maps to refer", func(t *testing.T) {
		media, err := buildDashScopeVideoMedia(ctx, GenerateRequest{
			Model:           "kling/kling-v3-omni-video-generation",
			ReferenceMode:   "image_reference",
			ReferenceImages: []string{"https://example.com/a.png"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(media) != 1 || media[0]["type"] != "refer" {
			t.Fatalf("media = %v, want single refer", media)
		}
	})

	t.Run("video_edit emits base video + refer images", func(t *testing.T) {
		media, err := buildDashScopeVideoMedia(ctx, GenerateRequest{
			Model:           "kling/kling-v3-omni-video-generation",
			ReferenceMode:   "video_edit",
			ReferenceVideo:  "https://example.com/v.mp4",
			ReferenceImages: []string{"https://example.com/a.png"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(media) != 2 || media[0]["type"] != "base" || media[1]["type"] != "refer" {
			t.Fatalf("media = %v, want [base refer]", media)
		}
	})

	t.Run("data URL images are rejected", func(t *testing.T) {
		_, err := buildDashScopeVideoMedia(ctx, GenerateRequest{
			Model:           "kling/kling-v3-video-generation",
			ReferenceMode:   "first_frame",
			ReferenceImages: []string{"data:image/png;base64,AAAA"},
		})
		if err == nil {
			t.Fatalf("want error for data URL reference image")
		}
	})
}
