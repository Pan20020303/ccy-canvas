package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func miniMaxStartFrameInputs(t *testing.T, graph map[string]any, id, class string) map[string]any {
	t.Helper()
	node, ok := graph[id].(map[string]any)
	if !ok || node["class_type"] != class {
		t.Fatalf("node %s = %#v, want %s", id, graph[id], class)
	}
	return node["inputs"].(map[string]any)
}

func miniMaxStartFrameLink(t *testing.T, inputs map[string]any, field, node string, output int) {
	t.Helper()
	if want := []any{node, output}; !reflect.DeepEqual(inputs[field], want) {
		t.Fatalf("%s = %#v, want %#v", field, inputs[field], want)
	}
}

func TestMiniMaxStartFrameKeepsReferenceOrdinals(t *testing.T) {
	for _, count := range []int{1, 2, 9} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			images := make([]string, count)
			for i := range images {
				images[i] = fmt.Sprintf("picture%d.png", i+1)
			}
			graph := buildComfyMiniMaxPromptWithReferenceMode(images, []string{"motion.mp4"}, []string{"voice.wav"}, "test", 768, 1344, 124, 42, comfyMiniMaxAudioFirstQuality, "start_frame")
			conditioning := miniMaxStartFrameInputs(t, graph, "15", "MiniMaxH3ReferenceToVideo")
			for i, image := range images {
				id := fmt.Sprint(i + 1)
				if got := miniMaxStartFrameInputs(t, graph, id, "LoadImage")["image"]; got != image {
					t.Fatalf("image %d = %v, want %s", i, got, image)
				}
				miniMaxStartFrameLink(t, conditioning, fmt.Sprintf("ref_images.ref_image_%d", i), id, 0)
			}
			if _, exists := conditioning[fmt.Sprintf("ref_images.ref_image_%d", count)]; exists {
				t.Fatal("guide must not duplicate a reference image")
			}
			guide := miniMaxStartFrameInputs(t, graph, "95", "MiniMaxH3AddGuide")
			miniMaxStartFrameLink(t, guide, "image", "1", 0)
			miniMaxStartFrameLink(t, guide, "positive", "15", 0)
			miniMaxStartFrameLink(t, guide, "latent", "15", 1)
			miniMaxStartFrameLink(t, guide, "vae", "13", 0)
			if guide["frame_idx"] != 0 {
				t.Fatal("first-frame guide must start at frame zero")
			}
			for _, field := range []string{"audio", "audio_vae"} {
				if _, exists := guide[field]; exists {
					t.Fatalf("visual-only guide must not connect %s", field)
				}
			}
			miniMaxStartFrameLink(t, conditioning, "ref_videos.ref_video_0", "31", 0)
			miniMaxStartFrameLink(t, conditioning, "ref_video_audios.ref_video_audio_0", "31", 1)
			miniMaxStartFrameLink(t, conditioning, "ref_audios.ref_audio_0", "40", 0)
		})
	}
}

func TestMiniMaxStartFrameAudioFirstKeepsIndependentAudioAndMask(t *testing.T) {
	for seconds := 3; seconds <= 10; seconds++ {
		t.Run(fmt.Sprint(seconds), func(t *testing.T) {
			length := validMiniMaxFrameCount(seconds)
			graph := buildComfyMiniMaxPromptWithReferenceMode([]string{"tail.png", "actor.png", "scene.png"}, nil, nil, "test", 768, 1344, length, 42, comfyMiniMaxAudioFirstQuality, " START_FRAME ")
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "17", "BasicGuider"), "conditioning", "95", 0)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "82", "BasicGuider"), "conditioning", "15", 0)
			audioEmpty := miniMaxStartFrameInputs(t, graph, "80", "EmptyMiniMaxH3LatentAV")
			if audioEmpty["width"] != 32 || audioEmpty["height"] != 32 || audioEmpty["length"] != length {
				t.Fatalf("audio latent settings changed: %#v", audioEmpty)
			}
			if miniMaxStartFrameInputs(t, graph, "83", "BasicScheduler")["steps"] != 20 || miniMaxStartFrameInputs(t, graph, "19", "BasicScheduler")["steps"] != 8 {
				t.Fatal("audio must retain 20 steps and video 8 steps")
			}
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "20", "SamplerCustomAdvanced"), "latent_image", "93", 0)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "90", "LTXVSeparateAVLatent"), "av_latent", "84", 0)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "92", "SetLatentNoiseMask"), "samples", "90", 1)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "92", "SetLatentNoiseMask"), "mask", "91", 0)
			if miniMaxStartFrameInputs(t, graph, "91", "SolidMask")["value"] != 0.0 {
				t.Fatal("audio mask must stay locked")
			}
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "22", "VAEDecodeAudio"), "samples", "84", 0)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "23", "CreateVideo"), "audio", "22", 0)
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "85", "SaveAudio"), "audio", "22", 0)
			if _, err := json.Marshal(graph); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMiniMaxStartFramePreservesOtherProfilesAndRefinement(t *testing.T) {
	for _, quality := range []string{"极速", "官方8步", "均衡二采", "高质二采"} {
		t.Run(quality, func(t *testing.T) {
			graph := buildComfyMiniMaxPromptWithReferenceMode([]string{"tail.png"}, nil, nil, "test", 768, 1344, 124, 42, quality, "start_frame")
			miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "17", "BasicGuider"), "conditioning", "95", 0)
			if quality == "均衡二采" || quality == "高质二采" {
				miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "71", "BasicGuider"), "conditioning", "95", 0)
				miniMaxStartFrameLink(t, miniMaxStartFrameInputs(t, graph, "22", "VAEDecodeAudio"), "samples", "20", 0)
			}
		})
	}
}

