package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestIsComfyCosyVoice3Provider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyCosyVoice3Provider(pc, "cosyvoice3-local") {
		t.Fatal("expected local CosyVoice3 provider to match")
	}
	if isComfyCosyVoice3Provider(pc, "speech-01") {
		t.Fatal("unexpected match for a different audio model")
	}
}

func TestBuildComfyCosyVoice3Prompt(t *testing.T) {
	prompt := buildComfyCosyVoice3Prompt("voice.wav", "你好，欢迎使用本地语音。", 1.15, 42)
	load := prompt["1"].(map[string]any)
	if load["class_type"] != "LoadAudio" {
		t.Fatalf("load class = %v", load["class_type"])
	}
	synthesis := prompt["3"].(map[string]any)
	if synthesis["class_type"] != "XB_CosyVoice3_ZeroShot" {
		t.Fatalf("synthesis class = %v", synthesis["class_type"])
	}
	inputs := synthesis["inputs"].(map[string]any)
	if inputs["text"] != "你好，欢迎使用本地语音。" || inputs["speed"] != 1.15 {
		t.Fatalf("unexpected synthesis inputs: %#v", inputs)
	}
	save := prompt["4"].(map[string]any)
	if save["class_type"] != "SaveAudioMP3" {
		t.Fatalf("save class = %v", save["class_type"])
	}
}

func TestBuildComfyStableAudio3SFXPrompt(t *testing.T) {
	prompt := buildComfyStableAudio3SFXPrompt("heavy rain and distant thunder", 8, 99)
	checkpoint := prompt["1"].(map[string]any)["inputs"].(map[string]any)
	if checkpoint["ckpt_name"] != "stable_audio_3_small_sfx.safetensors" {
		t.Fatalf("checkpoint inputs = %#v", checkpoint)
	}
	clip := prompt["2"].(map[string]any)["inputs"].(map[string]any)
	if clip["type"] != "stable_audio" {
		t.Fatalf("clip inputs = %#v", clip)
	}
	latent := prompt["5"].(map[string]any)["inputs"].(map[string]any)
	if latent["seconds"] != float64(8) {
		t.Fatalf("latent inputs = %#v", latent)
	}
	sampler := prompt["6"].(map[string]any)["inputs"].(map[string]any)
	if sampler["steps"] != 8 || sampler["cfg"] != 1.0 || sampler["seed"] != 99 {
		t.Fatalf("sampler inputs = %#v", sampler)
	}
	if prompt["8"].(map[string]any)["class_type"] != "SaveAudioMP3" {
		t.Fatal("expected MP3 output node")
	}
}

func TestIsComfyStableAudio3SFXProvider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyStableAudio3SFXProvider(pc, "stable-audio-3-small-sfx-local") {
		t.Fatal("expected local Stable Audio 3 SFX provider to match")
	}
	if isComfyStableAudio3SFXProvider(pc, "cosyvoice3-local") {
		t.Fatal("unexpected match for CosyVoice")
	}
}

func TestCosyVoiceNumberClampsSpeed(t *testing.T) {
	if got := cosyVoiceNumber(map[string]any{"speed": 3.0}, "speed", 1, .5, 2); got != 2 {
		t.Fatalf("speed = %v, want 2", got)
	}
	if got := cosyVoiceNumber(nil, "speed", 1, .5, 2); got != 1 {
		t.Fatalf("default speed = %v, want 1", got)
	}
}

func TestBuildComfyQwen3VoiceDesignPrompt(t *testing.T) {
	prompt := buildComfyQwen3VoiceDesignPrompt("欢迎回来", "年轻女声，温柔清晰", "Chinese", 7, .9, .95)
	node := prompt["1"].(map[string]any)
	if node["class_type"] != "CCY_Qwen3TTSVoiceDesign" {
		t.Fatalf("class = %v", node["class_type"])
	}
	inputs := node["inputs"].(map[string]any)
	if inputs["voice_description"] != "年轻女声，温柔清晰" || inputs["language"] != "Chinese" {
		t.Fatalf("inputs = %#v", inputs)
	}
	if prompt["2"].(map[string]any)["class_type"] != "SaveAudioMP3" {
		t.Fatal("expected MP3 output node")
	}
}

func TestIsComfyQwen3VoiceDesignProvider(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "ComfyUI"}
	if !isComfyQwen3VoiceDesignProvider(pc, "qwen3-tts-voice-design-local") {
		t.Fatal("expected local Qwen3-TTS VoiceDesign provider to match")
	}
}
