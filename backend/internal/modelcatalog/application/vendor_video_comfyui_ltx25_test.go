package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestIsComfyLTX25Provider(t *testing.T) {
	if !isComfyLTX25Provider(&domain.ProviderConfig{Vendor: "ComfyUI"}, comfyLTX25Model) {
		t.Fatal("expected LTX-2.5 ComfyUI provider match")
	}
}

func TestBuildComfyLTX25PromptTextToVideo(t *testing.T) {
	prompt := buildComfyLTX25Prompt(nil, "test", 896, 512, 121, 42, "standard")
	if _, ok := prompt["100"]; ok {
		t.Fatal("text-to-video must not load an image")
	}
	latent := prompt["17"].(map[string]any)["inputs"].(map[string]any)
	if latent["width"] != 448 || latent["height"] != 256 || latent["length"] != 121 {
		t.Fatalf("unexpected base latent: %#v", latent)
	}
	if prompt["41"].(map[string]any)["class_type"] != "SaveVideo" {
		t.Fatal("missing video output")
	}
}

func TestBuildComfyLTX25PromptMultiImage(t *testing.T) {
	prompt := buildComfyLTX25Prompt([]string{"first.png", "middle.png", "last.png"}, "test", 1280, 704, 361, 9, "high")
	for _, id := range []string{"100", "101", "102", "300", "301", "302", "400", "401", "402"} {
		if _, ok := prompt[id]; !ok {
			t.Fatalf("missing multi-image node %s", id)
		}
	}
	if got := prompt["300"].(map[string]any)["inputs"].(map[string]any)["frame_idx"]; got != 0 {
		t.Fatalf("first frame index = %v", got)
	}
	if got := prompt["301"].(map[string]any)["inputs"].(map[string]any)["frame_idx"]; got != 184 {
		t.Fatalf("middle frame index = %v", got)
	}
	if got := prompt["302"].(map[string]any)["inputs"].(map[string]any)["frame_idx"]; got != 360 {
		t.Fatalf("last frame index = %v", got)
	}
	stage1 := prompt["21"].(map[string]any)["inputs"].(map[string]any)["video_latent"].([]any)
	stage2 := prompt["31"].(map[string]any)["inputs"].(map[string]any)["video_latent"].([]any)
	if stage1[0] != "302" || stage2[0] != "402" {
		t.Fatalf("guide chains not connected: stage1=%#v stage2=%#v", stage1, stage2)
	}
}

func TestBuildComfyLTX25PromptStandardOnlyGuidesFirstStage(t *testing.T) {
	prompt := buildComfyLTX25Prompt([]string{"first.png", "last.png"}, "test", 896, 512, 121, 7, "standard")
	if _, ok := prompt["400"]; ok {
		t.Fatal("standard mode must not repeat reference guides in the refinement pass")
	}
	if _, ok := prompt["36"]; !ok {
		t.Fatal("standard mode must retain the refinement sampler")
	}
}

func TestBuildComfyLTX25PromptFastSkipsSecondDiffusionPass(t *testing.T) {
	prompt := buildComfyLTX25Prompt([]string{"first.png"}, "test", 896, 512, 121, 7, "fast")
	for _, id := range []string{"31", "36", "37", "44", "400"} {
		if _, ok := prompt[id]; ok {
			t.Fatalf("fast mode must omit second-pass node %s", id)
		}
	}
	decode := prompt["38"].(map[string]any)["inputs"].(map[string]any)["samples"].([]any)
	if decode[0] != "29" {
		t.Fatalf("fast video decode source = %#v, want latent upsampler", decode)
	}
}

func TestComfyLTX25Dimensions(t *testing.T) {
	if w, h := comfyLTX25Dimensions("9:16", "720p"); w != 704 || h != 1280 {
		t.Fatalf("portrait 720p = %dx%d", w, h)
	}
	if w, h := comfyLTX25Dimensions("16:9", "480p"); w != 896 || h != 512 {
		t.Fatalf("landscape 480p = %dx%d", w, h)
	}
}

func TestLTX25KeyframeIndices(t *testing.T) {
	got := ltx25KeyframeIndices(6, 73)
	want := []int{0, 16, 32, 40, 56, 72}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("indices = %#v, want %#v", got, want)
		}
	}
}
