package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestMiniMaxDirectorGetsLongVideoBudget(t *testing.T) {
	req := GenerateRequest{ServiceType: "video", Model: comfyMiniMaxH3DirectorModel}
	if got := maxRuntimeForRequest(req); got != 3*time.Hour {
		t.Fatalf("director runtime = %s, want 3h", got)
	}
}

func TestMiniMaxU09AndDramaModelsGetLongVideoBudget(t *testing.T) {
	for _, model := range []string{comfyMiniMaxH3U09RedrawModel, comfyMiniMaxH3U09NoCodecModel, comfyMiniMaxH3DramaModel} {
		req := GenerateRequest{ServiceType: "video", Model: model}
		if got := maxRuntimeForRequest(req); got != 3*time.Hour {
			t.Fatalf("%s runtime = %s, want 3h", model, got)
		}
	}
}

func TestComfyVideoWallClockSeparatesQueueAndExecution(t *testing.T) {
	t.Setenv("VIDEO_TASK_MAX_RUNTIME_SECONDS", "1800")
	t.Setenv("VIDEO_TASK_MAX_QUEUE_SECONDS", "7200")
	req := GenerateRequest{ServiceType: "video", Model: comfyMiniMaxH3Model}
	if got := maxRuntimeForRequest(req); got != 30*time.Minute {
		t.Fatalf("execution budget = %s, want 30m", got)
	}
	if got := maxWallClockForRequest(req); got != 150*time.Minute {
		t.Fatalf("wall-clock safety budget = %s, want 2h queue + 30m execution", got)
	}
}

func TestComfyVideoDeadlineStartsExecutionClockOnlyWhenRunning(t *testing.T) {
	start := time.Unix(100, 0)
	tracker := newComfyVideoDeadlineTracker(start, 2*time.Hour, 30*time.Minute)

	// A long legitimate queue wait must not spend any of the 30-minute
	// generation allowance.
	tracker.observe(comfyPromptQueued, start.Add(90*time.Minute))
	if stage, expired := tracker.expired(start.Add(90 * time.Minute)); expired {
		t.Fatalf("unexpected %s timeout while prompt is only queued", stage)
	}

	tracker.observe(comfyPromptRunning, start.Add(90*time.Minute))
	if stage, expired := tracker.expired(start.Add(119*time.Minute + 59*time.Second)); expired {
		t.Fatalf("unexpected %s timeout before 30m of execution", stage)
	}
	if stage, expired := tracker.expired(start.Add(120 * time.Minute)); !expired || stage != "execution" {
		t.Fatalf("deadline = (%q, %v), want execution timeout", stage, expired)
	}
}

func TestComfyVideoDeadlineStillBoundsLostQueuedPrompt(t *testing.T) {
	start := time.Unix(100, 0)
	tracker := newComfyVideoDeadlineTracker(start, 2*time.Hour, 30*time.Minute)
	if stage, expired := tracker.expired(start.Add(2 * time.Hour)); !expired || stage != "queue" {
		t.Fatalf("deadline = (%q, %v), want queue timeout", stage, expired)
	}
}

func TestComfyPromptQueuePhaseReadsPendingAndRunning(t *testing.T) {
	phase := comfyPromptQueued
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/queue" {
			t.Fatalf("path = %q, want /queue", r.URL.Path)
		}
		if phase == comfyPromptRunning {
			_, _ = w.Write([]byte(`{"queue_running":[[1,"prompt-1",{},{}]],"queue_pending":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"queue_running":[],"queue_pending":[[1,"prompt-1",{},{}]]}`))
	}))
	defer server.Close()

	client := server.Client()
	if got := comfyPromptQueuePhase(context.Background(), client, server.URL, "prompt-1"); got != comfyPromptQueued {
		t.Fatalf("pending phase = %q", got)
	}
	phase = comfyPromptRunning
	if got := comfyPromptQueuePhase(context.Background(), client, server.URL, "prompt-1"); got != comfyPromptRunning {
		t.Fatalf("running phase = %q", got)
	}
}

