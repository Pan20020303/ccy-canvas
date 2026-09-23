package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"

	"github.com/google/uuid"
)

const (
	comfyMiniMaxH3Model           = "minimax-h3-t2v-ref2v-turbo-local"
	comfyMiniMaxH3LegacyModel     = "minimax-h3-ref2v-9ref-turbo-local"
	comfyMiniMaxH3DirectorModel   = "minimax-h3-director-local"
	comfyMiniMaxH3U09RedrawModel  = "minimax-h3-u09-redraw-dual-fast-local"
	comfyMiniMaxH3U09NoCodecModel = "minimax-h3-u09-no-codec-dual-upscale-local"
	comfyMiniMaxH3DramaModel      = "minimax-h3-drama-workbench-local"
	comfyMiniMaxAudioFirstQuality = "音画分采8步"
	miniMaxDirectorSegmentMark    = "\n--- H3 SEGMENT ---\n"
	miniMaxDirectorCommonPrefix   = "[H3_COMMON]"
	miniMaxDirectorRefsPrefix     = "[H3_REFS="
)

const defaultComfyVideoQueueWait = 12 * time.Hour

func comfyVideoQueueWaitTimeout() time.Duration {
	if value := strings.TrimSpace(os.Getenv("VIDEO_TASK_MAX_QUEUE_SECONDS")); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
	}
	return defaultComfyVideoQueueWait
}

func isComfyQueuedVideoRequest(req GenerateRequest) bool {
	if !strings.EqualFold(strings.TrimSpace(req.ServiceType), "video") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(req.Model)) {
	case comfyMiniMaxH3Model, comfyMiniMaxH3LegacyModel, comfyMiniMaxH3DirectorModel,
		comfyMiniMaxH3U09RedrawModel, comfyMiniMaxH3U09NoCodecModel, comfyMiniMaxH3DramaModel,
		comfyLTX25Model, "wan-animate-2-motion-local":
		return true
	default:
		return false
	}
}

func isComfyMiniMaxH3Provider(pc *domain.ProviderConfig, model string) bool {
	model = strings.TrimSpace(model)
	if pc == nil || !isComfyMiniMaxH3Model(model) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI")
}

func isComfyMiniMaxH3Model(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case comfyMiniMaxH3Model, comfyMiniMaxH3LegacyModel, comfyMiniMaxH3DirectorModel,
		comfyMiniMaxH3U09RedrawModel, comfyMiniMaxH3U09NoCodecModel, comfyMiniMaxH3DramaModel:
		return true
	default:
		return false
	}
}

func isComfyMiniMaxH3LongRunningModel(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case comfyMiniMaxH3DirectorModel, comfyMiniMaxH3U09RedrawModel,
		comfyMiniMaxH3U09NoCodecModel, comfyMiniMaxH3DramaModel:
		return true
	default:
		return false
	}
}

