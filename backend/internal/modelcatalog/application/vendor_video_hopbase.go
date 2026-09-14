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

// HopBase Seedance contract: https://hop-base.com/en/docs/media/video
const (
	hopBaseVideoSubmitPath = "/v1/video/generate"
	hopBaseVideoQueryPath  = "/v1/video/tasks/{taskId}"
	hopBaseAssetPath       = "/v1/sd/assets"
)

// HopBase's async submit occasionally holds the HTTP response while the paid
// task has already been accepted upstream. Aborting that POST after a short
// client timeout creates an orphan: the provider keeps generating, but CCY
// never receives the task id and cannot reconcile the late success. Keep the
// non-idempotent submit alive for the same budget as video polling; the worker
// context remains the outer hard deadline.
func hopBaseVideoSubmitTimeout() time.Duration {
	return videoGenerationTimeout()
}

type hopBaseSeedanceCapabilities struct {
	is25        bool
	maxImages   int
	maxVideos   int
	maxAudios   int
	resolutions map[string]struct{}
}

func isHopBaseProvider(pc *domain.ProviderConfig, baseURL string) bool {
	values := []string{baseURL}
	if pc != nil {
		values = append(values, pc.Vendor, pc.Name)
	}
	joined := strings.ToLower(strings.Join(values, " "))
	return strings.Contains(joined, "hop-base.com") || strings.Contains(joined, "hopbase") || strings.Contains(joined, "hop base")
}

func hopBaseSeedanceCapabilitiesFor(model string) (hopBaseSeedanceCapabilities, bool) {
	model = strings.TrimSpace(model)
	set := func(values ...string) map[string]struct{} {
		out := make(map[string]struct{}, len(values))
		for _, value := range values {
			out[value] = struct{}{}
		}
		return out
	}
	switch model {
	case "dreamina-seedance-2-5-260628":
		return hopBaseSeedanceCapabilities{is25: true, maxImages: 30, maxVideos: 10, maxAudios: 10, resolutions: set("480p", "720p")}, true
	case "doubao-seedance-2-0-260128-a":
		return hopBaseSeedanceCapabilities{maxImages: 9, maxVideos: 3, maxAudios: 3, resolutions: set("480p", "720p", "1080p")}, true
	case "dreamina-seedance-2-0-hc", "dreamina-seedance-2-0-ep", "dreamina-seedance-2-0-260128":
		return hopBaseSeedanceCapabilities{maxImages: 9, maxVideos: 3, maxAudios: 3, resolutions: set("480p", "720p", "1080p", "4k")}, true
	case "dreamina-seedance-2-0-fast-hc", "dreamina-seedance-2-0-fast-ep", "dreamina-seedance-2-0-fast-260128",
		"dreamina-seedance-2-0-mini-hc", "dreamina-seedance-2-0-mini-ep", "dreamina-seedance-2-0-mini-260615":
		return hopBaseSeedanceCapabilities{maxImages: 9, maxVideos: 3, maxAudios: 3, resolutions: set("480p", "720p")}, true
	default:
		return hopBaseSeedanceCapabilities{}, false
	}
}

