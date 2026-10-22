package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"github.com/google/uuid"
)

const comfyKlein4B = "flux2-klein-base-4b-local"
const comfyKlein9B = "flux2-klein-base-9b-local"
const comfyKrea2 = "krea2-turbo-local"

func isComfyLocalImageProvider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil && strings.EqualFold(pc.Vendor, "ComfyUI") && (model == comfyKlein4B || model == comfyKlein9B || model == comfyKrea2)
}

type localImageSettings struct {
	Model                string
	Width, Height, Steps int
	Seed                 int64
	CFG, LoRAStrength    float64
	LoRA                 string
}

func localImageOptions(req GenerateRequest) (localImageSettings, error) {
	o := localImageSettings{Model: req.Model, Steps: 20, CFG: 5, LoRA: "none", LoRAStrength: 1}
	invalid := func(msg string) (localImageSettings, error) { return o, apperror.New(apperror.CodeInvalidInput, msg) }
	if req.Model != comfyKlein4B && req.Model != comfyKlein9B && req.Model != comfyKrea2 {
		return invalid("未知本地图片模型")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return invalid("请输入图片描述")
	}
	if len(req.ReferenceImages) > 4 {
		return invalid("FLUX.2 Klein 最多支持 4 张参考图")
	}
	if req.Model == comfyKrea2 {
		o.Steps = 8
		o.CFG = 1
		if len(req.ReferenceImages) > 0 {
			return invalid("此 Krea-2 工作流仅支持文生图和 Darkbrush LoRA；多参考请选 FLUX.2 Klein")
		}
	}
	if len(req.ReferenceVideos) > 0 || req.ReferenceVideo != "" || len(req.ReferenceAudios) > 0 || req.ReferenceAudio != "" || req.MaskImage != "" || req.EditOperation != "" {
		return invalid("此图片工作流不支持视频、音频或蒙版输入")
	}
	if req.OutputCount > 1 || req.OutputCount < 0 {
		return invalid("本地 FLUX/Krea 为控制显存，每次生成 1 张")
	}
	base := 768
	switch strings.ToLower(strings.TrimSpace(req.Resolution)) {
	case "", "768px":
	case "512px":
		base = 512
	case "1024px", "1k":
		base = 1024
	default:
		return invalid("分辨率请选择 512px、768px 或 1024px（长边）")
	}
	ratio := strings.TrimSpace(req.Size)
	if ratio == "" {
		ratio = strings.TrimSpace(req.AspectRatio)
	}
	if ratio == "" || strings.EqualFold(ratio, "auto") {
		ratio = "1:1"
	}
	ratios := map[string][2]int{"1:1": {1, 1}, "16:9": {16, 9}, "9:16": {9, 16}, "4:3": {4, 3}, "3:4": {3, 4}, "3:2": {3, 2}, "2:3": {2, 3}}
	r, ok := ratios[ratio]
	if !ok {
		return invalid("不支持该画面比例")
	}
	o.Width = int(math.Round(float64(base*r[0])/float64(max(r[0], r[1]))/16)) * 16
	o.Height = int(math.Round(float64(base*r[1])/float64(max(r[0], r[1]))/16)) * 16
	o.Seed = time.Now().UnixNano() & 0x7fffffff
	if req.Seed != nil {
		if *req.Seed < 0 || int64(*req.Seed) > 2147483647 {
			return invalid("种子须为 0–2147483647")
		}
		o.Seed = int64(*req.Seed)
	}
	for key, val := range req.Parameters {
		if key == "lora" {
			v, ok := val.(string)
			if !ok || (v != "none" && !(req.Model == comfyKrea2 && v == "darkbrush")) {
				return invalid("此模型不支持所选 LoRA")
			}
			o.LoRA = v
			continue
		}
		var n float64
		switch v := val.(type) {
		case float64:
			n = v
		case int:
			n = float64(v)
		default:
			return invalid("本地模型参数类型不正确")
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return invalid("参数必须为有限数值")
		}
		switch key {
		case "steps":
			minSteps, maxSteps := 10.0, 50.0
			if req.Model == comfyKrea2 {
				minSteps, maxSteps = 4, 16
			}
			if n < minSteps || n > maxSteps || n != math.Trunc(n) {
				return invalid("FLUX Base 步数为 10–50；Krea Turbo 步数为 4–16")
			}
			o.Steps = int(n)
		case "cfg":
			if req.Model == comfyKrea2 || n < 1 || n > 10 {
				return invalid("CFG 仅适用于 FLUX Base，范围 1–10；Krea 固定 1")
			}
			o.CFG = n
		case "lora_strength":
			if req.Model != comfyKrea2 || n < 0 || n > 1.5 {
				return invalid("Krea LoRA 强度范围为 0–1.5")
			}
			o.LoRAStrength = n
		default:
			return invalid("本地模型收到不支持的参数")
		}
	}
	return o, nil
}

