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

func TestResolveVideoDepthRuntimeRequiresConfiguredInstall(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("VIDEO_DEPTH_ANYTHING_DIR", dir)
	t.Setenv("VIDEO_DEPTH_PYTHON", "")
	if _, err := resolveVideoDepthRuntime(); err == nil {
		t.Fatal("accepted directory without run.py")
	}
}