func TestIsComfyMiniMaxH3Provider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyMiniMaxH3Provider(pc, comfyMiniMaxH3Model) {
		t.Fatal("expected local ComfyUI model match")
	}
	if isComfyMiniMaxH3Provider(pc, "MiniMax H3") {
		t.Fatal("cloud model must not match local adapter")
	}
	for _, model := range []string{comfyMiniMaxH3U09RedrawModel, comfyMiniMaxH3U09NoCodecModel, comfyMiniMaxH3DramaModel} {
		if !isComfyMiniMaxH3Provider(pc, model) {
			t.Fatalf("expected %s to use local H3 adapter", model)
		}
	}
}

func TestBuildComfyMiniMaxU09PromptKeepsFirstPassAudio(t *testing.T) {
	prompt := buildComfyMiniMaxU09Prompt([]string{"character.png"}, nil, nil, "test", 1344, 768, 121, 42, "平衡 8+3步", comfyMiniMaxH3U09RedrawModel)
	if prompt["64"].(map[string]any)["class_type"] != "MinimaxH3LatentUpscaler3D" {
		t.Fatal("U09 redraw must use the installed H3 latent upscaler")
	}
	if prompt["70"].(map[string]any)["inputs"].(map[string]any)["unet_name"] != "minimax/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors" {
		t.Fatal("U09 redraw must use the W4A8 second-pass model")
	}
	audio := prompt["79"].(map[string]any)["inputs"].(map[string]any)["samples"].([]any)
	if audio[0] != "63" || audio[1] != 1 {
		t.Fatalf("audio source = %#v, want first-pass separated audio", audio)
	}
	if _, ok := prompt["61"]; ok {
		t.Fatal("redraw variant must not inject the no-codec sigma refiner")
	}
}

func TestBuildComfyMiniMaxU09NoCodecUsesSigmaRefiners(t *testing.T) {
	prompt := buildComfyMiniMaxU09Prompt(nil, nil, nil, "test", 768, 1344, 121, 42, "原生 20+3步", comfyMiniMaxH3U09NoCodecModel)
	for _, id := range []string{"61", "75"} {
		if prompt[id].(map[string]any)["class_type"] != "H3SigmaRefiner" {
			t.Fatalf("node %s must be H3SigmaRefiner", id)
		}
	}
	upscale := prompt["64"].(map[string]any)["inputs"].(map[string]any)
	if upscale["mode"] != "scale by multiplier" || upscale["mode.scale"] != 1.5 {
		t.Fatalf("no-codec upscale = %#v", upscale)
	}
}

func TestBuildComfyMiniMaxPromptSupportsTextOnly(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt(nil, nil, nil, "text only", 864, 480, 73, 42, "极速")
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
	prompt := buildComfyMiniMaxPrompt(images, nil, nil, "test", 864, 480, 73, 42, "极速")
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	if got := conditioning["ref_image_size"]; got != "match" {
		t.Fatalf("nine-reference image size = %v, want match", got)
	}
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
	if prompt["18"].(map[string]any)["class_type"] != "MiniMaxH3DualClockEulerSampler" {
		t.Fatal("expected dual-clock Euler sampler")
	}
	if prompt["25"].(map[string]any)["class_type"] != "MiniMaxH3SigmaShift" {
		t.Fatal("expected H3 video/audio sigma shift")
	}
}

func TestBuildComfyMiniMaxPromptUsesHighFidelityForSmallReferenceSet(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt([]string{"character.png", "scene.png"}, nil, nil, "test", 768, 1344, 121, 42, "均衡二采")
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	if got := conditioning["ref_image_size"]; got != "max" {
		t.Fatalf("two-reference image size = %v, want max", got)
	}
}

func TestBuildComfyMiniMaxPromptKeepsLegacyReferenceEncodingInFastMode(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt([]string{"character.png", "scene.png"}, nil, nil, "test", 768, 1344, 121, 42, "极速")
	conditioning := prompt["15"].(map[string]any)["inputs"].(map[string]any)
	if got := conditioning["ref_image_size"]; got != "match" {
		t.Fatalf("fast two-reference image size = %v, want match", got)
	}
}

