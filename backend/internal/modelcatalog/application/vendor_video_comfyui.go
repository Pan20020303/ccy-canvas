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
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"

	"github.com/google/uuid"
)

const (
	comfyMiniMaxH3Model       = "minimax-h3-t2v-ref2v-turbo-local"
	comfyMiniMaxH3LegacyModel = "minimax-h3-ref2v-9ref-turbo-local"
)

func isComfyMiniMaxH3Provider(pc *domain.ProviderConfig, model string) bool {
	model = strings.TrimSpace(model)
	if pc == nil || (!strings.EqualFold(model, comfyMiniMaxH3Model) && !strings.EqualFold(model, comfyMiniMaxH3LegacyModel)) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI")
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
		duration = 3
	}
	if duration > 15 {
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
	prompt := buildComfyMiniMaxPrompt(uploaded, uploadedVideos, uploadedAudios, promptText, width, height, validMiniMaxFrameCount(duration), seed)
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
	return pollComfyMiniMaxResult(ctx, baseURL, queued.PromptID)
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

func buildComfyMiniMaxPrompt(images, videos, audios []string, text string, width, height, length int, seed int64) map[string]any {
	nodes := map[string]any{}
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
	nodes["10"] = map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}}
	nodes["11"] = map[string]any{"class_type": "LoraLoaderModelOnly", "inputs": map[string]any{"model": []any{"10", 0}, "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 0.8}}
	nodes["12"] = map[string]any{"class_type": "CLIPLoader", "inputs": map[string]any{"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}}
	nodes["13"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_video_vae_fp16.safetensors"}}
	nodes["14"] = map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}}
	conditioning := map[string]any{"clip": []any{"12", 0}, "vae": []any{"13", 0}, "audio_vae": []any{"14", 0}, "prompt": text, "width": width, "height": height, "length": length, "ref_image_size": "match"}
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
	nodes["17"] = map[string]any{"class_type": "BasicGuider", "inputs": map[string]any{"model": []any{"11", 0}, "conditioning": []any{"15", 0}}}
	nodes["18"] = map[string]any{"class_type": "KSamplerSelect", "inputs": map[string]any{"sampler_name": "er_sde"}}
	nodes["19"] = map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"model": []any{"11", 0}, "scheduler": "simple", "steps": 4, "denoise": 1.0}}
	nodes["20"] = map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"noise": []any{"16", 0}, "guider": []any{"17", 0}, "sampler": []any{"18", 0}, "sigmas": []any{"19", 0}, "latent_image": []any{"15", 1}}}
	nodes["21"] = map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"20", 0}, "vae": []any{"13", 0}}}
	nodes["22"] = map[string]any{"class_type": "VAEDecodeAudio", "inputs": map[string]any{"samples": []any{"20", 0}, "vae": []any{"14", 0}}}
	nodes["23"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"21", 0}, "audio": []any{"22", 0}, "fps": 24.0, "bit_depth": 8}}
	nodes["24"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"23", 0}, "filename_prefix": "video/ccy-canvas/MiniMax_H3_T2V_Ref2V_Turbo", "format": "auto", "codec": "auto"}}
	return nodes
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

func pollComfyMiniMaxResult(ctx context.Context, baseURL, promptID string) (*GenerateResult, error) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeInternal, "ComfyUI generation timed out")
		case <-ticker.C:
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/history/"+url.PathEscape(promptID), nil)
			resp, err := newProviderHTTPClient(30 * time.Second).Do(req)
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
			output := entry.Outputs["24"]
			if len(output.Images) == 0 {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI completed without a video")
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
