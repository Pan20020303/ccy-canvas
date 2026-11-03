package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"github.com/google/uuid"
)

const comfyZImageModel = "z-image-turbo-local"
const comfyZImageV60Model = "z-image-turbo-v60-local"

func isComfyZImageProvider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil && strings.EqualFold(pc.Vendor, "ComfyUI") &&
		(model == comfyZImageModel || model == comfyZImageV60Model)
}

type zImageSettings struct {
	Checkpoint, Sampler, Scheduler, LoRA string
	Width, Height, Steps, Count          int
	Seed                                 int64
	LoRAStrength                         float64
}

func zImageOptions(req GenerateRequest) (zImageSettings, error) {
	o := zImageSettings{Checkpoint: "z_image_turbo_bf16.safetensors", Steps: 8, Count: 1, Sampler: "res_multistep", Scheduler: "simple", LoRA: "none", LoRAStrength: 0.8}
	invalid := func(message string) (zImageSettings, error) {
		return o, apperror.New(apperror.CodeInvalidInput, message)
	}
	if req.Model == comfyZImageV60Model {
		o.Checkpoint = "Z_ImageTurbo_v60Fp16.safetensors"
	} else if req.Model != comfyZImageModel {
		return invalid("未知的 Z-Image 模型版本")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return invalid("请输入图片描述")
	}
	if len(req.ReferenceImages) > 0 || len(req.ReferenceVideos) > 0 || req.ReferenceVideo != "" || len(req.ReferenceAudios) > 0 || req.ReferenceAudio != "" || req.MaskImage != "" || req.EditOperation != "" {
		return invalid("当前 Z-Image 工作流仅支持文生图，请移除参考素材或改用图片编辑模型")
	}
	base := 768
	switch strings.ToLower(strings.TrimSpace(req.Resolution)) {
	case "", "768px":
		base = 768
	case "512px":
		base = 512
	case "1024px", "1k":
		base = 1024
	default:
		return invalid("Z-Image 分辨率请选择 512px、768px 或 1024px（长边）")
	}
	ratio := strings.ToLower(strings.TrimSpace(req.Size))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.AspectRatio))
	}
	if ratio == "" || ratio == "auto" {
		ratio = "1:1"
	}
	ratios := map[string][2]int{"1:1": {1, 1}, "16:9": {16, 9}, "9:16": {9, 16}, "4:3": {4, 3}, "3:4": {3, 4}, "3:2": {3, 2}, "2:3": {2, 3}}
	r, ok := ratios[ratio]
	if !ok {
		return invalid("Z-Image 不支持所选画面比例")
	}
	o.Width = int(math.Round(float64(base*r[0])/float64(max(r[0], r[1]))/16)) * 16
	o.Height = int(math.Round(float64(base*r[1])/float64(max(r[0], r[1]))/16)) * 16
	if req.OutputCount != 0 {
		o.Count = req.OutputCount
	}
	if o.Count < 1 || o.Count > 4 {
		return invalid("Z-Image 一次支持生成 1–4 张图片")
	}
	o.Seed = time.Now().UnixNano() & 0x7fffffff
	if req.Seed != nil {
		if *req.Seed < 0 || int64(*req.Seed) > 2147483647 {
			return invalid("随机种子必须在 0–2147483647 之间")
		}
		o.Seed = int64(*req.Seed)
	}
	for key, value := range req.Parameters {
		switch key {
		case "steps", "lora_strength":
			var n float64
			switch v := value.(type) {
			case float64:
				n = v
			case int:
				n = float64(v)
			default:
				return invalid("Z-Image 数值参数类型不正确")
			}
			if math.IsNaN(n) || math.IsInf(n, 0) {
				return invalid("Z-Image 数值参数必须为有限数值")
			}
			if key == "steps" {
				if n < 4 || n > 20 || n != math.Trunc(n) {
					return invalid("采样步数必须是 4–20 的整数")
				}
				o.Steps = int(n)
			} else {
				if n < 0 || n > 1.5 {
					return invalid("LoRA 强度必须在 0–1.5 之间")
				}
				o.LoRAStrength = n
			}
		case "sampler":
			v, ok := value.(string)
			if !ok || (v != "euler" && v != "res_multistep") {
				return invalid("采样器请选择 euler 或 res_multistep")
			}
			o.Sampler = v
		case "scheduler":
			v, ok := value.(string)
			if !ok || (v != "simple" && v != "beta") {
				return invalid("调度器请选择 simple 或 beta")
			}
			o.Scheduler = v
		case "lora":
			v, ok := value.(string)
			if !ok || (v != "none" && v != "pixel-art") {
				return invalid("请选择无 LoRA 或像素风 LoRA")
			}
			o.LoRA = v
		default:
			return invalid("Z-Image 收到不支持的参数")
		}
	}
	return o, nil
}

