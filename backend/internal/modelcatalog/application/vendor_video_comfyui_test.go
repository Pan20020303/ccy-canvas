package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestIsComfyMiniMaxH3Provider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyMiniMaxH3Provider(pc, comfyMiniMaxH3Model) {
		t.Fatal("expected local ComfyUI model match")
	}
	if isComfyMiniMaxH3Provider(pc, "MiniMax H3") {
		t.Fatal("cloud model must not match local adapter")
	}
}

func TestBuildComfyMiniMaxPromptSupportsTextOnly(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt(nil, nil, nil, "text only", 864, 480, 73, 42)
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	if len(conditioning) != 8 {
		t.Fatalf("text-only conditioning inputs = %d, want 8", len(conditioning))
	}
	if prompt["15"].(map[string]any)["class_type"] != "MiniMaxH3ReferenceToVideo" {
		t.Fatal("text-only mode should use the reference node with its supported zero-reference path")
	}
}

func TestBuildComfyMiniMaxPromptHasNineOrderedReferences(t *testing.T) {
	images := []string{"1.png", "2.png", "3.png", "4.png", "5.png", "6.png", "7.png", "8.png", "9.png"}
	prompt := buildComfyMiniMaxPrompt(images, nil, nil, "test", 864, 480, 73, 42)
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	for i := 0; i < 9; i++ {
		key := "ref_images.ref_image_" + string(rune('0'+i))
		link, ok := conditioning[key].([]any)
		if !ok || link[0] != string(rune('1'+i)) {
			t.Fatalf("%s = %#v", key, conditioning[key])
		}
	}
	if prompt["11"].(map[string]any)["class_type"] != "LoraLoaderModelOnly" {
		t.Fatal("missing LoRA node")
	}
	if prompt["19"].(map[string]any)["inputs"].(map[string]any)["steps"] != 4 {
		t.Fatal("expected 4 steps")
	}
}

func TestBuildComfyMiniMaxPromptMapsVideoAndAudioReferences(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt(nil, []string{"motion.mp4"}, []string{"voice.wav"}, "test", 864, 480, 73, 42)
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	if _, ok := prompt["30"]; !ok {
		t.Fatal("expected LoadVideo node")
	}
	if _, ok := prompt["31"]; !ok {
		t.Fatal("expected GetVideoComponents node")
	}
	if _, ok := prompt["40"]; !ok {
		t.Fatal("expected LoadAudio node")
	}
	if got := conditioning["ref_videos.ref_video_0"]; got == nil {
		t.Fatal("expected video frame reference")
	}
	if got := conditioning["ref_video_audios.ref_video_audio_0"]; got == nil {
		t.Fatal("expected matching video soundtrack reference")
	}
	if got := conditioning["ref_audios.ref_audio_0"]; got == nil {
		t.Fatal("expected standalone audio reference")
	}
}

func TestComfyMiniMaxDimensions(t *testing.T) {
	if w, h := comfyMiniMaxDimensions("9:16", "480p"); w != 480 || h != 864 {
		t.Fatalf("portrait = %dx%d", w, h)
	}
	if w, h := comfyMiniMaxDimensions("16:9", "768p"); w != 1344 || h != 768 {
		t.Fatalf("high landscape = %dx%d", w, h)
	}
}
