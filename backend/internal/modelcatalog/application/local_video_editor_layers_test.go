package application

import (
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEditorMultiTrackValidation(t *testing.T) {
	req := LocalVideoEditRequest{MultiTrack: true, FreeTimeline: true, Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{
		{Kind: "video", End: 2, Speed: 1, Track: 0},
		{Kind: "image", End: 2, Speed: 1, Track: 1},
	}}
	if d, err := validateVideoEdit(req); err != nil || d != 2 {
		t.Fatalf("overlapping layers: %v %v", d, err)
	}
	req.Clips[1].Track = 0
	if _, err := validateVideoEdit(req); err == nil {
		t.Fatal("overlap on same track accepted")
	}
	for _, track := range []int{-1, 8} {
		req.Clips[1].Track = track
		if _, err := validateVideoEdit(req); err == nil {
			t.Fatal("invalid track accepted")
		}
	}
	req.Clips[1].Track = 1
	for _, value := range []float64{0, .09, 1.1, math.NaN(), math.Inf(1)} {
		req.Clips[1].Scale = &value
		if _, err := validateVideoEdit(req); err == nil {
			t.Fatal("invalid scale accepted")
		}
	}
	req.Clips[1].Scale = nil
	for _, value := range []float64{-.1, 1.1, math.NaN(), math.Inf(-1)} {
		req.Clips[1].X = &value
		if _, err := validateVideoEdit(req); err == nil {
			t.Fatal("invalid position accepted")
		}
	}
	req.Clips[1].X = nil
	req.MultiTrack = false
	if _, err := validateVideoEdit(req); err == nil {
		t.Fatal("legacy request silently discarded layers")
	}
}

func TestEditorMultiTrackFFmpegIntegration(t *testing.T) {
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
			t.Fatalf("fixture: %v %s", e, out)
		}
	}
	run("-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-threads", "2", "-c:a", "aac", filepath.Join(dir, "blue.mp4"))
	run("-f", "lavfi", "-i", "color=c=red:size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-threads", "2", "-c:a", "aac", filepath.Join(dir, "red.mp4"))
	run("-f", "lavfi", "-i", "sine=frequency=1320:sample_rate=48000", "-t", "1", filepath.Join(dir, "tone.wav"))
	// A transparent PNG on the highest layer must not black out lower layers.
	img := image.NewNRGBA(image.Rect(0, 0, 320, 180))
	for y := 0; y < 40; y++ {
		for x := 0; x < 40; x++ {
			img.SetNRGBA(x, y, color.NRGBA{G: 255, A: 255})
		}
	}
	file, e := os.Create(filepath.Join(dir, "alpha.png"))
	if e != nil {
		t.Fatal(e)
	}
	if e = png.Encode(file, img); e != nil {
		file.Close()
		t.Fatal(e)
	}
	file.Close()
	scale, x, y := .5, .75, .5
	req := LocalVideoEditRequest{MultiTrack: true, FreeTimeline: true, Width: 1280, Height: 720, FPS: 30, Clips: []VideoEditClip{
		{MediaURL: "/uploads/red.mp4", Kind: "video", Start: .5, End: 1.5, Speed: 1, Volume: .5, At: 1, Track: 1, Scale: &scale, X: &x, Y: &y},
		{MediaURL: "/uploads/alpha.png", Kind: "image", End: 1, Speed: 1, At: 1, Track: 2},
		{MediaURL: "/uploads/blue.mp4", Kind: "video", End: 3, Speed: 1, Volume: .5, Track: 0},
	}, Audio: []VideoEditClip{{MediaURL: "/uploads/tone.wav", Kind: "audio", End: .5, Speed: 1, Volume: .5, At: 3.2}}}
	result, err := (&Service{}).EditLocalVideo(ctx, req)
	if err != nil {
		t.Fatalf("render %+v", err)
	}
	if math.Abs(result.Duration-3.7) > .1 {
		t.Fatalf("duration %+v", result)
	}
	path := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(result.URL, "/uploads/")))
	for _, sample := range []struct {
		at, crop string
		channel  int
	}{
		{"0.4", "crop=20:20:940:340", 2},  // before overlay
		{"1.4", "crop=20:20:940:340", 0},  // red picture-in-picture
		{"1.4", "crop=20:20:620:340", 2},  // transparent highest layer reveals blue
		{"1.4", "crop=20:20:40:40", 1},    // green alpha PNG
		{"2.3", "crop=20:20:940:340", 2},  // upper clip ends; no frozen last frame
		{"3.4", "crop=20:20:620:340", -1}, // audio-only tail is black
	} {
		cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", sample.at, "-i", path, "-frames:v", "1", "-vf", sample.crop+",scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
		hideMediaProcess(cmd)
		pixel, e := cmd.Output()
		if e != nil || len(pixel) < 3 {
			t.Fatalf("pixel %s: %v", sample.at, e)
		}
		for i, v := range pixel[:3] {
			if (i == sample.channel && v < 180) || (i != sample.channel && v > 35) {
				t.Fatalf("layer at %s %s got %v", sample.at, sample.crop, pixel)
			}
		}
	}
	for _, sample := range []struct {
		at              string
		present, absent []float64
	}{
		{"0.4", []float64{440}, []float64{880, 1320}},
		{"1.4", []float64{440, 880}, []float64{1320}},
		{"2.3", []float64{440}, []float64{880}},
		{"3.35", []float64{1320}, []float64{440, 880}},
	} {
		cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", sample.at, "-i", path, "-t", "0.2", "-vn", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1")
		hideMediaProcess(cmd)
		pcm, e := cmd.Output()
		if e != nil || len(pcm) < 100 {
			t.Fatalf("PCM %v", e)
		}
		amplitude := func(hz float64) float64 {
			real, imag := 0.0, 0.0
			count := len(pcm) / 2
			for i := 0; i < count; i++ {
				v := float64(int16(binary.LittleEndian.Uint16(pcm[i*2:]))) / 32768
				phase := 2 * math.Pi * hz * float64(i) / 8000
				real += v * math.Cos(phase)
				imag += v * math.Sin(phase)
			}
			return 2 * math.Hypot(real, imag) / float64(count)
		}
		for _, hz := range sample.present {
			if a := amplitude(hz); a < .015 {
				t.Fatalf("missing %v Hz at %s: %v", hz, sample.at, a)
			}
		}
		for _, hz := range sample.absent {
			if a := amplitude(hz); a > .005 {
				t.Fatalf("leaking %v Hz at %s: %v", hz, sample.at, a)
			}
		}
	}
}