func buildComfyZImagePrompt(text string, o zImageSettings) map[string]any {
	graph := map[string]any{
		"1":  map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": o.Checkpoint, "weight_dtype": "default"}},
		"2":  map[string]any{"class_type": "CLIPLoaderGGUF", "inputs": map[string]any{"clip_name": "Qwen3-4B-ZImage-Heretic-Genesis-Q8.gguf", "type": "lumina2"}},
		"3":  map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "ae.safetensors"}},
		"4":  map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"clip": []any{"2", 0}, "text": text}},
		"5":  map[string]any{"class_type": "ConditioningZeroOut", "inputs": map[string]any{"conditioning": []any{"4", 0}}},
		"6":  map[string]any{"class_type": "EmptySD3LatentImage", "inputs": map[string]any{"width": o.Width, "height": o.Height, "batch_size": o.Count}},
		"8":  map[string]any{"class_type": "ModelSamplingAuraFlow", "inputs": map[string]any{"model": []any{"1", 0}, "shift": 3.0}},
		"9":  map[string]any{"class_type": "KSampler", "inputs": map[string]any{"model": []any{"8", 0}, "seed": o.Seed, "steps": o.Steps, "cfg": 1.0, "sampler_name": o.Sampler, "scheduler": o.Scheduler, "positive": []any{"4", 0}, "negative": []any{"5", 0}, "latent_image": []any{"6", 0}, "denoise": 1.0}},
		"10": map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"9", 0}, "vae": []any{"3", 0}}},
		"11": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"10", 0}, "filename_prefix": "ccy-canvas/ZImage_Turbo"}},
	}
	if o.LoRA == "pixel-art" && o.LoRAStrength > 0 {
		graph["7"] = map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"1", 0}, "lora_name": "pixel_art_style_z_image_turbo.safetensors", "strength_model": o.LoRAStrength}}
		graph["8"].(map[string]any)["inputs"].(map[string]any)["model"] = []any{"7", 0}
	}
	return graph
}

func (s *Service) generateImageComfyZImage(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	o, err := zImageOptions(req)
	if err != nil {
		return nil, err
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	log.Printf("[zimage] log_id=%s model=%s size=%dx%d steps=%d seed=%d lora=%s strength=%.2f", req.GenerationLogID, req.Model, o.Width, o.Height, o.Steps, o.Seed, o.LoRA, o.LoRAStrength)
	return submitComfyImage(ctx, baseURL, buildComfyZImagePrompt(req.Prompt, o), "Z-Image", req.GenerationLogID)
}

func submitComfyImage(ctx context.Context, baseURL string, graph map[string]any, label, logID string) (*GenerateResult, error) {
	body, _ := json.Marshal(map[string]any{"prompt": graph, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "ComfyUI 地址无效", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(30 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "连接 ComfyUI 失败，请检查本地服务", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	resp.Body.Close()
	if readErr != nil {
		return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "读取 ComfyUI 响应失败", readErr)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, apperror.New(apperror.CodeUpstreamUnavailable, fmt.Sprintf("ComfyUI 拒绝 %s 工作流（HTTP %d），请检查模型及节点是否已加载", label, resp.StatusCode))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(data, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeUpstreamUnavailable, "ComfyUI 未返回任务编号")
	}
	log.Printf("[comfy-image] log_id=%s prompt_id=%s model=%s", logID, queued.PromptID, label)
	return pollComfyZImage(ctx, baseURL, queued.PromptID, label)
}

func pollComfyZImage(ctx context.Context, baseURL, promptID, label string) (*GenerateResult, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeTimeout, label+" 任务超时或已取消；请检查 ComfyUI 队列，未自动重复提交")
		case <-ticker.C:
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/history/"+url.PathEscape(promptID), nil)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "ComfyUI 地址无效", err)
		}
		resp, err := newProviderHTTPClient(15 * time.Second).Do(req)
		if err != nil {
			failures++
			if failures >= 5 {
				return nil, apperror.New(apperror.CodeUpstreamUnavailable, "ComfyUI 连续失联，请检查本地服务；未自动重复提交")
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
		resp.Body.Close()
		var history map[string]struct {
			Status struct {
				State     string `json:"status_str"`
				Completed bool   `json:"completed"`
			} `json:"status"`
			Outputs map[string]struct {
				Images []struct{ Filename, Subfolder, Type string } `json:"images"`
			} `json:"outputs"`
		}
		if resp.StatusCode != http.StatusOK || readErr != nil || json.Unmarshal(body, &history) != nil {
			failures++
			if failures >= 5 {
				return nil, apperror.New(apperror.CodeUpstreamUnavailable, "ComfyUI 任务状态读取失败；未自动重复提交")
			}
			continue
		}
		failures = 0
		entry, ok := history[promptID]
		if !ok {
			continue
		}
		if entry.Status.State == "error" {
			message := label + " 在 ComfyUI 执行失败，请检查节点日志（任务 " + promptID + "）"
			if bytes.Contains(body, []byte("OutOfMemoryError")) {
				message = label + " 显存不足，请降低分辨率或参考图数量"
			}
			return nil, apperror.New(apperror.CodeUpstreamUnavailable, message)
		}
		if !entry.Status.Completed {
			continue
		}
		if entry.Status.State != "success" || len(entry.Outputs["11"].Images) == 0 {
			return nil, apperror.New(apperror.CodeUpstreamUnavailable, "ComfyUI 任务结束但没有输出图片")
		}
		var results []string
		for _, file := range entry.Outputs["11"].Images {
			viewURL := baseURL + "/view?" + url.Values{"filename": {file.Filename}, "subfolder": {file.Subfolder}, "type": {file.Type}}.Encode()
			download, _ := http.NewRequestWithContext(ctx, http.MethodGet, viewURL, nil)
			imageResp, err := newProviderHTTPClient(time.Minute).Do(download)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "读取 ComfyUI 图片失败", err)
			}
			if imageResp.StatusCode != http.StatusOK {
				imageResp.Body.Close()
				return nil, apperror.New(apperror.CodeUpstreamUnavailable, "ComfyUI 输出图片不可访问")
			}
			staged, err := writeStagedAsset(imageResp.Body, ".png", "image/png")
			imageResp.Body.Close()
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeUpstreamUnavailable, "保存 "+label+" 图片失败", err)
			}
			results = append(results, staged.StagingURL)
		}
		return &GenerateResult{Type: "url", Content: results[0], ContentList: results}, nil
	}
}
