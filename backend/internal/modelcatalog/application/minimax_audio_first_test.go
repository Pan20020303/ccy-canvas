package application

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMiniMaxAudioFirstSeparatesSamplingAndRetainsSoundtrack(t *testing.T) {
	for _, refs := range [][]string{nil, {"person.png", "scene.png"}, {"1.png", "2.png", "3.png", "4.png", "5.png", "6.png", "7.png", "8.png", "9.png"}} {
		graph := buildComfyMiniMaxPrompt(refs, []string{"motion.mp4"}, []string{"voice.wav"}, "test", 768, 1344, 124, 42, comfyMiniMaxAudioFirstQuality)
		inputs := func(id string) map[string]any { return graph[id].(map[string]any)["inputs"].(map[string]any) }
		wantLinks := map[string]map[string][]any{
			"81": {"model": {"25", 0}}, // Base attention patch, before Turbo LoRA.
			"82": {"conditioning": {"15", 0}},
			"84": {"latent_image": {"80", 0}, "guider": {"82", 0}, "sigmas": {"83", 0}},
			"90": {"av_latent": {"84", 0}},
			"92": {"samples": {"90", 1}, "mask": {"91", 0}},
			"93": {"video_latent": {"15", 1}, "audio_latent": {"92", 0}},
			"20": {"latent_image": {"93", 0}},
			"22": {"samples": {"84", 0}}, // Never decode the Turbo pass's audio.
			"23": {"audio": {"22", 0}, "images": {"21", 0}},
			"85": {"audio": {"22", 0}},
		}
		for id, fields := range wantLinks {
			for field, want := range fields {
				if got := inputs(id)[field]; !reflect.DeepEqual(got, want) {
					t.Fatalf("node %s.%s = %v, want %v", id, field, got, want)
				}
			}
		}
		if inputs("80")["length"] != inputs("15")["length"] {
			t.Fatal("audio/video must share a frame grid to avoid an unlocked padded audio tail")
		}
		if inputs("91")["value"] != 0.0 || inputs("83")["steps"] != 20 || inputs("19")["steps"] != 8 {
			t.Fatal("expected locked audio with separate 20/8-step schedules")
		}
		for i := range refs {
			if inputs("15")["ref_images.ref_image_"+string(rune('0'+i))] == nil {
				t.Fatal("lost reference mapping")
			}
		}
		if inputs("15")["ref_videos.ref_video_0"] == nil || inputs("15")["ref_audios.ref_audio_0"] == nil {
			t.Fatal("lost AV references")
		}
	}
}

func TestMiniMaxVisualRefineKeepsOriginalAudio(t *testing.T) {
	for _, profile := range []string{"均衡二采", "高质二采"} {
		graph := buildComfyMiniMaxPrompt(nil, nil, nil, "test", 864, 480, 124, 42, profile)
		inputs := func(id string) map[string]any { return graph[id].(map[string]any)["inputs"].(map[string]any) }
		for id, want := range map[string][]any{"21": {"74", 0}, "22": {"20", 0}} {
			if !reflect.DeepEqual(inputs(id)["samples"], want) {
				t.Fatalf("%s: decode node %s should use %v", profile, id, want)
			}
		}
		if !reflect.DeepEqual(inputs("74")["latent_image"], []any{"93", 0}) || inputs("91")["value"] != 0.0 {
			t.Fatal("visual refine must hold audio fixed during sampling as well as muxing")
		}
	}
}

// Optional export uses the production builder, keeping smoke tests and saved
// API workflows identical to the graph dispatched by CCY. It never submits jobs.
func TestExportMiniMaxAudioFirstWorkflows(t *testing.T) {
	dir := os.Getenv("CCY_H3_WORKFLOW_EXPORT_DIR")
	if dir == "" {
		t.Skip("set CCY_H3_WORKFLOW_EXPORT_DIR to export API workflow examples")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	prompt := "A five-second realistic shot of one adult Chinese woman wearing a blue cotton shirt in a quiet courtyard. Fixed medium close-up, soft overcast daylight. She looks toward a friend beside the camera and calmly says in Mandarin: <d>别着急，我马上就来。</d> After speaking she closes her mouth and gives a small nod. Only this sentence is spoken. Gentle breeze and faint leaf rustling continue throughout, including before and after speech. No narration, no music, no subtitles."
	for name, quality := range map[string]string{"audio-first": comfyMiniMaxAudioFirstQuality, "baseline": "官方8步"} {
		graph := buildComfyMiniMaxPrompt(nil, nil, nil, prompt, 480, 864, 124, 20260907, quality)
		data, err := json.MarshalIndent(graph, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
}