func (s *Service) generateVideoHopBase(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if err := validateHopBaseReferences(ctx, req); err != nil {
		return nil, err
	}
	caps, ok := hopBaseSeedanceCapabilitiesFor(req.Model)
	if !ok {
		return nil, apperror.New(apperror.CodeInvalidInput, "HopBase 当前仅支持已登记的 Seedance 2.5 / 2.0 型号")
	}

	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))
	if resolution == "" {
		resolution = "720p"
	}
	if _, allowed := caps.resolutions[resolution]; !allowed {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 不支持分辨率 %s", req.Model, resolution))
	}

	ratio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if ratio == "" || ratio == "auto" {
		ratio = "16:9"
	}
	if !hopBaseRatioAllowed(ratio) {
		return nil, apperror.New(apperror.CodeInvalidInput, "HopBase 视频比例仅支持 21:9、16:9、4:3、1:1、3:4、9:16 或 adaptive")
	}

	duration := req.Duration
	if caps.is25 {
		if duration == 0 {
			duration = -1
		}
		if duration != -1 && (duration < 4 || duration > 30) {
			return nil, apperror.New(apperror.CodeInvalidInput, "Seedance 2.5 时长必须为 4–30 秒，或使用 -1 自动时长")
		}
	} else if duration <= 0 {
		duration = 5
	}

	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	videoRefs := collectArkReferenceVideos(req)
	audioRefs := collectHopBaseReferenceAudios(req)
	if len(req.ReferenceImages) > caps.maxImages {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 最多支持 %d 张参考图", req.Model, caps.maxImages))
	}
	if len(videoRefs) > caps.maxVideos {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 最多支持 %d 个参考视频", req.Model, caps.maxVideos))
	}
	if len(audioRefs) > caps.maxAudios {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 最多支持 %d 个参考音频", req.Model, caps.maxAudios))
	}
	if !caps.is25 && len(audioRefs) > 0 && len(req.ReferenceImages) == 0 && len(videoRefs) == 0 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Seedance 2.0 音频参考必须同时提供图片或视频参考")
	}
	if (mode == "start_end" || mode == "first_frame" || mode == "start_frame") && len(req.ReferenceImages) > 2 {
		return nil, apperror.New(apperror.CodeInvalidInput, "首帧/首尾帧模式最多支持 2 张图片")
	}
	// HopBase documents adaptive ratio for Seedance 2.5 frame continuation and
	// video edit. Normalize it here so a stale UI choice cannot make a paid task
	// fail after submission. Video edit also requires automatic duration.
	if caps.is25 && (mode == "start_end" || mode == "first_frame" || mode == "start_frame" || mode == "video_edit") {
		ratio = "adaptive"
	}
	if caps.is25 && mode == "video_edit" {
		duration = -1
	}

	content := make([]map[string]any, 0, 1+len(req.ReferenceImages)+len(videoRefs)+len(audioRefs))
	if prompt := strings.TrimSpace(req.Prompt); prompt != "" {
		content = append(content, map[string]any{"type": "text", "text": prompt})
	}
	for i, raw := range req.ReferenceImages {
		assetURL := strings.TrimSpace(raw)
		// Seedance 2.5 has no asset-library route. It takes public image URLs
		// directly; keep the established asset flow for 2.0 only. The 2.5
		// provider's real-person reference restriction is not bypassed here.
		if caps.is25 && strings.HasPrefix(assetURL, "asset://") {
			return nil, apperror.New(apperror.CodeInvalidInput, "Seedance 2.5 不支持 asset:// 素材引用，请使用受支持的公开图片 URL")
		}
		if !strings.HasPrefix(assetURL, "asset://") {
			downloadableURL, err := hopBaseReferenceMediaURL(ctx, raw)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 地址处理失败", i+1), err)
			}
			publicURL, err := arkReferenceImageURL(ctx, downloadableURL)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 处理失败", i+1), err)
			}
			assetURL = publicURL
			if !caps.is25 {
				assetURL, err = s.createAndActivateHopBaseImageAsset(ctx, baseURL, apiKey, publicURL)
				if err != nil {
					return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("参考图 #%d 上传 HopBase 素材库失败", i+1), err)
				}
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
	for i, raw := range videoRefs {
		url, err := hopBaseReferenceMediaURL(ctx, raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考视频 #%d 处理失败", i+1), err)
		}
		content = append(content, map[string]any{
			"type": "video_url", "video_url": map[string]any{"url": url}, "role": "reference_video",
		})
	}
	for i, raw := range audioRefs {
		audioURL, err := hopBaseReferenceMediaURL(ctx, raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考音频 #%d 处理失败", i+1), err)
		}
		// Local WAV/MP3 size and duration were checked before any transfer;
		// the provider remains authoritative for external URL metadata.
		content = append(content, map[string]any{
			"type": "audio_url", "audio_url": map[string]any{"url": audioURL}, "role": "reference_audio",
		})
	}
	if len(content) == 0 {
		return nil, apperror.New(apperror.CodeInvalidInput, "提示词或参考素材至少需要提供一项")
	}

	body := map[string]any{
		"model": req.Model, "content": content, "duration": duration,
		"resolution": resolution, "ratio": ratio,
		"generate_audio": true, "watermark": false,
	}
	if caps.is25 {
		body["return_last_frame"] = true
	}
	if req.Seed != nil {
		body["seed"] = *req.Seed
	}
	// Let explicit advanced switches override product defaults, but never pass
	// arbitrary request fields through to the paid upstream endpoint.
	for _, key := range []string{"generate_audio", "watermark", "return_last_frame"} {
		if value, exists := req.Parameters[key]; exists {
			if typed, valid := value.(bool); valid {
				body[key] = typed
			}
		}
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encode HopBase video request", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, hopBaseVideoSubmitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build HopBase video request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(hopBaseVideoSubmitTimeout())
	resp, err := doProviderSubmitOnce(ctx, client, httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.ProviderRequestFailure(err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var submit map[string]any
	if err := json.Unmarshal(respBody, &submit); err != nil {
		return nil, apperror.ProviderResponseFailure(resp.StatusCode, respBody, "模型服务返回的任务数据无法解析，请检查接口兼容性")
	}
	if url := hopBaseVideoOutputURL(submit); url != "" {
		return &GenerateResult{Type: "url", Content: url}, nil
	}
	taskID := hopBaseTaskID(submit)
	if taskID == "" {
		return nil, apperror.ProviderResponseFailure(resp.StatusCode, respBody, "模型服务未返回任务编号，无法查询生成进度，请检查渠道接口")
	}
	if s.repo != nil && req.GenerationLogID != "" {
		providerID := ""
		if pc != nil {
			providerID = pc.ID
		}
		persistCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := s.repo.SetGenerationLogUpstreamTask(persistCtx, req.GenerationLogID, providerID, taskID); err != nil {
			// Do not fail an already-paid generation because diagnostic recovery
			// metadata could not be saved. The normal poll still proceeds.
			fmt.Printf("[modelcatalog] failed to persist HopBase task id for log %s: %v\n", req.GenerationLogID, err)
		}
		cancel()
	}
	return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, taskID)
}

// Accept either frontend wire shape while preserving order and avoiding a
// duplicated first sample when a client sends both the single and list fields.
func collectHopBaseReferenceAudios(req GenerateRequest) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(req.ReferenceAudios)+1)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	add(req.ReferenceAudio)
	for _, value := range req.ReferenceAudios {
		add(value)
	}
	return out
}