func (s *Service) generateVideoComfyMiniMaxH3(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 prompt is required")
	}
	if len(req.ReferenceImages) > 9 {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 supports zero to nine reference images")
	}
	if err := validateComfyMiniMaxStartFrame(req); err != nil {
		return nil, err
	}
	videoRefs := append([]string{}, req.ReferenceVideos...)
	if strings.TrimSpace(req.ReferenceVideo) != "" {
		videoRefs = append([]string{req.ReferenceVideo}, videoRefs...)
	}
	audioRefs := append([]string{}, req.ReferenceAudios...)
	if strings.TrimSpace(req.ReferenceAudio) != "" {
		audioRefs = append([]string{req.ReferenceAudio}, audioRefs...)
	}
	if len(videoRefs) > 3 {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 supports up to three reference videos")
	}
	if len(audioRefs) > 3 {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 supports up to three reference audios")
	}

	uploaded := make([]string, 0, len(req.ReferenceImages))
	for i, raw := range req.ReferenceImages {
		name, err := uploadComfyReference(ctx, baseURL, raw, i+1)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 上传到 ComfyUI 失败", i+1), err)
		}
		uploaded = append(uploaded, name)
	}
	uploadedVideos := make([]string, 0, len(videoRefs))
	for i, raw := range videoRefs {
		name, err := uploadComfyReference(ctx, baseURL, raw, 20+i)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考视频 #%d 上传到 ComfyUI 失败", i+1), err)
		}
		uploadedVideos = append(uploadedVideos, name)
	}
	uploadedAudios := make([]string, 0, len(audioRefs))
	for i, raw := range audioRefs {
		name, err := uploadComfyReference(ctx, baseURL, raw, 30+i)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考音频 #%d 上传到 ComfyUI 失败", i+1), err)
		}
		uploadedAudios = append(uploadedAudios, name)
	}

	width, height := comfyMiniMaxDimensions(req.AspectRatio, req.Resolution)
	duration := req.Duration
	if duration <= 0 {
		if strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DirectorModel) || strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DramaModel) {
			duration = 30
		} else {
			duration = 3
		}
	}
	if (strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DirectorModel) || strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DramaModel)) && duration > 120 {
		duration = 120
	} else if !strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DirectorModel) && duration > 15 {
		duration = 15
	}
	seed := int64(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = int64(*req.Seed)
	}
	promptText := req.Prompt
	if strings.EqualFold(strings.TrimSpace(req.ReferenceMode), "three_view") {
		promptText = "Analyze the supplied character three-view reference first. Treat a single sheet as front, side, and back panels; when three images are supplied, interpret them in front, side, back order. Preserve the same identity, clothing, proportions, and design from every camera angle.\n\n" + promptText
	}
	outputNode := "24"
	modelName := "MiniMax H3"
	var prompt map[string]any
	if strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DirectorModel) || strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DramaModel) {
		prompt = buildComfyMiniMaxDirectorPrompt(uploaded, uploadedVideos, uploadedAudios, promptText, width, height, duration, seed, req.Quality)
		outputNode = "190"
		if strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DramaModel) {
			modelName = "MiniMax H3 Drama Workbench"
		} else {
			modelName = "MiniMax H3 Director"
		}
	} else if strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3U09RedrawModel) || strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3U09NoCodecModel) {
		prompt = buildComfyMiniMaxU09Prompt(uploaded, uploadedVideos, uploadedAudios, promptText, width, height, validMiniMaxFrameCount(duration), seed, req.Quality, req.Model)
		modelName = "MiniMax H3 U09 Dual-stage"
	} else {
		prompt = buildComfyMiniMaxPromptWithReferenceMode(uploaded, uploadedVideos, uploadedAudios, promptText, width, height, validMiniMaxFrameCount(duration), seed, req.Quality, req.ReferenceMode)
	}
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build ComfyUI prompt request", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "ComfyUI prompt submission failed", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI rejected prompt (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
		Error    any    `json:"error"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI returned no prompt_id: %s", string(responseBody[:min(len(responseBody), 800)])))
	}
	return pollComfyVideoResult(ctx, baseURL, queued.PromptID, outputNode, modelName, maxRuntimeForRequest(req), comfyVideoQueueWaitTimeout())
}

func comfyMiniMaxDimensions(ratio, resolution string) (int, int) {
	high := strings.EqualFold(strings.TrimSpace(resolution), "768p")
	switch strings.TrimSpace(ratio) {
	case "9:16":
		if high {
			return 768, 1344
		}
		return 480, 864
	case "1:1":
		if high {
			return 768, 768
		}
		return 640, 640
	default:
		if high {
			return 1344, 768
		}
		return 864, 480
	}
}

func validMiniMaxFrameCount(seconds int) int {
	frames := max(5, seconds*24)
	return frames + (5-frames%17)%17
}

func buildComfyMiniMaxPrompt(images, videos, audios []string, text string, width, height, length int, seed int64, quality string) map[string]any {
	nodes := map[string]any{}
	profile := strings.TrimSpace(quality)
	for i, image := range images {
		nodes[fmt.Sprint(i+1)] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": image}}
	}
	for i, video := range videos {
		loadID := fmt.Sprint(30 + i*2)
		componentsID := fmt.Sprint(31 + i*2)
		nodes[loadID] = map[string]any{"class_type": "LoadVideo", "inputs": map[string]any{"file": video}}
		nodes[componentsID] = map[string]any{"class_type": "GetVideoComponents", "inputs": map[string]any{"video": []any{loadID, 0}}}
	}
	for i, audio := range audios {
		nodes[fmt.Sprint(40+i)] = map[string]any{"class_type": "LoadAudio", "inputs": map[string]any{"audio": audio}}
	}
	modelNodeID := "25"
	clipName := "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
	if profile == "官方8步" || profile == comfyMiniMaxAudioFirstQuality {
		// Match the official MiniMax H3 reference workflow: full Ref2VA,
		// Comfy Kitchen attention, the official 8-step FL2V LoRA at 0.75,
		// and a beta/Euler sampling schedule. The memory-efficient Sage patch
		// from the supplied UI workflow is intentionally omitted because this
		// ComfyUI build does not register that API node.
		nodes["10"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax_h3_ref2va_int8_convrot.safetensors", "weight_dtype": "default"}}
		nodes["25"] = map[string]any{"class_type": "ModelAttentionBackend", "inputs": map[string]any{"model": []any{"10", 0}, "attention": "comfy kitchen attention"}}
		nodes["11"] = map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"25", 0}, "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "strength_model": 0.75}}
		modelNodeID = "11"
		clipName = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
	} else {
		nodes["10"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}}
		nodes["11"] = map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"10", 0}, "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}}
		// H3 video and audio use different sigma clocks. Applying these shifts
		// with the dual-clock Euler sampler stabilizes the legacy 4-step path.
		nodes["25"] = map[string]any{"class_type": "MiniMaxH3SigmaShift", "inputs": map[string]any{"model": []any{"11", 0}, "shift_video": 12.0, "shift_audio": 3.0}}
	}
	nodes["12"] = map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": clipName, "type": "minimax", "device": "default"}}
	nodes["13"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_video_vae_fp16.safetensors"}}
	nodes["14"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}}
	// A small reference set benefits substantially from H3's high-fidelity
	// reference encoder. Keep crowded boards on "match" to avoid multiplying
	// VRAM and encode time when several cast/scene references are present.
	refImageSize := "match"
	if len(images) > 0 && len(images) <= 3 && profile != "极速" && profile != comfyMiniMaxAudioFirstQuality {
		refImageSize = "max"
	}
	conditioning := map[string]any{"clip": []any{"12", 0}, "vae": []any{"13", 0}, "audio_vae": []any{"14", 0}, "prompt": text, "width": width, "height": height, "length": length, "ref_image_size": refImageSize}
	for i := range images {
		conditioning[fmt.Sprintf("ref_images.ref_image_%d", i)] = []any{fmt.Sprint(i + 1), 0}
	}
	for i := range videos {
		componentsID := fmt.Sprint(31 + i*2)
		conditioning[fmt.Sprintf("ref_videos.ref_video_%d", i)] = []any{componentsID, 0}
		conditioning[fmt.Sprintf("ref_video_audios.ref_video_audio_%d", i)] = []any{componentsID, 1}
	}
	for i := range audios {
		conditioning[fmt.Sprintf("ref_audios.ref_audio_%d", i)] = []any{fmt.Sprint(40 + i), 0}
	}
	nodes["15"] = map[string]any{"class_type": "MiniMaxH3ReferenceToVideo", "inputs": conditioning}
	nodes["16"] = map[string]any{"class_type": "RandomNoise", "inputs": map[string]any{"noise_seed": seed}}
	nodes["17"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{modelNodeID, 0}, "conditioning": []any{"15", 0}}}
	if profile == "官方8步" || profile == comfyMiniMaxAudioFirstQuality {
		nodes["18"] = map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "euler"}}
		nodes["19"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{modelNodeID, 0}, "scheduler": "beta", "steps": 8, "denoise": 1.0}}
	} else {
		nodes["18"] = map[string]any{"class_type": "MiniMaxH3DualClockEulerSampler", "inputs": map[string]any{}}
		nodes["19"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{modelNodeID, 0}, "scheduler": "simple", "steps": 4, "denoise": 1.0}}
	}
	nodes["20"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"16", 0}, "guider": []any{"17", 0}, "sampler": []any{"18", 0}, "sigmas": []any{"19", 0}, "latent_image": []any{"15", 1}}}
	finalLatent := []any{"20", 0}
	audioLatent := []any{"20", 0}
	if profile == comfyMiniMaxAudioFirstQuality {
		// Keep the reference conditioning and time grid identical in both passes.
		// The tiny visual latent is discarded; the base model spends 20 unaccelerated
		// steps on audio before the Turbo video pass receives that locked soundtrack.
		nodes["80"] = map[string]any{"class_type": "EmptyMiniMaxH3LatentAV", "inputs": map[string]any{"width": 32, "height": 32, "length": length}}
		nodes["81"] = map[string]any{"class_type": "MiniMaxH3SigmaShift", "inputs": map[string]any{"model": []any{"25", 0}, "shift_video": 12.0, "shift_audio": 3.0}}
		nodes["82"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{"81", 0}, "conditioning": []any{"15", 0}}}
		nodes["83"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"81", 0}, "scheduler": "simple", "steps": 20, "denoise": 1.0}}
		nodes["84"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"16", 0}, "guider": []any{"82", 0}, "sampler": []any{"18", 0}, "sigmas": []any{"83", 0}, "latent_image": []any{"80", 0}}}
		addComfyMiniMaxLockedAudio(nodes, []any{"15", 1}, []any{"84", 0})
		nodes["20"].(map[string]any)["inputs"].(map[string]any)["latent_image"] = []any{"93", 0}
		audioLatent = []any{"84", 0}
	}
	if profile == "均衡二采" || profile == "高质二采" {
		steps, denoise := 2, 0.18
		if profile == "高质二采" {
			steps, denoise = 4, 0.25
		}
		nodes["70"] = map[string]any{"class_type": "MiniMaxH3SigmaShift", "inputs": map[string]any{"model": []any{"10", 0}, "shift_video": 12.0, "shift_audio": 3.0}}
		nodes["71"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{"70", 0}, "conditioning": []any{"15", 0}}}
		nodes["72"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"70", 0}, "scheduler": "beta", "steps": steps, "denoise": denoise}}
		nodes["73"] = map[string]any{"class_type": "RandomNoise", "inputs": map[string]any{"noise_seed": seed + 1}}
		addComfyMiniMaxLockedAudio(nodes, []any{"20", 0}, []any{"20", 0})
		nodes["74"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"73", 0}, "guider": []any{"71", 0}, "sampler": []any{"18", 0}, "sigmas": []any{"72", 0}, "latent_image": []any{"93", 0}}}
		finalLatent = []any{"74", 0}
	}
	nodes["21"] = map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": finalLatent, "vae": []any{"13", 0}}}
	nodes["22"] = map[string]any{"class_type": "VAEDecodeAudio", "inputs": map[string]any{"samples": audioLatent, "vae": []any{"14", 0}}}
	if profile == comfyMiniMaxAudioFirstQuality {
		nodes["85"] = map[string]any{"class_type": "SaveAudio", "inputs": map[string]any{"audio": []any{"22", 0}, "filename_prefix": "audio/ccy-canvas/MiniMax_H3_AudioFirst"}}
	}
	nodes["23"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"21", 0}, "audio": []any{"22", 0}, "fps": 24.0, "bit_depth": 8}}
	nodes["24"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"23", 0}, "filename_prefix": "video/ccy-canvas/MiniMax_H3_T2V_Ref2V_Turbo", "format": "auto", "codec": "auto"}}
	return nodes
}

// buildComfyMiniMaxU09Prompt is the API form of the two U09 dual-model
// workflows installed with the desktop ComfyUI. Both variants keep the first
// pass audio untouched, upscale only the video latent, and use the compact
// W4A8 model for the low-denoise detail pass. This is important: resampling the
// joint AV latent is the source of the metallic/duplicated speech heard in the
// older two-pass graph.
func buildComfyMiniMaxU09Prompt(images, videos, audios []string, text string, width, height, length int, seed int64, quality, model string) map[string]any {
	nodes := map[string]any{}
	for i, image := range images {
		nodes[fmt.Sprint(i+1)] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": image}}
	}
	for i, video := range videos {
		loadID, componentsID := fmt.Sprint(30+i*2), fmt.Sprint(31+i*2)
		nodes[loadID] = map[string]any{"class_type": "LoadVideo", "inputs": map[string]any{"file": video}}
		nodes[componentsID] = map[string]any{"class_type": "GetVideoComponents", "inputs": map[string]any{"video": []any{loadID, 0}}}
	}
	for i, audio := range audios {
		nodes[fmt.Sprint(40+i)] = map[string]any{"class_type": "LoadAudio", "inputs": map[string]any{"audio": audio}}
	}

	noCodec := strings.EqualFold(strings.TrimSpace(model), comfyMiniMaxH3U09NoCodecModel)
	firstSteps, secondSteps := 8, 3
	upscaleMode := "target dimensions"
	upscaleInputs := map[string]any{
		"model_name": "minimax_h3_latent_upscaler_3d_bf16.safetensors",
		"mode":       upscaleMode, "mode.width": width, "mode.height": height,
		"align": 32, "enable_temporal_chunking": true, "force_unload": true,
		"device": "cuda", "precision": "bf16",
	}
	firstWidth, firstHeight := alignedMiniMaxDimensions(width, 0.80), alignedMiniMaxDimensions(height, 0.80)
	if noCodec {
		firstSteps = 20
		firstWidth, firstHeight = alignedMiniMaxDimensions(width, 1.0/1.5), alignedMiniMaxDimensions(height, 1.0/1.5)
		upscaleMode = "scale by multiplier"
		upscaleInputs["mode"] = upscaleMode
		delete(upscaleInputs, "mode.width")
		delete(upscaleInputs, "mode.height")
		upscaleInputs["mode.scale"] = 1.5
	}
	if strings.Contains(strings.TrimSpace(quality), "精细") {
		firstSteps += 4
		secondSteps++
	}

	nodes["50"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax/minimax_h3_ref2va_int8_convrot.safetensors", "weight_dtype": "default"}}
	nodes["51"] = map[string]any{"class_type": "LoraLoaderBypassModelOnly", "inputs": map[string]any{"model": []any{"50", 0}, "lora_name": "minimax/minimax_h3_turbo_4step_diffusion_model.safetensors", "strength_model": 0.65}}
	nodes["52"] = map[string]any{"class_type": "ModelAttentionBackend", "inputs": map[string]any{"model": []any{"51", 0}, "attention": "comfy kitchen attention"}}
	nodes["53"] = map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "type": "minimax", "device": "default"}}
	nodes["54"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}}
	nodes["55"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}}
	conditioning := map[string]any{"clip": []any{"53", 0}, "vae": []any{"54", 0}, "audio_vae": []any{"55", 0}, "prompt": text, "width": firstWidth, "height": firstHeight, "length": length, "ref_image_size": "max"}
	for i := range images {
		conditioning[fmt.Sprintf("ref_images.ref_image_%d", i)] = []any{fmt.Sprint(i + 1), 0}
	}
	for i := range videos {
		componentsID := fmt.Sprint(31 + i*2)
		conditioning[fmt.Sprintf("ref_videos.ref_video_%d", i)] = []any{componentsID, 0}
		conditioning[fmt.Sprintf("ref_video_audios.ref_video_audio_%d", i)] = []any{componentsID, 1}
	}
	for i := range audios {
		conditioning[fmt.Sprintf("ref_audios.ref_audio_%d", i)] = []any{fmt.Sprint(40 + i), 0}
	}
	nodes["56"] = map[string]any{"class_type": "MiniMaxH3ReferenceToVideo", "inputs": conditioning}
	nodes["57"] = map[string]any{"class_type": "RandomNoise", "inputs": map[string]any{"noise_seed": seed}}
	nodes["58"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{"52", 0}, "conditioning": []any{"56", 0}}}
	nodes["59"] = map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "euler"}}
	nodes["60"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"52", 0}, "scheduler": "beta", "steps": firstSteps, "denoise": 1.0}}
	firstSigmas := []any{"60", 0}
	if noCodec {
		nodes["61"] = map[string]any{"class_type": "H3SigmaRefiner", "inputs": map[string]any{"sigmas": firstSigmas, "extra_steps": 2, "start_at_sigma": 0.65, "end_at_sigma": 0.0, "spacing": "cosine"}}
		firstSigmas = []any{"61", 0}
	}
	nodes["62"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"57", 0}, "guider": []any{"58", 0}, "sampler": []any{"59", 0}, "sigmas": firstSigmas, "latent_image": []any{"56", 1}}}
	nodes["63"] = map[string]any{"class_type": "LTXVSeparateAVLatent", "inputs": map[string]any{"av_latent": []any{"62", 0}}}
	upscaleInputs["latent"] = []any{"63", 0}
	nodes["64"] = map[string]any{"class_type": "MinimaxH3LatentUpscaler3D", "inputs": upscaleInputs}
	nodes["65"] = map[string]any{"class_type": "LTXVConcatAVLatent", "inputs": map[string]any{"video_latent": []any{"64", 0}, "audio_latent": []any{"63", 1}}}

	nodes["70"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors", "weight_dtype": "default"}}
	nodes["71"] = map[string]any{"class_type": "ModelAttentionBackend", "inputs": map[string]any{"model": []any{"70", 0}, "attention": "comfy kitchen attention"}}
	nodes["72"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{"71", 0}, "conditioning": []any{"56", 0}}}
	nodes["73"] = map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "res_multistep"}}
	nodes["74"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"71", 0}, "scheduler": "beta", "steps": secondSteps, "denoise": 0.2}}
	secondSigmas := []any{"74", 0}
	if noCodec {
		nodes["75"] = map[string]any{"class_type": "H3SigmaRefiner", "inputs": map[string]any{"sigmas": secondSigmas, "extra_steps": 2, "start_at_sigma": 0.65, "end_at_sigma": 0.0, "spacing": "cosine"}}
		secondSigmas = []any{"75", 0}
	}
	nodes["76"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"57", 0}, "guider": []any{"72", 0}, "sampler": []any{"73", 0}, "sigmas": secondSigmas, "latent_image": []any{"65", 0}}}
	nodes["77"] = map[string]any{"class_type": "LTXVSeparateAVLatent", "inputs": map[string]any{"av_latent": []any{"76", 0}}}
	nodes["78"] = map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"77", 0}, "vae": []any{"54", 0}}}
	nodes["79"] = map[string]any{"class_type": "VAEDecodeAudio", "inputs": map[string]any{"samples": []any{"63", 1}, "vae": []any{"55", 0}}}
	nodes["80"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"78", 0}, "audio": []any{"79", 0}, "fps": 24.0, "bit_depth": 8}}
	nodes["24"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"80", 0}, "filename_prefix": "video/ccy-canvas/MiniMax_H3_U09_DualStage", "format": "auto", "codec": "auto"}}
	return nodes
}

func alignedMiniMaxDimensions(value int, scale float64) int {
	return max(64, int(float64(value)*scale/32.0+0.5)*32)
}

func validateComfyMiniMaxStartFrame(req GenerateRequest) error {
	// The Director has its own continuity mechanism and is deliberately unchanged.
	if strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DirectorModel) || strings.EqualFold(strings.TrimSpace(req.Model), comfyMiniMaxH3DramaModel) || !strings.EqualFold(strings.TrimSpace(req.ReferenceMode), "start_frame") {
		return nil
	}
	if len(req.ReferenceImages) == 0 || strings.TrimSpace(req.ReferenceImages[0]) == "" {
		return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 start_frame requires the first reference image as a visual first-frame guide")
	}
	return nil
}

func buildComfyMiniMaxPromptWithReferenceMode(images, videos, audios []string, text string, width, height, length int, seed int64, quality, referenceMode string) map[string]any {
	if !strings.EqualFold(strings.TrimSpace(referenceMode), "start_frame") || len(images) == 0 {
		return buildComfyMiniMaxPrompt(images, videos, audios, text, width, height, length, seed, quality)
	}
	// API contract: image 0 remains <Picture 1> and also anchors frame zero. Keep
	// all reference ordinals identical to the canvas mentions and input array.
	nodes := buildComfyMiniMaxPrompt(images, videos, audios, text, width, height, length, seed, quality)
	nodes["95"] = map[string]any{"class_type": "MiniMaxH3AddGuide", "inputs": map[string]any{
		"positive": []any{"15", 0}, "latent": []any{"15", 1}, "vae": []any{"13", 0},
		"image": []any{"1", 0}, "frame_idx": 0,
	}}
	nodes["17"].(map[string]any)["inputs"].(map[string]any)["conditioning"] = []any{"95", 0}
	if refine, ok := nodes["71"].(map[string]any); ok {
		refine["inputs"].(map[string]any)["conditioning"] = []any{"95", 0}
	}
	// Audio-first guider 82 intentionally keeps conditioning 15. No guide audio
	// is connected, and the existing latent audio mask and original-audio mux stay
	// intact. The visual guide must not constrain the 32x32 audio-first latent.
	return nodes
}

func addComfyMiniMaxLockedAudio(nodes map[string]any, video, audio []any) {
	// These native AV nodes support H3 despite their historical LTXV names.
	nodes["90"] = map[string]any{"class_type": "LTXVSeparateAVLatent", "inputs": map[string]any{"av_latent": audio}}
	nodes["91"] = map[string]any{"class_type": "SolidMask", "inputs": map[string]any{"value": 0.0, "width": 1, "height": 1}}
	nodes["92"] = map[string]any{"class_type": "SetLatentNoiseMask", "inputs": map[string]any{"samples": []any{"90", 1}, "mask": []any{"91", 0}}}
	nodes["93"] = map[string]any{"class_type": "LTXVConcatAVLatent", "inputs": map[string]any{"video_latent": video, "audio_latent": []any{"92", 0}}}
}

func buildComfyMiniMaxDirectorPrompt(images, videos, audios []string, text string, width, height, duration int, seed int64, quality string) map[string]any {
	nodes := map[string]any{}
	commonPrompt, segmentText, hasCommonPrompt := splitMiniMaxDirectorCommonPrompt(text)
	for i, image := range images {
		nodes[fmt.Sprint(i+1)] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": image}}
	}
	for i, video := range videos {
		loadID, componentsID := fmt.Sprint(30+i*2), fmt.Sprint(31+i*2)
		nodes[loadID] = map[string]any{"class_type": "LoadVideo", "inputs": map[string]any{"file": video}}
		nodes[componentsID] = map[string]any{"class_type": "GetVideoComponents", "inputs": map[string]any{"video": []any{loadID, 0}}}
	}
	for i, audio := range audios {
		nodes[fmt.Sprint(40+i)] = map[string]any{"class_type": "LoadAudio", "inputs": map[string]any{"audio": audio}}
	}
	nodes["50"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}}
	nodes["51"] = map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"50", 0}, "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}}
	nodes["52"] = map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}}
	nodes["53"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_video_vae_fp16.safetensors"}}
	nodes["54"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}}

	segmentSeconds := 5
	segmentCount := max(1, (duration+segmentSeconds-1)/segmentSeconds)
	if markedCount := strings.Count(segmentText, miniMaxDirectorSegmentMark) + 1; markedCount > 1 {
		segmentCount = markedCount
	}
	segmentPrompts, hasSegmentPrompts := splitMiniMaxDirectorPrompts(segmentText, segmentCount)
	segmentRefIndices := make([][]int, segmentCount)
	hasPerSegmentRefs := false
	for i := range segmentPrompts {
		clean, indices, ok := parseMiniMaxDirectorSegmentRefs(segmentPrompts[i], len(images))
		if ok {
			segmentPrompts[i] = clean
			segmentRefIndices[i] = indices
			hasPerSegmentRefs = true
		}
	}
	segmentDurations := make([]int, segmentCount)
	for i := range segmentDurations {
		remaining := duration - i*segmentSeconds
		segmentDurations[i] = min(segmentSeconds, max(1, remaining))
	}
	if hasSegmentPrompts {
		parsedTotal, allParsed := 0, true
		for i := range segmentPrompts {
			clean, seconds, ok := parseMiniMaxDirectorSegmentDuration(segmentPrompts[i])
			if !ok {
				allParsed = false
				break
			}
			segmentPrompts[i] = clean
			segmentDurations[i] = seconds
			parsedTotal += seconds
		}
		if !allParsed || parsedTotal != duration {
			for i := range segmentDurations {
				remaining := duration - i*segmentSeconds
				segmentDurations[i] = min(segmentSeconds, max(1, remaining))
			}
		}
	}
	combineInputs := map[string]any{}
	for i := 0; i < segmentCount; i++ {
		groupID := fmt.Sprint(100 + i)
		clipDuration := segmentDurations[i]
		groupInputs := map[string]any{"prompt": segmentPrompts[i], "duration_sec": float64(clipDuration)}
		classType := "MiniMaxH3DirectorGroupReferenceToVideo"
		if hasPerSegmentRefs {
			for slot, imageIndex := range segmentRefIndices[i] {
				groupInputs[fmt.Sprintf("ref_images.ref_image_%d", slot)] = []any{fmt.Sprint(imageIndex + 1), 0}
			}
		} else if !hasCommonPrompt {
			for j := range images {
				groupInputs[fmt.Sprintf("ref_images.ref_image_%d", j)] = []any{fmt.Sprint(j + 1), 0}
			}
		}
		for j := range videos {
			componentsID := fmt.Sprint(31 + j*2)
			groupInputs[fmt.Sprintf("ref_videos.ref_video_%d", j)] = []any{componentsID, 0}
			groupInputs[fmt.Sprintf("ref_video_audios.ref_video_audio_%d", j)] = []any{componentsID, 1}
		}
		for j := range audios {
			groupInputs[fmt.Sprintf("ref_audios.ref_audio_%d", j)] = []any{fmt.Sprint(40 + j), 0}
		}
		nodes[groupID] = map[string]any{"class_type": classType, "inputs": groupInputs}
		combineInputs[fmt.Sprintf("groups.group_%d", i)] = []any{groupID, 0}
	}
	nodes["150"] = map[string]any{"class_type": "MiniMaxH3DirectorGroupsCombine", "inputs": combineInputs}

	globalPrompt := text
	if hasSegmentPrompts {
		// Each external R2V group already carries its complete shot prompt.
		// Keeping the joined payload as a global prompt would prepend all three
		// shots to every segment and defeat temporal continuity.
		globalPrompt = commonPrompt
	}
	globalRefs := make([]map[string]any, 0, len(images))
	if hasCommonPrompt && !hasPerSegmentRefs {
		for i, image := range images {
			globalRefs = append(globalRefs, map[string]any{"index": i, "imageFile": image})
		}
	}
	timelineJSON, _ := json.Marshal(map[string]any{
		"version":   5,
		"frameRate": 24,
		"output": map[string]any{
			"mode":                    "fixed",
			"width":                   width,
			"height":                  height,
			"audioMode":               "generate",
			"continuityEnabled":       true,
			"continuityOverlapFrames": 22,
			"continuityAudioEnabled":  false,
		},
		"global": map[string]any{
			"commonEnabled": hasCommonPrompt,
			"prompt":        commonPrompt,
			"refs":          globalRefs,
		},
	})
	directorInputs := map[string]any{
		"model": []any{"51", 0}, "video_vae": []any{"53", 0}, "audio_vae": []any{"54", 0}, "clip": []any{"52", 0},
		"task_type": "t2v — 文生视频(Text to Video)", "global_prompt": globalPrompt, "bd_grp_sample": "采样设置", "cfg": 1.0, "seed": seed,
		"frame_rate": 24.0, "width": width, "height": height, "ref_max_size": max(width, height), "total_frames": validMiniMaxFrameCount(duration), "timeline_data": string(timelineJSON),
		"bd_grp_advanced": "高级采样", "steps": 4, "sampler": "euler", "scheduler": "simple", "shift_video": 12.0, "shift_audio": 3.0,
		"bd_grp_perf": "性能", "clear_vram_between_segments": true, "export_source_images": false,
	}
	directorInputs["task_type"] = "r2v — 参考主体生视频(Reference to Video)"
	directorInputs["r2v_groups"] = []any{"150", 0}
	if strings.TrimSpace(quality) == "均衡二采" || strings.TrimSpace(quality) == "高质二采" {
		steps, denoise := 2, 0.18
		if strings.TrimSpace(quality) == "高质二采" {
			steps, denoise = 4, 0.25
		}
		nodes["151"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"50", 0}, "scheduler": "beta", "steps": steps, "denoise": denoise}}
		nodes["152"] = map[string]any{"class_type": "MiniMaxH3DirectorRefine", "inputs": map[string]any{"mode": "refine", "upscale_method": "lanczos", "latent_upscale_model": "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", "sampler": "euler", "passes": 1, "refine_model": []any{"50", 0}, "sigmas": []any{"151", 0}, "seed_mode": "inherit", "aspect_ratio": "跟随导演台", "megapixels": 1.0, "width": width, "height": height, "skip_fl2v": true, "confirm_first_pass": false}}
		directorInputs["refine"] = []any{"152", 0}
	}
	nodes["153"] = map[string]any{"class_type": "MiniMaxH3Director", "inputs": directorInputs}
	nodes["154"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"153", 0}, "audio": []any{"153", 1}, "fps": []any{"153", 2}, "bit_depth": 8}}
	nodes["190"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"154", 0}, "filename_prefix": "video/ccy-canvas/MiniMax_H3_Director", "format": "auto", "codec": "auto"}}
	return nodes
}

func splitMiniMaxDirectorCommonPrompt(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, miniMaxDirectorCommonPrefix) {
		return "", text, false
	}
	parts := strings.Split(trimmed, miniMaxDirectorSegmentMark)
	if len(parts) < 2 {
		return "", text, false
	}
	common := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(parts[0]), miniMaxDirectorCommonPrefix))
	segments := strings.TrimSpace(strings.Join(parts[1:], miniMaxDirectorSegmentMark))
	if common == "" || segments == "" {
		return "", text, false
	}
	return common, segments, true
}

func parseMiniMaxDirectorSegmentRefs(text string, imageCount int) (string, []int, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, miniMaxDirectorRefsPrefix) {
		return trimmed, nil, false
	}
	end := strings.Index(trimmed, "]")
	if end <= len(miniMaxDirectorRefsPrefix) {
		return trimmed, nil, false
	}
	raw := strings.TrimSpace(trimmed[len(miniMaxDirectorRefsPrefix):end])
	indices := make([]int, 0, 9)
	seen := map[int]bool{}
	for _, token := range strings.Split(raw, ",") {
		index, err := strconv.Atoi(strings.TrimSpace(token))
		if err != nil || index < 0 || index >= imageCount || seen[index] {
			return trimmed, nil, false
		}
		seen[index] = true
		indices = append(indices, index)
	}
	if len(indices) == 0 || len(indices) > 9 {
		return trimmed, nil, false
	}
	return strings.TrimSpace(trimmed[end+1:]), indices, true
}

func parseMiniMaxDirectorSegmentDuration(text string) (string, int, bool) {
	const prefix = "[H3_DURATION="
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, prefix) {
		return trimmed, 0, false
	}
	end := strings.Index(trimmed, "]")
	if end < len(prefix)+1 {
		return trimmed, 0, false
	}
	secondsText := strings.TrimSuffix(strings.TrimSpace(trimmed[len(prefix):end]), "S")
	seconds, err := strconv.Atoi(secondsText)
	if err != nil || seconds < 1 || seconds > 30 {
		return trimmed, 0, false
	}
	return strings.TrimSpace(trimmed[end+1:]), seconds, true
}

func splitMiniMaxDirectorPrompts(text string, segmentCount int) ([]string, bool) {
	parts := strings.Split(text, miniMaxDirectorSegmentMark)
	if len(parts) == segmentCount {
		out := make([]string, segmentCount)
		for i, part := range parts {
			out[i] = strings.TrimSpace(part)
			if out[i] == "" {
				break
			}
		}
		valid := true
		for _, part := range out {
			if part == "" {
				valid = false
				break
			}
		}
		if valid {
			return out, true
		}
	}
	out := make([]string, segmentCount)
	for i := range out {
		out[i] = text
	}
	return out, false
}

func uploadComfyReference(ctx context.Context, baseURL, raw string, index int) (string, error) {
	data, filename, err := readComfyReference(ctx, raw, index)
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	_ = writer.WriteField("type", "input")
	_ = writer.WriteField("overwrite", "true")
	if err = writer.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/upload/image", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := newProviderHTTPClient(5 * time.Minute).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody[:min(len(respBody), 500)]))
	}
	var uploaded struct{ Name, Subfolder string }
	if json.Unmarshal(respBody, &uploaded) != nil || uploaded.Name == "" {
		return "", fmt.Errorf("invalid upload response: %s", string(respBody))
	}
	return strings.TrimLeft(filepath.ToSlash(filepath.Join(uploaded.Subfolder, uploaded.Name)), "/"), nil
}

func readComfyReference(ctx context.Context, raw string, index int) ([]byte, string, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "data:") {
		comma := strings.IndexByte(raw, ',')
		if comma < 0 {
			return nil, "", fmt.Errorf("malformed data URL")
		}
		data, err := base64.StdEncoding.DecodeString(raw[comma+1:])
		return data, fmt.Sprintf("ccy_ref_%02d.png", index), err
	}
	if strings.HasPrefix(raw, "/uploads/") {
		path, err := resolveUploadDiskPath(raw)
		if err != nil {
			return nil, "", err
		}
		data, err := os.ReadFile(path)
		return data, filepath.Base(path), err
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			return nil, "", err
		}
		resp, err := safehttp.Client(remoteReferenceFetchTimeout).Do(req)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			return nil, "", fmt.Errorf("reference returned HTTP %d", resp.StatusCode)
		}
		limit := int64(32 * 1024 * 1024)
		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		ext := strings.ToLower(filepath.Ext(req.URL.Path))
		if strings.HasPrefix(contentType, "video/") || ext == ".mp4" || ext == ".mov" || ext == ".webm" || ext == ".mkv" {
			limit = 256 * 1024 * 1024
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, limit))
		name := filepath.Base(strings.Split(req.URL.Path, "?")[0])
		if name == "" || name == "." || name == "/" {
			name = fmt.Sprintf("ccy_ref_%02d.png", index)
		}
		return data, name, err
	}
	return nil, "", fmt.Errorf("unsupported reference image URL")
}

type comfyPromptPhase string

const (
	comfyPromptUnknown comfyPromptPhase = "unknown"
	comfyPromptQueued  comfyPromptPhase = "queued"
	comfyPromptRunning comfyPromptPhase = "running"
)

type comfyVideoDeadlineTracker struct {
	queuedAt         time.Time
	executionStarted time.Time
	queueBudget      time.Duration
	executionBudget  time.Duration
}

func newComfyVideoDeadlineTracker(now time.Time, queueBudget, executionBudget time.Duration) *comfyVideoDeadlineTracker {
	return &comfyVideoDeadlineTracker{
		queuedAt:        now,
		queueBudget:     queueBudget,
		executionBudget: executionBudget,
	}
}

func (t *comfyVideoDeadlineTracker) observe(phase comfyPromptPhase, now time.Time) {
	if phase == comfyPromptRunning && t.executionStarted.IsZero() {
		t.executionStarted = now
	}
}

func (t *comfyVideoDeadlineTracker) expired(now time.Time) (string, bool) {
	if t.executionStarted.IsZero() {
		return "queue", t.queueBudget > 0 && now.Sub(t.queuedAt) >= t.queueBudget
	}
	return "execution", t.executionBudget > 0 && now.Sub(t.executionStarted) >= t.executionBudget
}

func comfyPromptQueuePhase(ctx context.Context, client *http.Client, baseURL, promptID string) comfyPromptPhase {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/queue", nil)
	if err != nil {
		return comfyPromptUnknown
	}
	resp, err := client.Do(req)
	if err != nil {
		return comfyPromptUnknown
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return comfyPromptUnknown
	}
	var queue struct {
		Running [][]json.RawMessage `json:"queue_running"`
		Pending [][]json.RawMessage `json:"queue_pending"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&queue); err != nil {
		return comfyPromptUnknown
	}
	containsPrompt := func(items [][]json.RawMessage) bool {
		for _, item := range items {
			if len(item) < 2 {
				continue
			}
			var id string
			if json.Unmarshal(item[1], &id) == nil && id == promptID {
				return true
			}
		}
		return false
	}
	if containsPrompt(queue.Running) {
		return comfyPromptRunning
	}
	if containsPrompt(queue.Pending) {
		return comfyPromptQueued
	}
	return comfyPromptUnknown
}