func TestMiniMaxStartFrameLeavesSoftModesUnchanged(t *testing.T) {
	for _, mode := range []string{"", "auto", "image_reference", "three_view", "start_end", "text-to-video"} {
		for _, images := range [][]string{nil, {"actor.png", "scene.png"}} {
			got := buildComfyMiniMaxPromptWithReferenceMode(images, nil, nil, "test", 768, 1344, 124, 42, comfyMiniMaxAudioFirstQuality, mode)
			want := buildComfyMiniMaxPrompt(images, nil, nil, "test", 768, 1344, 124, 42, comfyMiniMaxAudioFirstQuality)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("mode %q changed the existing graph", mode)
			}
		}
	}
}

func TestMiniMaxStartFrameRejectsMissingGuideBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "must not make an upload or submission", http.StatusInternalServerError)
	}))
	defer server.Close()
	for _, images := range [][]string{nil, {""}, {"  ", "actor.png"}} {
		req := GenerateRequest{Model: comfyMiniMaxH3Model, Prompt: "test", ReferenceMode: "start_frame", ReferenceImages: images}
		_, err := (&Service{}).generateVideoComfyMiniMaxH3(context.Background(), server.URL, req)
		if err == nil || !strings.Contains(err.Error(), "start_frame requires") {
			t.Fatalf("missing guide error = %v", err)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("made %d HTTP calls before rejecting missing guide", calls.Load())
	}
}

func TestMiniMaxStartFrameValidationDoesNotChangeDirector(t *testing.T) {
	for _, req := range []GenerateRequest{
		{Model: comfyMiniMaxH3DirectorModel, ReferenceMode: "start_frame"},
		{Model: comfyMiniMaxH3Model, ReferenceMode: "image_reference"},
		{Model: comfyMiniMaxH3Model, ReferenceMode: "start_frame", ReferenceImages: []string{"tail.png"}},
	} {
		if err := validateComfyMiniMaxStartFrame(req); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMiniMaxStartFrameSubmittedGraphUsesUploadedFirstImage(t *testing.T) {
	// A local fake server captures serialization only; no ComfyUI server or GPU
	// is contacted and the deliberate prompt rejection prevents result polling.
	for _, model := range []string{comfyMiniMaxH3Model, comfyMiniMaxH3DirectorModel} {
		t.Run(model, func(t *testing.T) {
			captured := make(chan map[string]any, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/upload/image":
					file, header, err := r.FormFile("image")
					if err != nil {
						http.Error(w, err.Error(), http.StatusBadRequest)
						return
					}
					_ = file.Close()
					if r.MultipartForm != nil {
						defer r.MultipartForm.RemoveAll()
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"name": header.Filename, "subfolder": "guide-test"})
				case "/prompt":
					var body struct {
						Prompt map[string]any `json:"prompt"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						http.Error(w, err.Error(), http.StatusBadRequest)
						return
					}
					captured <- body.Prompt
					http.Error(w, "test-capture-only", http.StatusBadRequest)
				default:
					http.Error(w, "unexpected endpoint", http.StatusNotFound)
				}
			}))
			defer server.Close()
			pixel := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII="
			req := GenerateRequest{Model: model, Prompt: "test", Quality: comfyMiniMaxAudioFirstQuality, ReferenceMode: "start_frame", ReferenceImages: []string{pixel, pixel, pixel}, AspectRatio: "9:16", Resolution: "768p", Duration: 5}
			_, err := (&Service{}).generateVideoComfyMiniMaxH3(context.Background(), server.URL, req)
			if err == nil || !strings.Contains(err.Error(), "test-capture-only") {
				t.Fatalf("capture result = %v", err)
			}
			var graph map[string]any
			select {
			case graph = <-captured:
			default:
				t.Fatal("no submitted graph was captured")
			}
			if model == comfyMiniMaxH3DirectorModel {
				if _, exists := graph["95"]; exists {
					t.Fatal("Director graph must not use the ordinary H3 guide")
				}
				return
			}
			guide := miniMaxStartFrameInputs(t, graph, "95", "MiniMaxH3AddGuide")
			if got := guide["image"].([]any)[0]; got != "1" {
				t.Fatalf("submitted guide image node = %v", got)
			}
			for i := 1; i <= 3; i++ {
				id := fmt.Sprint(i)
				got := miniMaxStartFrameInputs(t, graph, id, "LoadImage")["image"]
				if want := fmt.Sprintf("guide-test/ccy_ref_%02d.png", i); got != want {
					t.Fatalf("uploaded image node %s = %v, want %s", id, got, want)
				}
			}
		})
	}
}