func (s *Service) createAndActivateHopBaseImageAsset(ctx context.Context, baseURL, apiKey, publicURL string) (string, error) {
	publicURL = strings.TrimSpace(publicURL)
	parsed, err := url.Parse(publicURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("HopBase 素材库仅接受公网可访问的 HTTP(S) 图片 URL")
	}

	bodyJSON, err := json.Marshal(map[string]any{
		"AssetType": "Image",
		"URL":       publicURL,
	})
	if err != nil {
		return "", fmt.Errorf("编码 HopBase 素材请求失败: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, hopBaseAssetPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return "", fmt.Errorf("创建 HopBase 素材请求失败: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(30 * time.Second)
	resp, err := doProviderSubmitOnce(ctx, client, httpReq, bodyJSON)
	if err != nil {
		return "", fmt.Errorf("%s: %w", providerRequestErrorMessage(err), err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return "", parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var payload map[string]any
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return "", fmt.Errorf("HopBase 素材创建响应无效: %s", string(respBody[:min(len(respBody), 500)]))
	}
	assetID := hopBaseAssetField(hopBaseAssetScope(payload), "Id")
	if assetID == "" {
		return "", fmt.Errorf("HopBase 素材创建响应缺少 Id: %s", string(respBody[:min(len(respBody), 500)]))
	}
	return s.pollHopBaseImageAsset(ctx, baseURL, apiKey, assetID)
}

func (s *Service) pollHopBaseImageAsset(ctx context.Context, baseURL, apiKey, assetID string) (string, error) {
	client := safehttp.Client(30 * time.Second)
	pollURL := resolveProviderURL(baseURL, hopBaseAssetPath+"/"+url.PathEscape(assetID))
	var lastBody []byte
	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return "", fmt.Errorf("等待 HopBase 素材激活超时")
			case <-time.After(videoPollInterval()):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return "", fmt.Errorf("创建 HopBase 素材查询请求失败: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastBody = body
		if resp.StatusCode >= 400 {
			return "", parseProviderErrorBytes(resp.StatusCode, body)
		}
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil {
			continue
		}
		status := strings.ToLower(hopBaseAssetField(hopBaseAssetScope(payload), "Status"))
		switch status {
		case "active":
			return "asset://" + assetID, nil
		case "failed", "error", "inactive", "rejected", "deleted":
			message := hopBaseAssetField(hopBaseAssetScope(payload), "Message")
			if message == "" {
				message = string(body[:min(len(body), 500)])
			}
			return "", fmt.Errorf("HopBase 素材激活失败: %s", message)
		}
	}
	if len(lastBody) > 0 {
		return "", fmt.Errorf("等待 HopBase 素材激活超时，最后响应: %s", string(lastBody[:min(len(lastBody), 500)]))
	}
	return "", fmt.Errorf("等待 HopBase 素材激活超时")
}

func hopBaseAssetScope(payload map[string]any) map[string]any {
	for key, value := range payload {
		if strings.EqualFold(key, "data") {
			if data, ok := value.(map[string]any); ok {
				return data
			}
		}
	}
	return payload
}

func hopBaseAssetField(payload map[string]any, name string) string {
	for key, value := range payload {
		if strings.EqualFold(key, name) && value != nil {
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func hopBaseRatioAllowed(ratio string) bool {
	switch ratio {
	case "21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive":
		return true
	default:
		return false
	}
}

func hopBaseTaskID(payload map[string]any) string {
	if task, ok := payload["task"].(map[string]any); ok {
		if id, ok := task["id"].(string); ok {
			return strings.TrimSpace(id)
		}
	}
	if data, ok := payload["data"].(map[string]any); ok {
		if task, ok := data["task"].(map[string]any); ok {
			if id, ok := task["id"].(string); ok {
				return strings.TrimSpace(id)
			}
		}
	}
	return strings.TrimSpace(findStringField(payload, "task_id", 4))
}

func hopBaseTaskScope(payload map[string]any) map[string]any {
	if task, ok := payload["task"].(map[string]any); ok {
		return task
	}
	if data, ok := payload["data"].(map[string]any); ok {
		if task, ok := data["task"].(map[string]any); ok {
			return task
		}
		return data
	}
	return payload
}

func hopBaseVideoOutputURL(payload map[string]any) string {
	scope := hopBaseTaskScope(payload)
	scopes := []map[string]any{scope}
	if scope != nil && len(payload) > 0 {
		scopes = append(scopes, payload)
	}
	for _, candidate := range scopes {
		for _, key := range []string{"outputs", "output"} {
			if url := firstHTTPMediaURL(candidate[key]); url != "" {
				return url
			}
		}
		if url := findStringField(candidate, "video_url", 5); strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
			return url
		}
	}
	return ""
}

func firstHTTPMediaURL(value any) string {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, "http://") || strings.HasPrefix(typed, "https://") {
			return typed
		}
	case []any:
		for _, item := range typed {
			if url := firstHTTPMediaURL(item); url != "" {
				return url
			}
		}
	case map[string]any:
		for _, key := range []string{"video_url", "url"} {
			if url := firstHTTPMediaURL(typed[key]); url != "" {
				return url
			}
		}
	}
	return ""
}

func (s *Service) pollHopBaseVideoTask(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second)
	pollURL := resolveProviderURL(baseURL, strings.ReplaceAll(hopBaseVideoQueryPath, "{taskId}", taskID))
	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeTimeout, "模型任务等待超时，尚未取得生成结果；请先检查任务状态，避免重复提交")
	case <-time.After(videoPollInitialDelay()):
	}
	var lastBody []byte
	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeTimeout, "模型任务等待超时，尚未取得生成结果；请先检查任务状态，避免重复提交")
			case <-time.After(videoPollInterval()):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastBody = body
		if resp.StatusCode >= 400 {
			return nil, parseProviderErrorBytes(resp.StatusCode, body)
		}
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil {
			continue
		}
		scope := hopBaseTaskScope(payload)
		status := strings.ToLower(strings.TrimSpace(fmt.Sprint(scope["status"])))
		switch status {
		case "completed", "succeeded", "success":
			if url := hopBaseVideoOutputURL(payload); url != "" {
				return &GenerateResult{Type: "url", Content: url}, nil
			}
			return nil, apperror.ProviderResponseFailure(resp.StatusCode, body, "模型任务报告完成，但未返回生成结果，请检查渠道返回格式")
		case "failed", "error", "failure", "cancelled", "canceled":
			return nil, apperror.ProviderFailure(resp.StatusCode, body)
		}
	}
	if len(lastBody) > 0 {
		return nil, apperror.Wrap(apperror.CodeTimeout, "视频任务查询超时，上游是否完成尚未确认；请先检查任务状态，避免重复提交", fmt.Errorf("last polling response: %.800s", lastBody))
	}
	return nil, apperror.New(apperror.CodeTimeout, "视频任务查询超时，上游是否完成尚未确认；请先检查任务状态，避免重复提交")
}
