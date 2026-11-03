package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
)

const comfyWanAnimate2Model = "wan-animate-2-motion-local"

func isComfyWanAnimate2Provider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil &&
		strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") &&
		strings.EqualFold(strings.TrimSpace(model), comfyWanAnimate2Model)
}

func comfyWanAnimate2Dimensions(ratio string) (int, int) {
	switch strings.TrimSpace(ratio) {
	case "9:16":
		return 480, 832
	case "1:1":
		return 640, 640
	default:
		return 832, 480
	}
}

func validWanAnimate2FrameCount(seconds int) int {
	if seconds < 1 {
		seconds = 3
	}
	if seconds > 5 {
		seconds = 5
	}
	return seconds*16 + 1
}

func buildComfyWanAnimate2Prompt(referenceImage, motionVideo, text string, width, height, length int, seed int64) map[string]any {
	if strings.TrimSpace(text) == "" {
		text = "Preserve the reference character identity, face, hairstyle, body proportions and clothing. Clean background, stable lighting, high detail."
	}
	negative := "overexposed, static, blurry, subtitles, watermark, low quality, jpeg artifacts, deformed face, deformed body, bad hands, extra fingers, fused fingers, extra limbs, duplicate people, camera shake"
	posePrompt := "The character precisely follows the driving video's facial expression, body motion, hand gestures, rhythm and timing. Keep the camera and background stable."
	return map[string]any{
		"1": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": referenceImage}},
		"2": map[string]any{"class_type": "VHS_LoadVideo", "inputs": map[string]any{
			"video": motionVideo, "force_rate": 16.0, "custom_width": 0, "custom_height": 0,
			"frame_load_cap": length, "skip_first_frames": 0, "select_every_nth": 1, "format": "None",
		}},
		"4":  map[string]any{"class_type": "ImageScale", "inputs": map[string]any{"image": []any{"1", 0}, "upscale_method": "area", "width": width, "height": height, "crop": "center"}},
		"5":  map[string]any{"class_type": "ImageScale", "inputs": map[string]any{"image": []any{"2", 0}, "upscale_method": "area", "width": width, "height": height, "crop": "center"}},
		"6":  map[string]any{"class_type": "ImageFromBatch", "inputs": map[string]any{"image": []any{"5", 0}, "batch_index": 0, "length": 1}},
		"7":  map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "wan_animate_2_int8_convrot.safetensors", "weight_dtype": "default"}},
		"8":  map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"7", 0}, "lora_name": "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "strength_model": 1.0}},
		"9":  map[string]any{"class_type": "WanAnimate2Cache", "inputs": map[string]any{"model": []any{"8", 0}, "device": "cpu", "dtype": "int8"}},
		"10": map[string]any{"class_type": "ModelSamplingSD3", "inputs": map[string]any{"model": []any{"9", 0}, "shift": 5.0}},
		"11": map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
		"12": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"text": text, "clip": []any{"11", 0}}},
		"13": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"text": negative, "clip": []any{"11", 0}}},
		"14": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"text": posePrompt, "clip": []any{"11", 0}}},
		"15": map[string]any{"class_type": "CLIPVisionLoader", "inputs": map[string]any{"clip_name": "clip_vision_h.safetensors"}},
		"16": map[string]any{"class_type": "CLIPVisionEncode", "inputs": map[string]any{"clip_vision": []any{"15", 0}, "image": []any{"4", 0}, "crop": "none"}},
		"17": map[string]any{"class_type": "CLIPVisionEncode", "inputs": map[string]any{"clip_vision": []any{"15", 0}, "image": []any{"6", 0}, "crop": "none"}},
		"18": map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "Wan2_1_VAE_bf16.safetensors"}},
		"19": map[string]any{"class_type": "WanAnimate2ToVideo", "inputs": map[string]any{
			"positive": []any{"12", 0}, "negative": []any{"13", 0}, "vae": []any{"18", 0},
			"width": width, "height": height, "length": length, "batch_size": 1, "video_frame_offset": 0,
			"pose_strength": 1.0, "pose_start_percent": 0.0, "pose_end_percent": 1.0, "reference_image_strength": 1.0,
			"reference_image": []any{"4", 0}, "pose_video": []any{"5", 0}, "clip_vision_output": []any{"16", 0},
			"positive_pose": []any{"14", 0}, "clip_vision_output_pose": []any{"17", 0},
		}},
		"20": map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"9", 0}, "scheduler": "simple", "steps": 6, "denoise": 1.0}},
		"21": map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "lcm"}},
		"22": map[string]any{"class_type": "SamplerCustom", "inputs": map[string]any{
			"model": []any{"10", 0}, "add_noise": true, "noise_seed": seed, "cfg": 2.0,
			"positive": []any{"19", 0}, "negative": []any{"19", 1}, "sampler": []any{"21", 0},
			"sigmas": []any{"20", 0}, "latent_image": []any{"19", 2},
		}},
		"23": map[string]any{"class_type": "TrimVideoLatent", "inputs": map[string]any{"samples": []any{"22", 0}, "trim_amount": []any{"19", 3}}},
		"26": map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"23", 0}, "vae": []any{"18", 0}}},
		"25": map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"26", 0}, "audio": []any{"2", 2}, "fps": 16.0, "bit_depth": 8}},
		"24": map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"25", 0}, "filename_prefix": "video/ccy-canvas/Wan_Animate2_Motion", "format": "auto", "codec": "auto"}},
	}
}

func (s *Service) generateVideoComfyWanAnimate2(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	if len(req.ReferenceImages) != 1 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Wan Animate 2 动作复刻需要连接 1 张角色参考图")
	}
	videoRefs := append([]string{}, req.ReferenceVideos...)
	if strings.TrimSpace(req.ReferenceVideo) != "" {
		videoRefs = append([]string{req.ReferenceVideo}, videoRefs...)
	}
	if len(videoRefs) != 1 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Wan Animate 2 动作复刻需要连接 1 条动作参考视频")
	}
	imageName, err := uploadComfyReference(ctx, baseURL, req.ReferenceImages[0], 61)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "角色参考图上传到 ComfyUI 失败", err)
	}
	videoName, err := uploadComfyReference(ctx, baseURL, videoRefs[0], 62)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "动作参考视频上传到 ComfyUI 失败", err)
	}
	width, height := comfyWanAnimate2Dimensions(req.AspectRatio)
	length := validWanAnimate2FrameCount(req.Duration)
	seed := int64(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = int64(*req.Seed)
	}
	prompt := buildComfyWanAnimate2Prompt(imageName, videoName, req.Prompt, width, height, length, seed)
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "创建 Wan Animate 2 ComfyUI 请求失败", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "提交 Wan Animate 2 ComfyUI 任务失败", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI 拒绝了 Wan Animate 2 工作流 (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI Wan Animate 2 未返回 prompt_id")
	}
	return pollComfyMiniMaxResult(ctx, baseURL, queued.PromptID)
}
