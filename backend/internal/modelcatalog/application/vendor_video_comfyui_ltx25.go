package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
)

const comfyLTX25Model = "ltx-2.5-distilled-av-local"

func isComfyLTX25Provider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil && strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") && strings.EqualFold(strings.TrimSpace(model), comfyLTX25Model)
}

func (s *Service) generateVideoComfyLTX25(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "LTX-2.5 prompt is required")
	}
	if len(req.ReferenceImages) > 6 {
		return nil, apperror.New(apperror.CodeInvalidInput, "LTX-2.5 最多支持 6 张参考图")
	}

	images := make([]string, 0, len(req.ReferenceImages))
	for i, reference := range req.ReferenceImages {
		image, err := uploadComfyReference(ctx, baseURL, reference, i+1)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("第 %d 张参考图上传到 ComfyUI 失败", i+1), err)
		}
		images = append(images, image)
	}

	duration := req.Duration
	if duration == 0 {
		duration = 5
	}
	if duration < 3 || duration > 15 {
		return nil, apperror.New(apperror.CodeInvalidInput, "LTX-2.5 时长必须在 3 到 15 秒之间")
	}
	seed := int64(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = int64(*req.Seed)
	}
	width, height := comfyLTX25Dimensions(req.AspectRatio, req.Resolution)
	prompt := buildComfyLTX25Prompt(images, req.Prompt, width, height, duration*24+1, seed, normalizeLTX25Quality(req.Quality))
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build ComfyUI LTX-2.5 request", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "ComfyUI LTX-2.5 submission failed", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI rejected LTX-2.5 prompt (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI returned no prompt_id for LTX-2.5")
	}
	return pollComfyVideoResult(ctx, baseURL, queued.PromptID, "41", "LTX-2.5")
}

func comfyLTX25Dimensions(ratio, resolution string) (int, int) {
	high := strings.EqualFold(strings.TrimSpace(resolution), "720p")
	switch strings.TrimSpace(ratio) {
	case "9:16":
		if high {
			return 704, 1280
		}
		return 512, 896
	case "1:1":
		if high {
			return 1024, 1024
		}
		return 768, 768
	default:
		if high {
			return 1280, 704
		}
		return 896, 512
	}
}

func ltx25KeyframeIndices(count, length int) []int {
	if count <= 0 {
		return nil
	}
	if count == 1 {
		return []int{0}
	}
	last := max(0, length-1)
	indices := make([]int, count)
	for i := range count {
		if i == count-1 {
			indices[i] = last
			continue
		}
		raw := float64(i*last) / float64(count-1)
		indices[i] = min(last, int(math.Round(raw/8.0))*8)
	}
	return indices
}

func normalizeLTX25Quality(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "fast", "极速":
		return "fast"
	case "high", "high-quality", "高质量":
		return "high"
	default:
		return "standard"
	}
}

