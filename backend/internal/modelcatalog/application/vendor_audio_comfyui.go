package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
)

const (
	comfyCosyVoice3Model       = "cosyvoice3-local"
	comfyStableAudio3SFXModel  = "stable-audio-3-small-sfx-local"
	comfyQwen3VoiceDesignModel = "qwen3-tts-voice-design-local"
)

func isComfyCosyVoice3Provider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil &&
		strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") &&
		strings.EqualFold(strings.TrimSpace(model), comfyCosyVoice3Model)
}

func isComfyStableAudio3SFXProvider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil &&
		strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") &&
		strings.EqualFold(strings.TrimSpace(model), comfyStableAudio3SFXModel)
}

func isComfyQwen3VoiceDesignProvider(pc *domain.ProviderConfig, model string) bool {
	return pc != nil &&
		strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") &&
		strings.EqualFold(strings.TrimSpace(model), comfyQwen3VoiceDesignModel)
}

func cosyVoiceNumber(params map[string]any, key string, fallback, minValue, maxValue float64) float64 {
	value := fallback
	if raw, ok := params[key]; ok {
		switch typed := raw.(type) {
		case float64:
			value = typed
		case float32:
			value = float64(typed)
		case int:
			value = float64(typed)
		}
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func buildComfyCosyVoice3Prompt(referenceAudio, text string, speed float64, seed int) map[string]any {
	return map[string]any{
		"1": map[string]any{
			"class_type": "LoadAudio",
			"inputs":     map[string]any{"audio": referenceAudio},
		},
		"2": map[string]any{
			"class_type": "XB_CosyVoice3_ModelLoader",
			"inputs": map[string]any{
				"model_version":    "Fun-CosyVoice3-0.5B",
				"download_source":  "ModelScope",
				"device":           "auto",
				"force_redownload": false,
				"force_reload":     false,
			},
		},
		"3": map[string]any{
			"class_type": "XB_CosyVoice3_ZeroShot",
			"inputs": map[string]any{
				"model":           []any{"2", 0},
				"text":            text,
				"reference_audio": []any{"1", 0},
				"speed":           speed,
				"seed":            seed,
				"text_frontend":   true,
			},
		},
		"4": map[string]any{
			"class_type": "SaveAudioMP3",
			"inputs": map[string]any{
				"audio":           []any{"3", 0},
				"filename_prefix": "audio/ccy-canvas/CosyVoice3_TTS",
				"quality":         "V0",
			},
		},
	}
}

func buildComfyStableAudio3SFXPrompt(text string, duration float64, seed int) map[string]any {
	return map[string]any{
		"1": map[string]any{
			"class_type": "CheckpointLoaderSimple",
			"inputs":     map[string]any{"ckpt_name": "stable_audio_3_small_sfx.safetensors"},
		},
		"2": map[string]any{
			"class_type": "CLIPLoader",
			"inputs": map[string]any{
				"clip_name": "t5gemma_b_b_ul2.safetensors",
				"type":      "stable_audio",
				"device":    "default",
			},
		},
		"3": map[string]any{
			"class_type": "CLIPTextEncode",
			"inputs":     map[string]any{"text": text, "clip": []any{"2", 0}},
		},
		"4": map[string]any{
			"class_type": "CLIPTextEncode",
			"inputs": map[string]any{
				"text": "low quality, distorted, clipping, speech, voice",
				"clip": []any{"2", 0},
			},
		},
		"5": map[string]any{
			"class_type": "EmptyLatentAudio",
			"inputs":     map[string]any{"seconds": duration, "batch_size": 1},
		},
		"6": map[string]any{
			"class_type": "KSampler",
			"inputs": map[string]any{
				"model": []any{"1", 0}, "positive": []any{"3", 0}, "negative": []any{"4", 0},
				"latent_image": []any{"5", 0}, "seed": seed, "steps": 8, "cfg": 1.0,
				"sampler_name": "lcm", "scheduler": "simple", "denoise": 1.0,
			},
		},
		"7": map[string]any{
			"class_type": "VAEDecodeAudio",
			"inputs":     map[string]any{"samples": []any{"6", 0}, "vae": []any{"1", 2}},
		},
		"8": map[string]any{
			"class_type": "SaveAudioMP3",
			"inputs": map[string]any{
				"audio": []any{"7", 0}, "filename_prefix": "audio/ccy-canvas/StableAudio3_SFX", "quality": "V0",
			},
		},
	}
}

func buildComfyQwen3VoiceDesignPrompt(text, voiceDescription, language string, seed int, temperature, topP float64) map[string]any {
	return map[string]any{
		"1": map[string]any{
			"class_type": "CCY_Qwen3TTSVoiceDesign",
			"inputs": map[string]any{
				"text": text, "voice_description": voiceDescription, "language": language,
				"seed": seed, "temperature": temperature, "top_p": topP,
			},
		},
		"2": map[string]any{
			"class_type": "SaveAudioMP3",
			"inputs": map[string]any{
				"audio": []any{"1", 0}, "filename_prefix": "audio/ccy-canvas/Qwen3_TTS_VoiceDesign", "quality": "V0",
			},
		},
	}
}

func (s *Service) generateAudioComfyCosyVoice3(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "请输入要合成的文字")
	}
	referenceAudio := strings.TrimSpace(req.ReferenceAudio)
	if referenceAudio == "" && len(req.ReferenceAudios) > 0 {
		referenceAudio = strings.TrimSpace(req.ReferenceAudios[0])
	}
	if referenceAudio == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "CosyVoice3 需要连接一条参考音频（建议 3–10 秒，最长 30 秒）")
	}
	uploaded, err := uploadComfyReference(ctx, baseURL, referenceAudio, 80)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考音频上传到 ComfyUI 失败", err)
	}
	seed := int(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = *req.Seed
	}
	speed := cosyVoiceNumber(req.Parameters, "speed", 1, 0.5, 2)
	prompt := buildComfyCosyVoice3Prompt(uploaded, strings.TrimSpace(req.Prompt), speed, seed)
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "创建 ComfyUI TTS 请求失败", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "提交 ComfyUI TTS 任务失败", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI 拒绝了 TTS 工作流 (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI TTS 未返回 prompt_id")
	}
	return pollComfyAudioResult(ctx, baseURL, queued.PromptID)
}