func buildComfyLocalImagePrompt(text string, o localImageSettings, refs []string) map[string]any {
	g := map[string]any{}
	node := func(id, kind string, in map[string]any) { g[id] = map[string]any{"class_type": kind, "inputs": in} }
	link := func(id string) []any { return []any{id, 0} }
	checkpoint, encoder, clipType, vae := "flux-2-klein-base-4b-fp8.safetensors", "Qwen3-4B-ZImage-Heretic-Genesis-Q8.gguf", "flux2", "full_encoder_small_decoder.safetensors"
	loader := "CLIPLoaderGGUF"
	if o.Model == comfyKlein9B {
		checkpoint = "flux-2-klein-base-9b-fp8.safetensors"
		encoder = "model.safetensors"
		loader = "CLIPLoader"
	}
	if o.Model == comfyKrea2 {
		checkpoint = "Krea2_turbo_uncensored_edit_v1.1-fp8_scaled.safetensors"
		encoder = "qwen3vl_4b_fp8_scaled.safetensors"
		loader = "CLIPLoader"
		clipType = "krea2"
		vae = "qwen_image_vae.safetensors"
	}
	node("1", "UNETLoader", map[string]any{"unet_name": checkpoint, "weight_dtype": "default"})
	node("2", loader, map[string]any{"clip_name": encoder, "type": clipType})
	node("3", "VAELoader", map[string]any{"vae_name": vae})
	model := link("1")
	if o.Model == comfyKrea2 && o.LoRA == "darkbrush" && o.LoRAStrength > 0 {
		node("7", "LoraLoaderModelOnly", map[string]any{"model": model, "lora_name": "krea2_darkbrush.safetensors", "strength_model": o.LoRAStrength})
		model = link("7")
		text += " , monochrome ink wash style"
	}
	node("4", "CLIPTextEncode", map[string]any{"clip": link("2"), "text": text})
	if o.Model == comfyKrea2 {
		node("5", "ConditioningZeroOut", map[string]any{"conditioning": link("4")})
		node("6", "EmptyLatentImage", map[string]any{"width": o.Width, "height": o.Height, "batch_size": 1})
		node("9", "KSampler", map[string]any{"model": model, "seed": o.Seed, "steps": o.Steps, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": link("4"), "negative": link("5"), "latent_image": link("6"), "denoise": 1.0})
	} else {
		node("5", "CLIPTextEncode", map[string]any{"clip": link("2"), "text": ""})
		node("6", "EmptyFlux2LatentImage", map[string]any{"width": o.Width, "height": o.Height, "batch_size": 1})
		positive, negative := link("4"), link("5")
		for i, name := range refs {
			id := 20 + i*5
			load, scale, encode, pos, neg := fmt.Sprint(id), fmt.Sprint(id+1), fmt.Sprint(id+2), fmt.Sprint(id+3), fmt.Sprint(id+4)
			node(load, "LoadImage", map[string]any{"image": name})
			node(scale, "ImageScaleToTotalPixels", map[string]any{"image": link(load), "upscale_method": "lanczos", "megapixels": 0.5, "resolution_steps": 16})
			node(encode, "VAEEncode", map[string]any{"pixels": link(scale), "vae": link("3")})
			node(pos, "ReferenceLatent", map[string]any{"conditioning": positive, "latent": link(encode)})
			node(neg, "ReferenceLatent", map[string]any{"conditioning": negative, "latent": link(encode)})
			positive, negative = link(pos), link(neg)
		}
		node("12", "CFGGuider", map[string]any{"model": model, "positive": positive, "negative": negative, "cfg": o.CFG})
		node("13", "RandomNoise", map[string]any{"noise_seed": o.Seed})
		node("14", "KSamplerSelect", map[string]any{"sampler_name": "euler"})
		node("15", "Flux2Scheduler", map[string]any{"steps": o.Steps, "width": o.Width, "height": o.Height})
		node("9", "SamplerCustomAdvanced", map[string]any{"noise": link("13"), "guider": link("12"), "sampler": link("14"), "sigmas": link("15"), "latent_image": link("6")})
	}
	node("10", "VAEDecode", map[string]any{"samples": link("9"), "vae": link("3")})
	node("11", "SaveImage", map[string]any{"images": link("10"), "filename_prefix": "ccy-canvas/" + o.Model})
	return g
}

// Unique input names prevent queued requests from overwriting each other's references.
func uploadLocalImageReference(ctx context.Context, baseURL, raw string, index int) (string, error) {
	data, _, err := readComfyReference(ctx, raw, index)
	if err != nil {
		return "", err
	}
	if len(data) > 32*1024*1024 {
		return "", fmt.Errorf("参考图不得超过 32MB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("无法读取参考图格式: %w", err)
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 64_000_000 {
		return "", fmt.Errorf("参考图尺寸超限")
	}
	ext := format
	if format == "jpeg" {
		ext = "jpg"
	}
	name := "ccy_local_" + uuid.NewString() + "." + ext
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", name)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	_ = writer.WriteField("type", "input")
	if err = writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/upload/image", &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := newProviderHTTPClient(time.Minute).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ComfyUI 上传失败 HTTP %d", response.StatusCode)
	}
	var uploaded struct{ Name, Subfolder string }
	if err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&uploaded); err != nil || uploaded.Name == "" {
		return "", fmt.Errorf("ComfyUI 上传响应无效")
	}
	return filepath.ToSlash(filepath.Join(uploaded.Subfolder, uploaded.Name)), nil
}

func (s *Service) generateImageComfyLocal(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	o, err := localImageOptions(req)
	if err != nil {
		return nil, err
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	refs := make([]string, 0, len(req.ReferenceImages))
	for i, raw := range req.ReferenceImages {
		name, err := uploadLocalImageReference(ctx, baseURL, raw, i)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("第 %d 张参考图上传失败", i+1), err)
		}
		refs = append(refs, name)
	}
	log.Printf("[comfy-local-image] log_id=%s model=%s size=%dx%d steps=%d cfg=%.2f seed=%d references=%d lora=%s strength=%.2f", req.GenerationLogID, req.Model, o.Width, o.Height, o.Steps, o.CFG, o.Seed, len(refs), o.LoRA, o.LoRAStrength)
	return submitComfyImage(ctx, baseURL, buildComfyLocalImagePrompt(req.Prompt, o, refs), req.Model, req.GenerationLogID)
}
