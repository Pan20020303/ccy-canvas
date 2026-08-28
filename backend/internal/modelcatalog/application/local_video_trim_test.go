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

func TestTrimRangeValidation(t *testing.T) {
	for _, r := range [][2]float64{{-1, 1}, {2, 1}, {0, 0}, {0, 601}, {3600, 3601}, {math.NaN(), 2}, {0, math.Inf(1)}} {
		if validateTrimRange(r[0], r[1]) == nil {
			t.Fatalf("accepted invalid range: %v", r)
		}
	}
	if err := validateTrimRange(1.25, 3.75); err != nil {
		t.Fatal(err)
	}
}
func TestTrimArgs(t *testing.T) {
	a := trimFFmpegArgs("input.media", "clip.mp4", LocalVideoTrimRequest{Start: 1.25, End: 3.75})
	s := strings.Join(a, " ")
	for _, part := range []string{"-ss 1.250000", "-t 2.500000", "-map 0:a:0?", "-c:v libx264", "-movflags +faststart", "-protocol_whitelist file", "-format_whitelist mov,matroska,webm,avi"} {
		if !strings.Contains(s, part) {
			t.Fatalf("missing %s", part)
		}
	}
	s = strings.Join(trimFFmpegArgs("in", "out", LocalVideoTrimRequest{Start: 0, End: 1, Mute: true}), " ")
	if !strings.Contains(s, "-an") || strings.Contains(s, "-map 0:a") {
		t.Fatal("mute still maps audio")
	}
}
func TestTrimRejectsUnsafeSources(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	for _, raw := range []string{"file:///C:/Windows/win.ini", "http://127.0.0.1:8188/", "http://169.254.169.254/", "/uploads/../../outside", "/uploads/C:/Windows/win.ini", "blob:bad", "data:video/mp4;base64,AA=="} {
		if err := copyTrimInput(context.Background(), raw, filepath.Join(dir, "copy")); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}
func TestLocalTrimFFmpegIntegration(t *testing.T) {
	if os.Getenv("CCY_TEST_FFMPEG") != "1" {
		t.Skip("set CCY_TEST_FFMPEG=1 with FFMPEG_PATH and FFPROBE_PATH")
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	ffprobe, err := localMediaExecutable("ffprobe")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("UPLOAD_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	source := filepath.Join(dir, "source.mp4")
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", source)
	hideMediaProcess(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	for _, mute := range []bool{false, true} {
		result, err := (&Service{}).TrimLocalVideo(ctx, LocalVideoTrimRequest{MediaURL: "/uploads/source.mp4", Start: 1, End: 3, Mute: mute})
		if err != nil {
			t.Fatal(err)
		}
		if result.Width != 320 || result.Height != 240 || math.Abs(result.Duration-2) > .1 || result.HasAudio == mute {
			t.Fatalf("bad export: %+v", result)
		}
		output := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(result.URL, "/uploads/")))
		meta, err := probeTrimVideo(ctx, ffprobe, output)
		if err != nil || len(meta.Streams) == 0 {
			t.Fatalf("bad output %v", err)
		}
		// Re-use the silent exported file: a source with no audio must also succeed.
		if mute {
			silent, err := (&Service{}).TrimLocalVideo(ctx, LocalVideoTrimRequest{MediaURL: result.URL, Start: .25, End: 1.25})
			if err != nil || silent.HasAudio {
				t.Fatalf("silent source failed: %+v %v", silent, err)
			}
		}
	}
	if _, err := (&Service{}).TrimLocalVideo(ctx, LocalVideoTrimRequest{MediaURL: "/uploads/source.mp4", Start: 3, End: 6}); err == nil {
		t.Fatal("out-of-range accepted")
	}
	bad := filepath.Join(dir, "bad.m3u8")
	if err := os.WriteFile(bad, []byte("#EXTM3U\n#EXTINF:1\nfile:///etc/passwd\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := probeTrimVideo(ctx, ffprobe, bad); err == nil {
		t.Fatal("playlist accepted")
	}
	before, _ := os.Stat(source)
	if before.Size() == 0 {
		t.Fatal("original changed")
	}
}
