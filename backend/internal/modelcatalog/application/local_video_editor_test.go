package application

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEditorDetachedAudioFFmpegIntegration(t *testing.T) {
	if os.Getenv("CCY_TEST_FFMPEG") != "1" {
		t.Skip("set CCY_TEST_FFMPEG=1")
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	source := filepath.Join(dir, "av.mp4")
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-threads", "2", "-c:a", "aac", source)
	hideMediaProcess(cmd)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("fixture %v %s", e, out)
	}
	req := LocalVideoEditRequest{Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{
		{MediaURL: "/uploads/av.mp4", Kind: "video", Start: 0, End: 1, Speed: 1, Volume: 0},
		{MediaURL: "/uploads/av.mp4", Kind: "video", Start: 1, End: 3, Speed: 2, Volume: 0},
	}, Audio: []VideoEditClip{{MediaURL: "/uploads/av.mp4", Kind: "audio", Start: 1, End: 3, Speed: 2, Volume: .6, At: 1}}}
	result, err := (&Service{}).EditLocalVideo(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(result.Duration-2) > .12 {
		t.Fatalf("wrong duration %+v", result)
	}
	path := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(result.URL, "/uploads/")))
	for _, sample := range []struct {
		at      string
		audible bool
	}{{"0.2", false}, {"1.3", true}} {
		cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", sample.at, "-i", path, "-t", "0.1", "-vn", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1")
		hideMediaProcess(cmd)
		pcm, e := cmd.Output()
		if e != nil || len(pcm) < 100 {
			t.Fatalf("PCM %v (%d bytes)", e, len(pcm))
		}
		nonzero := 0
		for _, b := range pcm {
			if b != 0 {
				nonzero++
			}
		}
		if sample.audible && nonzero == 0 {
			t.Fatal("detached MP4 audio missing")
		}
		if !sample.audible && nonzero > 10 {
			t.Fatal("muted video leaked audio before detached offset")
		}
	}
}
func TestEditorFreeTimelineFFmpegIntegration(t *testing.T) {
	if os.Getenv("CCY_TEST_FFMPEG") != "1" {
		t.Skip("set CCY_TEST_FFMPEG=1")
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	run := func(args ...string) {
		cmd := exec.CommandContext(ctx, ffmpeg, append([]string{"-v", "error", "-y"}, args...)...)
		hideMediaProcess(cmd)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("%v %s", e, out)
		}
	}
	run("-f", "lavfi", "-i", "color=c=blue:size=320x240", "-frames:v", "1", "-threads", "1", filepath.Join(dir, "blue.png"))
	run("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", filepath.Join(dir, "tone.wav"))
	req := LocalVideoEditRequest{FreeTimeline: true, Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{
		{MediaURL: "/uploads/blue.png", Kind: "image", Start: 0, End: .5, Speed: 1, At: 2.5},
		{MediaURL: "/uploads/blue.png", Kind: "image", Start: 0, End: .5, Speed: 1, At: .5},
	}, Audio: []VideoEditClip{{MediaURL: "/uploads/tone.wav", Kind: "audio", Start: 0, End: .5, Speed: 1, Volume: .5, At: 3.3}}}
	result, err := (&Service{}).EditLocalVideo(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(result.Duration-3.8) > .1 {
		t.Fatalf("duration: %+v", result)
	}
	path := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(result.URL, "/uploads/")))
	for _, s := range []struct {
		at   string
		blue bool
	}{{"0.1", false}, {"0.7", true}, {"1.7", false}, {"2.7", true}, {"3.5", false}} {
		cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", s.at, "-i", path, "-frames:v", "1", "-vf", "crop=100:100:590:310,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
		hideMediaProcess(cmd)
		pixel, e := cmd.Output()
		if e != nil || len(pixel) < 3 {
			t.Fatalf("frame %s: %v", s.at, e)
		}
		if s.blue && pixel[2] < 180 {
			t.Fatalf("missing picture at %s: %v", s.at, pixel)
		}
		if !s.blue && (pixel[0] > 20 || pixel[1] > 20 || pixel[2] > 20) {
			t.Fatalf("missing black gap at %s: %v", s.at, pixel)
		}
	}
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", "3.5", "-i", path, "-t", "0.1", "-vn", "-f", "s16le", "pipe:1")
	hideMediaProcess(cmd)
	pcm, e := cmd.Output()
	if e != nil || len(pcm) < 100 {
		t.Fatalf("audio tail %v", e)
	}
	nonzero := 0
	for _, b := range pcm {
		if b != 0 {
			nonzero++
		}
	}
	if nonzero < 100 {
		t.Fatal("audio after last picture was cut off")
	}
	req.Clips[0].At = .7
	if _, err := validateVideoEdit(req); err == nil {
		t.Fatal("overlap accepted")
	}
	req.Clips[0].At = 600
	if _, err := validateVideoEdit(req); err == nil {
		t.Fatal("timeline over 600s accepted")
	}
}
func TestEditorValidation(t *testing.T) {
	req := LocalVideoEditRequest{Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{{MediaURL: "/uploads/a.mp4", Kind: "video", Start: 0, End: 2, Speed: 1, Volume: 1}}}
	if d, e := validateVideoEdit(req); e != nil || d != 2 {
		t.Fatalf("%v %v", d, e)
	}
	req.Clips[0].Speed = 0
	if _, e := validateVideoEdit(req); e == nil {
		t.Fatal("speed 0 allowed")
	}
	req.Clips[0].Speed = 1
	req.Width = 999999
	if _, e := validateVideoEdit(req); e == nil {
		t.Fatal("unsafe size allowed")
	}
	req.Width = 1280
	req.Audio = []VideoEditClip{{Kind: "audio", Start: 0, End: 1, Speed: 1, Volume: 1, At: 3}}
	if _, e := validateVideoEdit(req); e == nil {
		t.Fatal("out-of-bounds audio")
	}
}
func TestEditorFFmpegIntegration(t *testing.T) {
	if os.Getenv("CCY_TEST_FFMPEG") != "1" {
		t.Skip("set CCY_TEST_FFMPEG=1")
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	run := func(args ...string) {
		cmd := exec.CommandContext(ctx, ffmpeg, append([]string{"-v", "error", "-y"}, args...)...)
		hideMediaProcess(cmd)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("fixture %v %s", e, out)
		}
	}
	run("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "4", "-c:v", "libx264", "-threads", "2", filepath.Join(dir, "source.mp4"))
	run("-f", "lavfi", "-i", "color=c=blue:size=320x240", "-frames:v", "1", "-threads", "1", filepath.Join(dir, "still.png"))
	run("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", filepath.Join(dir, "sound.wav"))
	req := LocalVideoEditRequest{Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{
		{MediaURL: "/uploads/source.mp4", Kind: "video", Start: 1, End: 2, Speed: 1, Volume: 0},
		{MediaURL: "/uploads/still.png", Kind: "image", Start: 0, End: 1, Speed: 1, Volume: 0},
		{MediaURL: "/uploads/source.mp4", Kind: "video", Start: 2, End: 4, Speed: 2, Volume: 0},
	}, Audio: []VideoEditClip{{MediaURL: "/uploads/sound.wav", Kind: "audio", Start: 0, End: 1, Speed: 1, Volume: .5, At: 1}}}
	result, err := (&Service{}).EditLocalVideo(ctx, req)
	if err != nil {
		t.Fatalf("render: %+v", err)
	}
	if math.Abs(result.Duration-3) > .12 || result.Width != 1280 || !result.HasAudio {
		t.Fatalf("bad result %+v", result)
	}
	path := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(result.URL, "/uploads/")))
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", "1.5", "-i", path, "-frames:v", "1", "-vf", "crop=100:100:590:310,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
	hideMediaProcess(cmd)
	pixels, e := cmd.Output()
	if e != nil || len(pixels) < 3 {
		t.Fatalf("frame read %v", e)
	}
	if pixels[2] < 180 || pixels[0] > 45 {
		t.Fatalf("image segment missing: %v", pixels)
	}
	for _, sample := range []struct {
		at      string
		audible bool
	}{{"0.1", false}, {"1.4", true}} {
		cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", sample.at, "-i", path, "-t", "0.1", "-vn", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1")
		hideMediaProcess(cmd)
		pcm, e := cmd.Output()
		if e != nil {
			t.Fatal(e)
		}
		nonzero := 0
		for _, b := range pcm {
			if b != 0 {
				nonzero++
			}
		}
		if sample.audible && nonzero == 0 {
			t.Fatal("background audio missing")
		}
		if !sample.audible && nonzero > 10 {
			t.Fatal("audio started before offset")
		}
	}
}
