package application

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVideoAnalysisRangeAndContainerValidation(t *testing.T) {
	times, err := videoSampleTimes(30, 5, 25, 8)
	if err != nil || len(times) != 8 || times[0] <= 5 || times[7] >= 25 {
		t.Fatalf("bad sample times: %v %v", times, err)
	}
	for _, args := range [][4]float64{{700, 0, 30, 8}, {30, 5, 35, 8}, {300, 0, 300, 8}, {30, -1, 20, 8}, {30, 20, 10, 8}, {30, 0, 30, 13}, {30, 0, 30, 1}, {math.NaN(), 0, 20, 8}} {
		if _, err := videoSampleTimes(args[0], args[1], args[2], int(args[3])); err == nil {
			t.Errorf("invalid analysis range accepted: %v", args)
		}
	}
	for _, header := range []string{"#EXTM3U\nhttps://private/video.ts", "ffconcat version 1.0\nfile '/secret'", "<html>video</html>", "<svg/>"} {
		if _, err := visionVideoContainer([]byte(header)); err == nil {
			t.Errorf("unsafe demuxer selected: %q", header)
		}
	}
	args := strings.Join(videoFrameCommandArgs("input.media", "frame.jpg", "mov", 1.5), " ")
	for _, guard := range []string{"-protocol_whitelist file", "-format_whitelist mov", "-enable_drefs 0", "-use_absolute_path 0", "-an -sn -dn", "-frames:v 1", "-fs 1048576", "-max_alloc 67108864"} {
		if !strings.Contains(args, guard) {
			t.Errorf("missing ffmpeg guard %s: %s", guard, args)
		}
	}
}

func TestVideoAnalysisNodeReferenceResolution(t *testing.T) {
	state := NewCanvasState([]CanvasNode{
		{ID: "video", Type: "referenceVideoNode", Data: map[string]any{"url": "/uploads/video.mp4", "poster": "/uploads/poster.png"}},
		{ID: "output", Type: "videoNode", Data: map[string]any{"outputs": []any{map[string]any{"video_url": "/uploads/second.mov"}}, "preview": "/uploads/poster.png"}},
		{ID: "empty", Type: "videoNode", Data: map[string]any{"poster": "/uploads/poster.png"}},
		{ID: "image", Type: "imageNode", Data: map[string]any{"url": "/uploads/image.png"}},
	}, nil, func(string, any) {})
	tool := BuildAnalyzeVideoTool(state, nil, nil, "deepseek-flash").(*analyzeVideoTool)
	for id, want := range map[string]string{"video": "/uploads/video.mp4", "output": "/uploads/second.mov"} {
		got, err := tool.videoURLFromNode(id)
		if err != nil || got != want {
			t.Fatalf("wrong video source for %s: %s %v", id, got, err)
		}
	}
	for _, id := range []string{"empty", "image", "missing"} {
		if _, err := tool.videoURLFromNode(id); err == nil {
			t.Errorf("non-video source accepted: %s", id)
		}
	}
	for _, payload := range []string{`{}`, `{"node_id":"video","frame_count":50}`, `{"video_url":"/uploads/video.mp4","start_seconds":10,"end_seconds":5}`, `{"video_url":"/uploads/video.mp4","private":"data"}`} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(payload)); err == nil {
			t.Errorf("invalid request accepted: %s", payload)
		}
	}
}

// This integration test invokes real local FFmpeg/ffprobe against a synthetic
// two-second video, then sends actual extracted bytes only to httptest.
func TestVideoAnalysisFFmpegMockIntegration(t *testing.T) {
	if os.Getenv("CCY_TEST_FFMPEG") != "1" {
		t.Skip("set CCY_TEST_FFMPEG=1 to run real local media integration")
	}
	ffmpeg, err := visionMediaExecutable("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := visionMediaExecutable("ffprobe"); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	t.Setenv("UPLOAD_DIR", directory)
	input := filepath.Join(directory, "sample.mp4")
	if _, err := runVisionMediaCommand(context.Background(), ffmpeg, []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=20", "-t", "2", "-an", "-c:v", "libx264", "-threads", "1", "-filter_threads", "1", "-pix_fmt", "yuv420p", input}); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string           `json:"role"`
				Content []map[string]any `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "deepseek-flash" {
			t.Errorf("model switched: %s", body.Model)
		}
		images, timestamps := 0, 0
		for _, message := range body.Messages {
			for _, part := range message.Content {
				if part["type"] == "image_url" {
					images++
					imageURL := part["image_url"].(map[string]any)["url"].(string)
					if !strings.HasPrefix(imageURL, "data:image/jpeg;base64,") || len(imageURL) < 300 {
						t.Errorf("missing real extracted frame: %.80s", imageURL)
					}
				}
				if text, ok := part["text"].(string); ok && strings.Contains(text, "视频时间") {
					timestamps++
				}
			}
		}
		if images != 8 || timestamps != 8 {
			t.Errorf("expected 8 timed real frames, got %d/%d", images, timestamps)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"抽样画面显示彩色测试图在移动，未分析声音。"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()
	state := NewCanvasState([]CanvasNode{{ID: "sample", Type: "referenceVideoNode", Data: map[string]any{"url": "/uploads/sample.mp4"}}}, nil, func(string, any) {})
	tool := BuildAnalyzeVideoTool(state, &LLMClient{httpClient: server.Client()}, []Endpoint{{BaseURL: server.URL, APIKey: "mock-only"}}, "deepseek-flash")
	raw, err := tool.Execute(context.Background(), json.RawMessage(`{"node_id":"sample","question":"描述动作"}`))
	if err != nil {
		t.Fatal(err)
	}
	var result VideoAnalysisResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || result.FrameCount != 8 || len(result.SampledTimes) != 8 || result.AudioAnalyzed || !strings.Contains(result.AudioNotice, "未分析") || result.DurationSeconds < 1.9 || result.DurationSeconds > 2.1 {
		t.Fatalf("unexpected analysis result: requests=%d result=%+v", requests, result)
	}
	// No ffmpeg temp folder may be created under the public upload directory.
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != "sample.mp4" {
		t.Fatalf("analysis polluted upload directory: %v %v", entries, err)
	}
}
