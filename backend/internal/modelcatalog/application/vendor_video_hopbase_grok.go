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
	"net/url"
	"strings"
	"time"
)

// xAI native video contract, relayed through HopBase's configured base URL.
// The paid POST is deliberately sent through doProviderSubmitOnce: network or
// provider errors end this generation and are never retried automatically.
const (
	hopBaseGrokVideoSubmitPath = "/v1/videos/generations"
	hopBaseGrokVideoQueryPath  = "/v1/videos/{taskId}"
)

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

func (s *Service) generateVideoHopBaseGrok15(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
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

	aspectRatio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if aspectRatio == "" {
		aspectRatio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if aspectRatio == "" || aspectRatio == "auto" || aspectRatio == "adaptive" {
		aspectRatio = "16:9"
	}
	if !hopBaseGrokAspectRatioAllowed(aspectRatio) {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 比例仅支持 16:9、9:16、1:1、4:3、3:4、3:2 或 2:3")
	}

	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))
	if resolution == "" {
		resolution = "720p"
	}
	if resolution != "480p" && resolution != "720p" && resolution != "1080p" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 分辨率仅支持 480p、720p 或 1080p")
	}

	references := make([]string, 0, len(req.ReferenceImages))
	for i, raw := range req.ReferenceImages {
		resolved, err := resolveHopBaseGrokReference(ctx, raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 处理失败", i+1), err)
		}
		references = append(references, resolved)
	}
	if len(references) > 7 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 最多支持 7 张参考图")
	}

	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	multiReference := len(references) > 1 || mode == "multi-image" || mode == "image_reference" || mode == "all_reference"
	if multiReference && len(references) < 2 {
		return nil, apperror.New(apperror.CodeInvalidInput, "多图参考模式至少需要 2 张参考图")
	}
	if multiReference && resolution == "1080p" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Grok Imagine Video 1.5 多图参考模式最高支持 720p")
	}

	generateAudio := true
	if value, ok := req.Parameters["generate_audio"].(bool); ok {
		generateAudio = value
	}
	body := map[string]any{
		"model":          strings.TrimSpace(req.Model),
		"prompt":         prompt,
		"duration":       duration,
		"aspect_ratio":   aspectRatio,
		"resolution":     resolution,
		"generate_audio": generateAudio,
	}
	if multiReference {
		items := make([]map[string]any, 0, len(references))
		for _, reference := range references {
			items = append(items, map[string]any{"url": reference})
		}
		body["reference_images"] = items
	} else if len(references) == 1 {
		body["image"] = map[string]any{"url": references[0]}
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encode HopBase Grok video request", err)
	}
	submitPath := strings.TrimSpace(resolveVideoSubmitPath(pc))
	if submitPath == "" {
		submitPath = hopBaseGrokVideoSubmitPath
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
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

	var payload map[string]any
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("HopBase Grok submit response is invalid: %s", truncateHopBaseGrokBody(respBody, 500)))
	}
	if outputURL := hopBaseGrokVideoOutputURL(payload); outputURL != "" {
		return &GenerateResult{Type: "url", Content: outputURL}, nil
	}
	taskID := strings.TrimSpace(findStringField(payload, "request_id", 5))
	if taskID == "" {
		taskID = strings.TrimSpace(findStringField(payload, "task_id", 5))
	}
	if taskID == "" {
		taskID = strings.TrimSpace(findStringField(payload, "id", 4))
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("HopBase Grok submit returned no request id: %s", truncateHopBaseGrokBody(respBody, 500)))
	}
	return s.pollHopBaseGrokVideoTask(ctx, pc, baseURL, apiKey, taskID)
}

func resolveHopBaseGrokReference(ctx context.Context, raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("empty reference url")
	}
	if strings.HasPrefix(value, "data:") || strings.HasPrefix(value, "/uploads/") {
		return localPathToDataURL(value)
	}
	return arkReferenceMediaURL(ctx, value)
}

func hopBaseGrokAspectRatioAllowed(value string) bool {
	switch value {
	case "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3":
		return true
	default:
		return false
	}
}

func hopBaseGrokVideoOutputURL(payload map[string]any) string {
	if video, ok := payload["video"].(map[string]any); ok {
		if outputURL := firstHTTPMediaURL(video); outputURL != "" {
			return outputURL
		}
	}
	if data, ok := payload["data"].(map[string]any); ok {
		if video, ok := data["video"].(map[string]any); ok {
			if outputURL := firstHTTPMediaURL(video); outputURL != "" {
				return outputURL
			}
		}
	}
	return ""
}

func (s *Service) pollHopBaseGrokVideoTask(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	queryPath := strings.TrimSpace(resolveVideoQueryPath(pc))
	if queryPath == "" {
		queryPath = hopBaseGrokVideoQueryPath
	}
	queryPath = strings.ReplaceAll(queryPath, "{taskId}", url.PathEscape(taskID))
	pollURL := resolveProviderURL(baseURL, queryPath)
	client := safehttp.Client(30 * time.Second)

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}
	var lastBody []byte
	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(videoPollInterval()):
			}
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build HopBase Grok query request", err)
		}
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(httpReq)
		if err != nil {
			continue
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastBody = respBody
		if resp.StatusCode >= 400 {
			return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
		}

		var payload map[string]any
		if json.Unmarshal(respBody, &payload) != nil {
			continue
		}
		status := strings.ToLower(strings.TrimSpace(findStringField(payload, "status", 5)))
		switch status {
		case "done", "completed", "succeeded", "success":
			if outputURL := hopBaseGrokVideoOutputURL(payload); outputURL != "" {
				return &GenerateResult{Type: "url", Content: outputURL}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("HopBase Grok video completed but no output URL was returned: %s", truncateHopBaseGrokBody(respBody, 800)))
		case "failed", "error", "expired", "cancelled", "canceled":
			message := strings.TrimSpace(findStringField(payload, "message", 5))
			if message == "" {
				message = strings.TrimSpace(findStringField(payload, "fail_reason", 5))
			}
			if message == "" {
				message = truncateHopBaseGrokBody(respBody, 500)
			}
			return nil, apperror.New(apperror.CodeInternal, "HopBase Grok video generation failed: "+message)
		}
	}
	if len(lastBody) > 0 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation timed out after polling. Last response: %s", truncateHopBaseGrokBody(lastBody, 800)))
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

func truncateHopBaseGrokBody(body []byte, limit int) string {
	if len(body) > limit {
		body = body[:limit]
	}
	return string(body)
}