func pollComfyVideoResult(ctx context.Context, baseURL, promptID, outputNode, modelName string, executionBudget, queueBudget time.Duration) (*GenerateResult, error) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	client := newProviderHTTPClient(30 * time.Second)
	deadlines := newComfyVideoDeadlineTracker(time.Now(), queueBudget, executionBudget)
	for {
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeInternal, "ComfyUI task exceeded its queue-plus-execution safety deadline")
		case <-ticker.C:
			now := time.Now()
			deadlines.observe(comfyPromptQueuePhase(ctx, client, baseURL, promptID), now)
			if stage, expired := deadlines.expired(now); expired {
				if stage == "queue" {
					return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI %s queue wait exceeded %s; execution never started", modelName, queueBudget.Round(time.Second)))
				}
				return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI %s generation timed out after %s of actual execution", modelName, executionBudget.Round(time.Second)))
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/history/"+url.PathEscape(promptID), nil)
			resp, err := client.Do(req)
			if err != nil {
				continue
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 300 {
				continue
			}
			var history map[string]struct {
				Status struct {
					Status    string `json:"status_str"`
					Completed bool   `json:"completed"`
				} `json:"status"`
				Outputs map[string]struct {
					Images []struct{ Filename, Subfolder, Type string } `json:"images"`
				} `json:"outputs"`
			}
			if json.Unmarshal(body, &history) != nil {
				continue
			}
			entry, ok := history[promptID]
			if !ok {
				continue
			}
			// ComfyUI reports execution errors as status_str=error while
			// completed=false. Treating completed=false as "still running" before
			// checking status leaves the canvas task polling forever after OOM or
			// a node failure.
			if strings.EqualFold(entry.Status.Status, "error") {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI generation failed")
			}
			if !entry.Status.Completed {
				continue
			}
			if entry.Status.Status != "success" {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI generation ended without success")
			}
			output := entry.Outputs[outputNode]
			if len(output.Images) == 0 {
				return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI %s completed without a video", modelName))
			}
			item := output.Images[0]
			viewURL := baseURL + "/view?" + url.Values{"filename": {item.Filename}, "subfolder": {item.Subfolder}, "type": {item.Type}}.Encode()
			videoReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, viewURL, nil)
			videoResp, err := newProviderHTTPClient(10 * time.Minute).Do(videoReq)
			if err != nil {
				return nil, err
			}
			defer videoResp.Body.Close()
			if videoResp.StatusCode >= 300 {
				return nil, fmt.Errorf("ComfyUI video download HTTP %d", videoResp.StatusCode)
			}
			staged, err := writeStagedAsset(videoResp.Body, ".mp4", "video/mp4")
			if err != nil {
				return nil, err
			}
			return &GenerateResult{Type: "url", Content: staged.StagingURL}, nil
		}
	}
}

func pollComfyMiniMaxResult(ctx context.Context, baseURL, promptID string) (*GenerateResult, error) {
	return pollComfyVideoResult(ctx, baseURL, promptID, "24", "video", maxRuntimeForType("video"), comfyVideoQueueWaitTimeout())
}