func TestBuildComfyMiniMaxPromptMatchesOfficialEightStepProfile(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt([]string{"character.png", "scene.png"}, nil, nil, "test", 768, 1344, 121, 42, "官方8步")
	unet := prompt["10"].(map[string]any)["inputs"].(map[string]any)
	if got := unet["unet_name"]; got != "minimax_h3_ref2va_int8_convrot.safetensors" {
		t.Fatalf("official unet = %v", got)
	}
	if prompt["25"].(map[string]any)["class_type"] != "ModelAttentionBackend" {
		t.Fatal("official profile must enable Comfy Kitchen attention")
	}
	lora := prompt["11"].(map[string]any)["inputs"].(map[string]any)
	if lora["lora_name"] != "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" || lora["strength_model"] != 0.75 {
		t.Fatalf("official lora inputs = %#v", lora)
	}
	clip := prompt["12"].(map[string]any)["inputs"].(map[string]any)
	if clip["clip_name"] != "qwen3vl_32b_minimax_h3_int8_convrot.safetensors" {
		t.Fatalf("official clip = %v", clip["clip_name"])
	}
	if prompt["18"].(map[string]any)["class_type"] != "KSamplerSelect" {
		t.Fatal("official profile must use the regular Euler sampler")
	}
	scheduler := prompt["19"].(map[string]any)["inputs"].(map[string]any)
	if scheduler["scheduler"] != "beta" || scheduler["steps"] != 8 {
		t.Fatalf("official scheduler = %#v", scheduler)
	}
}