func buildComfyLTX25Prompt(images []string, text string, width, height, length int, seed int64, quality string) map[string]any {
	quality = normalizeLTX25Quality(quality)
	nodes := map[string]any{
		"10": map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "weight_dtype": "default"}},
		"11": map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "type": "ltxv", "device": "default"}},
		"12": map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "ltx-2.5-video-vae-bf16.safetensors"}},
		"13": map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "ltx-2.5-audio-vae-bf16.safetensors"}},
		"14": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"clip": []any{"11", 0}, "text": text}},
		"15": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"clip": []any{"11", 0}, "text": "pc game, console game, video game, cartoon, childish, ugly, low quality, blurry, distorted"}},
		"16": map[string]any{"class_type": "LTXVConditioning", "inputs": map[string]any{"positive": []any{"14", 0}, "negative": []any{"15", 0}, "frame_rate": 24.0}},
		"17": map[string]any{"class_type": "EmptyLTXVLatentVideo", "inputs": map[string]any{"width": width / 2, "height": height / 2, "length": length, "batch_size": 1}},
		"20": map[string]any{"class_type": "LTXVEmptyLatentAudio", "inputs": map[string]any{"frames_number": length, "frame_rate": 24.0, "batch_size": 1, "audio_vae": []any{"13", 0}}},
		"21": map[string]any{"class_type": "LTXVConcatAVLatent", "inputs": map[string]any{"video_latent": []any{"17", 0}, "audio_latent": []any{"20", 0}}},
		"22": map[string]any{"class_type": "RandomNoise", "inputs": map[string]any{"noise_seed": seed}},
		"23": map[string]any{"class_type": "LTXVDualCFGGuider", "inputs": map[string]any{"model": []any{"10", 0}, "positive": []any{"16", 0}, "negative": []any{"16", 1}, "video_cfg": 1.0, "audio_cfg": 1.0}},
		"24": map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "euler_ancestral"}},
		"25": map[string]any{"class_type": "ManualSigmas", "inputs": map[string]any{"sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
		"26": map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"22", 0}, "guider": []any{"23", 0}, "sampler": []any{"24", 0}, "sigmas": []any{"25", 0}, "latent_image": []any{"21", 0}}},
		"27": map[string]any{"class_type": "LTXVSeparateAVLatent", "inputs": map[string]any{"av_latent": []any{"26", 0}}},
		"28": map[string]any{"class_type": "LatentUpscaleModelLoader", "inputs": map[string]any{"model_name": "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"}},
		"29": map[string]any{"class_type": "LTXVLatentUpsampler", "inputs": map[string]any{"samples": []any{"43", 2}, "upscale_model": []any{"28", 0}, "vae": []any{"12", 0}}},
		"31": map[string]any{"class_type": "LTXVConcatAVLatent", "inputs": map[string]any{"video_latent": []any{"29", 0}, "audio_latent": []any{"27", 1}}},
		"32": map[string]any{"class_type": "RandomNoise", "inputs": map[string]any{"noise_seed": seed + 1}},
		"33": map[string]any{"class_type": "LTXVDualCFGGuider", "inputs": map[string]any{"model": []any{"10", 0}, "positive": []any{"16", 0}, "negative": []any{"16", 1}, "video_cfg": 1.0, "audio_cfg": 1.0}},
		"34": map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "euler_ancestral"}},
		"35": map[string]any{"class_type": "ManualSigmas", "inputs": map[string]any{"sigmas": "0.85, 0.7250, 0.4219, 0.0"}},
		"36": map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"32", 0}, "guider": []any{"33", 0}, "sampler": []any{"34", 0}, "sigmas": []any{"35", 0}, "latent_image": []any{"31", 0}}},
		"37": map[string]any{"class_type": "LTXVSeparateAVLatent", "inputs": map[string]any{"av_latent": []any{"36", 0}}},
		"38": map[string]any{"class_type": "VAEDecodeTiled", "inputs": map[string]any{"samples": []any{"44", 2}, "vae": []any{"12", 0}, "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 16}},
		"39": map[string]any{"class_type": "LTXVAudioVAEDecode", "inputs": map[string]any{"samples": []any{"37", 1}, "audio_vae": []any{"13", 0}}},
		"40": map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"38", 0}, "audio": []any{"39", 0}, "fps": 24.0, "bit_depth": 8}},
		"41": map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"40", 0}, "filename_prefix": "video/ccy-canvas/LTX_2.5", "format": "auto", "codec": "auto"}},
		"43": map[string]any{"class_type": "LTXVCropGuides", "inputs": map[string]any{"positive": []any{"16", 0}, "negative": []any{"16", 1}, "latent": []any{"27", 0}}},
		"44": map[string]any{"class_type": "LTXVCropGuides", "inputs": map[string]any{"positive": []any{"16", 0}, "negative": []any{"16", 1}, "latent": []any{"37", 0}}},
	}
	if quality == "fast" {
		// Preview mode keeps the distilled first pass and learned x2 latent
		// upscaler, but skips the expensive second diffusion pass entirely.
		// Output dimensions and synchronized audio remain unchanged.
		for _, id := range []string{"31", "32", "33", "34", "35", "36", "37", "44"} {
			delete(nodes, id)
		}
		nodes["38"].(map[string]any)["inputs"].(map[string]any)["samples"] = []any{"29", 0}
		nodes["39"].(map[string]any)["inputs"].(map[string]any)["samples"] = []any{"27", 1}
	}

	stage1Positive, stage1Negative, stage1Latent := []any{"16", 0}, []any{"16", 1}, []any{"17", 0}
	stage2Positive, stage2Negative, stage2Latent := []any{"16", 0}, []any{"16", 1}, []any{"29", 0}
	indices := ltx25KeyframeIndices(len(images), length)
	for i, image := range images {
		loadID := fmt.Sprintf("1%02d", i)
		preprocessID := fmt.Sprintf("2%02d", i)
		stage1GuideID := fmt.Sprintf("3%02d", i)
		stage2GuideID := fmt.Sprintf("4%02d", i)
		nodes[loadID] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": image}}
		nodes[preprocessID] = map[string]any{"class_type": "LTXVPreprocess", "inputs": map[string]any{"image": []any{loadID, 0}, "img_compression": 33}}
		nodes[stage1GuideID] = map[string]any{"class_type": "LTXVAddGuide", "inputs": map[string]any{
			"positive": stage1Positive, "negative": stage1Negative, "vae": []any{"12", 0}, "latent": stage1Latent,
			"image": []any{preprocessID, 0}, "frame_idx": indices[i], "strength": 0.7,
		}}
		stage1Positive, stage1Negative, stage1Latent = []any{stage1GuideID, 0}, []any{stage1GuideID, 1}, []any{stage1GuideID, 2}
		if quality == "high" {
			nodes[stage2GuideID] = map[string]any{"class_type": "LTXVAddGuide", "inputs": map[string]any{
				"positive": stage2Positive, "negative": stage2Negative, "vae": []any{"12", 0}, "latent": stage2Latent,
				"image": []any{preprocessID, 0}, "frame_idx": indices[i], "strength": 0.7,
			}}
			stage2Positive, stage2Negative, stage2Latent = []any{stage2GuideID, 0}, []any{stage2GuideID, 1}, []any{stage2GuideID, 2}
		}
	}
	nodes["21"].(map[string]any)["inputs"].(map[string]any)["video_latent"] = stage1Latent
	nodes["23"].(map[string]any)["inputs"].(map[string]any)["positive"] = stage1Positive
	nodes["23"].(map[string]any)["inputs"].(map[string]any)["negative"] = stage1Negative
	nodes["43"].(map[string]any)["inputs"].(map[string]any)["positive"] = stage1Positive
	nodes["43"].(map[string]any)["inputs"].(map[string]any)["negative"] = stage1Negative
	if quality != "fast" {
		nodes["31"].(map[string]any)["inputs"].(map[string]any)["video_latent"] = stage2Latent
		nodes["33"].(map[string]any)["inputs"].(map[string]any)["positive"] = stage2Positive
		nodes["33"].(map[string]any)["inputs"].(map[string]any)["negative"] = stage2Negative
		nodes["44"].(map[string]any)["inputs"].(map[string]any)["positive"] = stage2Positive
		nodes["44"].(map[string]any)["inputs"].(map[string]any)["negative"] = stage2Negative
	}
	return nodes
}