func (s *Service) generateAudioComfyStableAudio3SFX(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "请描述要生成的声音")
	}
	duration := float64(req.Duration)
	if duration <= 0 {
		duration = 10
	}
	if duration < 1 {
		duration = 1
	}
	if duration > 47 {
		duration = 47
	}
	seed := int(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = *req.Seed
	}
	prompt := buildComfyStableAudio3SFXPrompt(strings.TrimSpace(req.Prompt), duration, seed)
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "创建 ComfyUI 文生音效请求失败", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "提交 ComfyUI 文生音效任务失败", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI 拒绝了文生音效工作流 (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI 文生音效未返回 prompt_id")
	}
	return pollComfyAudioResult(ctx, baseURL, queued.PromptID)
}

func (s *Service) generateAudioComfyQwen3VoiceDesign(ctx context.Context, baseURL string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8188"
	}
	text := strings.TrimSpace(req.Prompt)
	if text == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "请输入需要朗读的台词")
	}
	voiceDescription, _ := req.Parameters["voice_description"].(string)
	voiceDescription = strings.TrimSpace(voiceDescription)
	if voiceDescription == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "请输入音色描述，例如：年轻女声，温柔清晰，普通话自然")
	}
	language, _ := req.Parameters["language"].(string)
	language = strings.TrimSpace(language)
	if language == "" {
		language = "Auto"
	}
	seed := int(time.Now().UnixNano() & 0x7fffffff)
	if req.Seed != nil {
		seed = *req.Seed
	}
	temperature := cosyVoiceNumber(req.Parameters, "temperature", .9, .1, 1.5)
	topP := cosyVoiceNumber(req.Parameters, "top_p", .95, .1, 1)
	prompt := buildComfyQwen3VoiceDesignPrompt(text, voiceDescription, language, seed, temperature, topP)
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "创建 ComfyUI Qwen3-TTS 请求失败", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "提交 ComfyUI Qwen3-TTS 任务失败", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI 拒绝了 Qwen3-TTS 工作流 (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI Qwen3-TTS 未返回 prompt_id")
	}
	return pollComfyAudioResult(ctx, baseURL, queued.PromptID)
}

func pollComfyAudioResult(ctx context.Context, baseURL, promptID string) (*GenerateResult, error) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	type mediaItem struct{ Filename, Subfolder, Type string }
	for {
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeInternal, "ComfyUI 音频生成超时")
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
					Audio []mediaItem `json:"audio"`
				} `json:"outputs"`
			}
			if json.Unmarshal(body, &history) != nil {
				continue
			}
			entry, ok := history[promptID]
			if !ok {
				continue
			}
			if strings.EqualFold(entry.Status.Status, "error") {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI 音频生成失败，请查看 ComfyUI 控制台的节点错误")
			}
			if !entry.Status.Completed {
				continue
			}
			if !strings.EqualFold(entry.Status.Status, "success") {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI 音频未成功完成")
			}
			var item *mediaItem
			for _, output := range entry.Outputs {
				if len(output.Audio) > 0 {
					candidate := output.Audio[0]
					item = &candidate
					break
				}
			}
			if item == nil {
				return nil, apperror.New(apperror.CodeInternal, "ComfyUI 音频已完成但没有返回音频")
			}
			viewURL := baseURL + "/view?" + url.Values{"filename": {item.Filename}, "subfolder": {item.Subfolder}, "type": {item.Type}}.Encode()
			audioReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, viewURL, nil)
			audioResp, err := newProviderHTTPClient(10 * time.Minute).Do(audioReq)
			if err != nil {
				return nil, err
			}
			defer audioResp.Body.Close()
			if audioResp.StatusCode >= 300 {
				return nil, fmt.Errorf("ComfyUI audio download HTTP %d", audioResp.StatusCode)
			}
			staged, err := writeStagedAsset(audioResp.Body, ".mp3", "audio/mpeg")
			if err != nil {
				return nil, err
			}
			return &GenerateResult{Type: "url", Content: staged.StagingURL}, nil
		}
	}
}