func TestBuildComfyMiniMaxPromptMapsVideoAndAudioReferences(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt(nil, []string{"motion.mp4"}, []string{"voice.wav"}, "test", 864, 480, 73, 42, "极速")
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

func TestBuildComfyMiniMaxPromptAddsSecondPassByProfile(t *testing.T) {
	prompt := buildComfyMiniMaxPrompt(nil, nil, nil, "test", 864, 480, 73, 42, "均衡二采")
	if prompt["74"].(map[string]any)["class_type"] != "SamplerCustomAdvanced" {
		t.Fatal("expected second sampling pass")
	}
	if got := prompt["21"].(map[string]any)["inputs"].(map[string]any)["samples"].([]any)[0]; got != "74" {
		t.Fatalf("decode source = %v, want second-pass latent", got)
	}
}

func TestBuildComfyMiniMaxDirectorPromptSplitsIntoFiveSecondGroups(t *testing.T) {
	prompt := buildComfyMiniMaxDirectorPrompt([]string{"subject.png"}, nil, nil, "test", 480, 864, 12, 42, "均衡二采")
	for _, id := range []string{"100", "101", "102"} {
		if prompt[id].(map[string]any)["class_type"] != "MiniMaxH3DirectorGroupReferenceToVideo" {
			t.Fatalf("missing reference director group %s", id)
		}
	}
	combine := prompt["150"].(map[string]any)["inputs"].(map[string]any)
	if len(combine) != 3 {
		t.Fatalf("director groups = %d, want 3", len(combine))
	}
	if _, ok := prompt["152"]; !ok {
		t.Fatal("balanced profile must include Director Refine")
	}
}

func TestBuildComfyMiniMaxDirectorPromptUsesPerSegmentPrompts(t *testing.T) {
	text := "shot one" + miniMaxDirectorSegmentMark + "shot two" + miniMaxDirectorSegmentMark + "shot three"
	prompt := buildComfyMiniMaxDirectorPrompt([]string{"subject.png"}, nil, nil, text, 768, 1344, 15, 42, "极速")
	for i, want := range []string{"shot one", "shot two", "shot three"} {
		id := fmt.Sprint(100 + i)
		got := prompt[id].(map[string]any)["inputs"].(map[string]any)["prompt"]
		if got != want {
			t.Fatalf("segment %d prompt = %v, want %q", i, got, want)
		}
	}
	director := prompt["153"].(map[string]any)["inputs"].(map[string]any)
	if director["global_prompt"] != "" {
		t.Fatalf("global prompt = %v, want empty for per-segment payload", director["global_prompt"])
	}
}

func TestBuildComfyMiniMaxDirectorPromptSupportsDirectedDurations(t *testing.T) {
	text := "[H3_DURATION=4S] establish" + miniMaxDirectorSegmentMark +
		"[H3_DURATION=7S] dialogue" + miniMaxDirectorSegmentMark +
		"[H3_DURATION=4S] exit"
	prompt := buildComfyMiniMaxDirectorPrompt([]string{"subject.png"}, nil, nil, text, 768, 1344, 15, 42, "极速")
	for i, want := range []float64{4, 7, 4} {
		id := fmt.Sprint(100 + i)
		inputs := prompt[id].(map[string]any)["inputs"].(map[string]any)
		if got := inputs["duration_sec"]; got != want {
			t.Fatalf("segment %d duration = %v, want %v", i, got, want)
		}
		if strings.Contains(inputs["prompt"].(string), "H3_DURATION") {
			t.Fatalf("segment %d leaked duration control into model prompt", i)
		}
	}
}

func TestBuildComfyMiniMaxDirectorPromptUsesSharedDirectorReferencesAndVideoOnlyContinuity(t *testing.T) {
	text := miniMaxDirectorCommonPrefix + " shared identity and cemetery" + miniMaxDirectorSegmentMark +
		"[H3_DURATION=5S] shot one" + miniMaxDirectorSegmentMark +
		"[H3_DURATION=5S] shot two" + miniMaxDirectorSegmentMark +
		"[H3_DURATION=5S] shot three"
	prompt := buildComfyMiniMaxDirectorPrompt([]string{"fang.png", "cemetery.png"}, nil, nil, text, 768, 1344, 15, 42, "极速")

	for i := 0; i < 3; i++ {
		inputs := prompt[fmt.Sprint(100+i)].(map[string]any)["inputs"].(map[string]any)
		if _, duplicated := inputs["ref_images.ref_image_0"]; duplicated {
			t.Fatalf("segment %d duplicated a shared reference", i)
		}
	}
	director := prompt["153"].(map[string]any)["inputs"].(map[string]any)
	var timeline map[string]any
	if err := json.Unmarshal([]byte(director["timeline_data"].(string)), &timeline); err != nil {
		t.Fatal(err)
	}
	global := timeline["global"].(map[string]any)
	if global["commonEnabled"] != true || global["prompt"] != "shared identity and cemetery" {
		t.Fatalf("unexpected common director settings: %#v", global)
	}
	if got := len(global["refs"].([]any)); got != 2 {
		t.Fatalf("shared refs = %d, want 2", got)
	}
	output := timeline["output"].(map[string]any)
	if output["continuityEnabled"] != true || output["continuityAudioEnabled"] != false {
		t.Fatalf("unexpected continuity settings: %#v", output)
	}
}

func TestBuildComfyMiniMaxDirectorPromptMapsReferencesPerSegment(t *testing.T) {
	text := miniMaxDirectorCommonPrefix + " shared visual rules" + miniMaxDirectorSegmentMark +
		"[H3_REFS=0,2]\n[H3_DURATION=5S] shot one" + miniMaxDirectorSegmentMark +
		"[H3_REFS=1,2]\n[H3_DURATION=5S] shot two"
	prompt := buildComfyMiniMaxDirectorPrompt(
		[]string{"person-a.png", "person-b.png", "scene.png"}, nil, nil,
		text, 768, 1344, 10, 42, "极速",
	)

	first := prompt["100"].(map[string]any)["inputs"].(map[string]any)
	second := prompt["101"].(map[string]any)["inputs"].(map[string]any)
	if got := first["ref_images.ref_image_0"].([]any)[0]; got != "1" {
		t.Fatalf("first segment Picture 1 source = %v, want node 1", got)
	}
	if got := first["ref_images.ref_image_1"].([]any)[0]; got != "3" {
		t.Fatalf("first segment Picture 2 source = %v, want node 3", got)
	}
	if got := second["ref_images.ref_image_0"].([]any)[0]; got != "2" {
		t.Fatalf("second segment Picture 1 source = %v, want node 2", got)
	}
	if got := second["ref_images.ref_image_1"].([]any)[0]; got != "3" {
		t.Fatalf("second segment Picture 2 source = %v, want node 3", got)
	}
	if strings.Contains(first["prompt"].(string), "H3_REFS") {
		t.Fatal("reference control marker leaked into model prompt")
	}
	director := prompt["153"].(map[string]any)["inputs"].(map[string]any)
	var timeline map[string]any
	if err := json.Unmarshal([]byte(director["timeline_data"].(string)), &timeline); err != nil {
		t.Fatal(err)
	}
	if got := len(timeline["global"].(map[string]any)["refs"].([]any)); got != 0 {
		t.Fatalf("global refs = %d, want zero when groups map their own assets", got)
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
