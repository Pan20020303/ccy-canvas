package application

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDepthRunnerArgsUseSmallTemporalModelAndGrayscale(t *testing.T) {
	args := strings.Join(depthRunnerArgs("run.py", "input.mp4", "out"), " ")
	for _, want := range []string{"run.py", "--input_video input.mp4", "--output_dir out", "--encoder vits", "--max_res 1280", "--target_fps -1", "--grayscale"} {
		if !strings.Contains(args, want) {
			t.Fatalf("args missing %q: %s", want, args)
		}
	}
}

func TestDepthInputPreparationCoversOddAndHighResolutionFrames(t *testing.T) {
	for _, tc := range []struct {
		name        string
		width       int
		height      int
		wantPrepare bool
	}{
		{name: "common 1366 by 720 source", width: 1366, height: 720, wantPrepare: true},
		{name: "odd source dimension", width: 1279, height: 720, wantPrepare: true},
		{name: "already safe HD source", width: 1280, height: 720, wantPrepare: false},
		{name: "already safe portrait source", width: 720, height: 1280, wantPrepare: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := depthInputNeedsPreparation(tc.width, tc.height); got != tc.wantPrepare {
				t.Fatalf("depthInputNeedsPreparation(%d, %d) = %v, want %v", tc.width, tc.height, got, tc.wantPrepare)
			}
		})
	}
}

func TestFindDepthVideoUsesLargestValidVideo(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("ignore"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "small.mp4"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(dir, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(nested, "depth.webm")
	if err := os.WriteFile(large, []byte("12345"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := findDepthVideo(dir)
	if err != nil || got != large {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestFindDepthVideoPrefersRenderedDepthOverLargerSourceCopy(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "input_src.mp4")
	depth := filepath.Join(dir, "input_vis.mp4")
	if err := os.WriteFile(source, []byte("much-larger-rgb-source-copy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(depth, []byte("depth"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := findDepthVideo(dir)
	if err != nil || got != depth {
		t.Fatalf("got %q, %v; want rendered depth %q", got, err, depth)
	}
}

func TestResolveVideoDepthRuntimeRequiresConfiguredInstall(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("VIDEO_DEPTH_ANYTHING_DIR", dir)
	t.Setenv("VIDEO_DEPTH_PYTHON", "")
	if _, err := resolveVideoDepthRuntime(); err == nil {
		t.Fatal("accepted directory without run.py")
	}
}
