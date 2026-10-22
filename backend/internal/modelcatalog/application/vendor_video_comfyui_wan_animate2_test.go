package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestIsComfyWanAnimate2Provider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyWanAnimate2Provider(pc, comfyWanAnimate2Model) {
		t.Fatal("expected Wan Animate 2 provider to match")
	}
	if isComfyWanAnimate2Provider(pc, "wan-other") {
		t.Fatal("unexpected model match")
	}
}

func TestBuildComfyWanAnimate2Prompt(t *testing.T) {
	prompt := buildComfyWanAnimate2Prompt("character.png", "motion.mp4", "preserve identity", 480, 832, 49, 42)
	animate := prompt["19"].(map[string]any)
	if animate["class_type"] != "WanAnimate2ToVideo" {
		t.Fatalf("animate class = %v", animate["class_type"])
	}
	inputs := animate["inputs"].(map[string]any)
	if inputs["length"] != 49 || inputs["width"] != 480 || inputs["height"] != 832 {
		t.Fatalf("animate inputs = %#v", inputs)
	}
	cache := prompt["9"].(map[string]any)["inputs"].(map[string]any)
	if cache["device"] != "cpu" || cache["dtype"] != "int8" {
		t.Fatalf("cache inputs = %#v", cache)
	}
	if prompt["24"].(map[string]any)["class_type"] != "SaveVideo" {
		t.Fatal("expected output node 24 to be SaveVideo")
	}
	loader := prompt["2"].(map[string]any)
	if loader["class_type"] != "VHS_LoadVideo" {
		t.Fatalf("video loader class = %v", loader["class_type"])
	}
	loaderInputs := loader["inputs"].(map[string]any)
	if loaderInputs["force_rate"] != 16.0 || loaderInputs["frame_load_cap"] != 49 {
		t.Fatalf("video loader inputs = %#v", loaderInputs)
	}
}

func TestWanAnimate2DimensionsAndFrames(t *testing.T) {
	w, h := comfyWanAnimate2Dimensions("9:16")
	if w != 480 || h != 832 {
		t.Fatalf("dimensions = %dx%d", w, h)
	}
	if got := validWanAnimate2FrameCount(3); got != 49 {
		t.Fatalf("frames = %d", got)
	}
}
