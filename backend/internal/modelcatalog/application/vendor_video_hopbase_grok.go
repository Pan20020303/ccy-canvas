package application

import (
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// HopBase exposes Grok Imagine Video 1.5 through the same unified asynchronous
// video gateway as its Seedance models. The model capabilities differ, but the
// paid submit endpoint and task polling contract are shared.
func isHopBaseGrok15Provider(pc *domain.ProviderConfig, baseURL, model string) bool {
	if !isHopBaseProvider(pc, baseURL) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "grok-imagine-video-1.5", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-2026-05-30":
		return true
	default:
		return false
	}
}

func (s *Service) generateVideoHopBaseGrok15(ctx context.Context, _ *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 需要提示词")
	}

	duration := req.Duration
	if duration == 0 {
		duration = 10
	}
	if duration < 1 || duration > 15 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 时长必须为 1–15 秒")
	}

	ratio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if ratio == "" || ratio == "auto" || ratio == "adaptive" {
		ratio = "16:9"
	}
	if !hopBaseGrokAspectRatioAllowed(ratio) {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 比例仅支持 16:9、9:16、1:1、4:3、3:4、3:2 或 2:3")
	}

	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))
	if resolution == "" {
		resolution = "720p"
	}
	if resolution != "480p" && resolution != "720p" && resolution != "1080p" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 分辨率仅支持 480p、720p 或 1080p")
	}

	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	multiReference := len(req.ReferenceImages) > 1 || mode == "multi-image" || mode == "image_reference" || mode == "all_reference"
	if len(req.ReferenceImages) > 7 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 最多支持 7 张参考图")
	}
	if multiReference && len(req.ReferenceImages) < 2 {
		return nil, apperror.New(apperror.CodeInvalidInput, "多图参考模式至少需要 2 张参考图")
	}
	if multiReference && resolution == "1080p" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 多图参考模式最高支持 720p")
	}

	content := make([]map[string]any, 0, 1+len(req.ReferenceImages))
	content = append(content, map[string]any{"type": "text", "text": prompt})
	for i, raw := range req.ReferenceImages {
		assetURL := strings.TrimSpace(raw)
		if !strings.HasPrefix(assetURL, "asset://") {
			publicURL, err := arkReferenceImageURL(ctx, raw)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 处理失败", i+1), err)
			}
			assetURL, err = s.createAndActivateHopBaseImageAsset(ctx, baseURL, apiKey, publicURL)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("参考图 #%d 上传 HopBase 素材库失败", i+1), err)
			}
		}

		role := "reference_image"
		if mode == "start_end" {
			if i == 0 {
				role = "first_frame"
			} else if i == 1 {
				role = "last_frame"
			}
		} else if (mode == "first_frame" || mode == "start_frame") && i == 0 {
			role = "first_frame"
		}
		content = append(content, map[string]any{
			"type": "image_url", "image_url": map[string]any{"url": assetURL}, "role": role,
		})
	}

	body := map[string]any{
		"model": req.Model, "content": content, "duration": duration,
		"resolution": resolution, "ratio": ratio,
		"generate_audio": true, "watermark": false,
	}
	for _, key := range []string{"generate_audio", "watermark"} {
		if value, exists := req.Parameters[key]; exists {
			if typed, valid := value.(bool); valid {
				body[key] = typed
			}
		}
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encode HopBase Grok video request", err)
	}
	// Always use HopBase's documented gateway. This deliberately ignores stale
	// provider rows that may still contain the old /v1/videos/generations path.
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, hopBaseVideoSubmitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build HopBase Grok video request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(30 * time.Second)
	resp, err := doProviderSubmitOnce(ctx, client, httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, providerRequestErrorMessage(err), err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var submit map[string]any
	if err := json.Unmarshal(respBody, &submit); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("HopBase Grok submit response is invalid: %s", truncateHopBaseGrokBody(respBody, 500)))
	}
	if outputURL := hopBaseVideoOutputURL(submit); outputURL != "" {
		return &GenerateResult{Type: "url", Content: outputURL}, nil
	}
	taskID := hopBaseTaskID(submit)
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("HopBase Grok submit returned no task id: %s", truncateHopBaseGrokBody(respBody, 500)))
	}
	return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, taskID)
}

func hopBaseGrokAspectRatioAllowed(value string) bool {
	switch value {
	case "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3":
		return true
	default:
		return false
	}
}

func truncateHopBaseGrokBody(body []byte, limit int) string {
	if len(body) > limit {
		body = body[:limit]
	}
	return string(body)
}
