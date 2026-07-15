package application

import (
	"bytes"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Service) generateVideo(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	// Volcengine ark uses a different async-task contract (path + payload + status
	// vocabulary) than the sora-style /videos endpoint. Route only providers that
	// actually use the Ark task contract, not every custom provider with explicit
	// submit/query paths.
	if ResolveProfile(pc).ID == "ark" {
		return s.generateVideoArk(ctx, pc, baseURL, apiKey, req)
	}
	if ResolveProfile(pc).ID == "dmxapi" {
		return s.generateVideoDMX(ctx, pc, baseURL, apiKey, req)
	}
	if ResolveProfile(pc).ID == "dashscope" {
		return s.generateVideoDashScope(ctx, pc, baseURL, apiKey, req)
	}
	// apimart.ai 中转站:视频与图像同构 —— 「POST /videos/generations 提交 →
	// data[0].task_id → GET /tasks/{id} 轮询,结果在 data.result.videos[].url」。
	// 按 base_url 嗅探,必须放在 isManjuChatVideoModel 之前:apimart 也有
	// grok-imagine 视频,其模型名前缀会被 isManjuChatVideoModel 误判为 Manju。
	if isApimartBaseURL(baseURL) {
		return s.generateVideoApimart(ctx, pc, baseURL, apiKey, req)
	}
	// Manju 中转站(manjuapi.com)的视频模型走「POST /chat/completions 提交 →
	// GET /videos/{id} 轮询」的私有约定，而不是 sora-style /videos。按模型名
	// 嗅探路由(sora2 / "Veo 3.1 Fast 1080p" / grok-imagine-video 是中转站
	// 专有的命名，与标准 /videos 家族的 sora-2/sora-v3 不冲突)。
	if isManjuChatVideoModel(req.Model) {
		return s.generateVideoChatCompletions(ctx, pc, baseURL, apiKey, req)
	}
	aspectRatio := req.AspectRatio
	if aspectRatio == "" {
		aspectRatio = req.Size
	}
	if aspectRatio == "" {
		aspectRatio = "16:9"
	}
	resolution := req.Resolution
	if resolution == "" {
		resolution = "720p"
	}
	duration := req.Duration
	if duration <= 0 {
		duration = 5
	}
	submitPath := resolveVideoSubmitPath(pc)
	queryPath := resolveVideoQueryPath(pc)

	body := map[string]interface{}{
		"model":        req.Model,
		"prompt":       req.Prompt,
		"aspect_ratio": aspectRatio,
		"resolution":   resolution,
		"duration":     duration,
	}
	if len(req.ReferenceImages) > 0 {
		resolved := make([]string, 0, len(req.ReferenceImages))
		for _, ref := range req.ReferenceImages {
			du, err := localPathToDataURL(ref)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image: %v", err), err)
			}
			resolved = append(resolved, du)
		}
		body["reference_images"] = resolved
		mode := req.ReferenceMode
		if mode == "" {
			mode = "auto"
		}
		body["reference_mode"] = mode
	}
	if req.ReferenceVideo != "" {
		body["reference_video"] = req.ReferenceVideo
	}
	if len(req.ReferenceVideos) > 0 {
		body["reference_videos"] = req.ReferenceVideos
	}
	if strings.TrimSpace(req.EditOperation) != "" {
		body["edit_operation"] = req.EditOperation
	}
	if req.TrimRange != nil {
		body["trim_range"] = req.TrimRange
	}
	if req.CropRect != nil {
		body["crop_rect"] = req.CropRect
	}
	if len(req.TargetTracks) > 0 {
		body["target_tracks"] = req.TargetTracks
	}
	if strings.TrimSpace(req.OutputFormat) != "" {
		body["output_format"] = req.OutputFormat
	}
	if strings.TrimSpace(req.DeriveFromNodeID) != "" {
		body["derive_from_node_id"] = req.DeriveFromNodeID
	}
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	// Parse task ID from response — format: { id: "..." } or { task_id: "..." }
	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse submit response: %s", string(respBody[:min(len(respBody), 300)])))
	}

	taskID := ""
	if id, ok := submitResp["id"].(string); ok && id != "" {
		taskID = id
	} else if id, ok := submitResp["task_id"].(string); ok && id != "" {
		taskID = id
	}
	if taskID == "" {
		// Maybe result is already inline (synchronous provider).
		if videoURL, ok := submitResp["video_url"].(string); ok && videoURL != "" {
			return &GenerateResult{Type: "url", Content: videoURL}, nil
		}
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoTask(ctx, baseURL, apiKey, queryPath, taskID)
}

// collectArkReferenceVideos gathers all reference videos for the Ark
// content array, de-duplicating the single ReferenceVideo against the
// ReferenceVideos slice (the frontend may populate either depending on
// how many videos are connected). Returns raw paths/URLs; the caller
// resolves each to a data URL.
func collectArkReferenceVideos(req GenerateRequest) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(req.ReferenceVideos)+1)
	add := func(v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	add(req.ReferenceVideo)
	for _, v := range req.ReferenceVideos {
		add(v)
	}
	return out
}

// generateVideoArk talks to Volcengine ark's async video API
// (POST /contents/generations/tasks → poll /contents/generations/tasks/{id}).
// The submit/query endpoints come from ProviderConfig so other custom vendors
// that mimic this shape can reuse the path. The request payload differs from
// sora-style /videos: prompt and references go into a `content` array of
// {type:"text"|"image_url", ...} items, and completion is signalled by
// status=="succeeded" with the URL at content.video_url.
func (s *Service) generateVideoArk(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	submitPath := resolveVideoSubmitPath(pc)
	queryPath := resolveVideoQueryPath(pc)
	if !strings.HasPrefix(submitPath, "/") {
		submitPath = "/" + submitPath
	}
	if !strings.HasPrefix(queryPath, "/") {
		queryPath = "/" + queryPath
	}

	ratio := strings.TrimSpace(req.AspectRatio)
	if ratio == "" {
		ratio = strings.TrimSpace(req.Size)
	}
	if ratio == "" || strings.EqualFold(ratio, "auto") {
		ratio = "adaptive"
	}
	duration := req.Duration
	if duration <= 0 {
		duration = 5
	}

	if len(req.ReferenceImages) > 2 && !isSeedance20Model(req.Model) {
		return nil, apperror.New(
			apperror.CodeInvalidInput,
			"当前 Seedance 模型最多支持 2 张参考图；1~9 张多图参考仅支持 Seedance 2.0 系列。",
		)
	}

	content := make([]map[string]interface{}, 0, 1+len(req.ReferenceImages))
	if strings.TrimSpace(req.Prompt) != "" {
		content = append(content, map[string]interface{}{
			"type": "text",
			"text": req.Prompt,
		})
	}
	// Role assignment is driven by the explicit reference_mode, not by the
	// image count. Ark/Seedance 要求 content 里每张图都带 role,否则报
	// 400 "role must be specified for image contents"。
	//   start_end   → img[0]=first_frame, img[1]=last_frame(第 3 张起兜 reference_image)
	//   start_frame → img[0]=first_frame(其余 reference_image)
	//   其它(多图/全能/动作参考)→ 全部 reference_image(主体一致性参考)
	useFrameRoles := req.ReferenceMode == "start_end" || req.ReferenceMode == "start_frame"
	for i, raw := range req.ReferenceImages {
		// Hand Ark a URL it can download itself — our own private object-store
		// objects get a short-lived signed URL. Ark/Seedance rejects base64 data
		// URLs and 403s on private links, so a reachable (signed) URL is the
		// contract. arkReferenceImageURL also normalizes any image outside Ark's
		// 300–6000px bounds (uploads a rescaled copy) to avoid WidthTooLarge.
		refURL, err := arkReferenceImageURL(ctx, raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 处理失败", i+1), err)
		}
		role := "reference_image"
		if useFrameRoles {
			if i == 0 {
				role = "first_frame"
			} else if i == 1 {
				role = "last_frame"
			}
		}
		content = append(content, map[string]interface{}{
			"type":      "image_url",
			"image_url": map[string]interface{}{"url": refURL},
			"role":      role,
		})
	}

	// Motion-mimic / video-edit reference videos ride in the same content
	// array as video_url items so Ark can condition on them. Same URL contract
	// as images (a signed URL for private objects) — video can't be inlined.
	for _, rawVid := range collectArkReferenceVideos(req) {
		refURL, err := arkReferenceMediaURL(ctx, rawVid)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考视频处理失败", err)
		}
		content = append(content, map[string]interface{}{
			"type":      "video_url",
			"video_url": map[string]interface{}{"url": refURL},
		})
	}

	body := map[string]interface{}{
		"model":     req.Model,
		"content":   content,
		"ratio":     ratio,
		"duration":  duration,
		"watermark": false,
	}
	if req.Resolution != "" {
		body["resolution"] = req.Resolution
	}
	if strings.TrimSpace(req.EditOperation) != "" {
		body["edit_operation"] = req.EditOperation
	}
	if req.TrimRange != nil {
		body["trim_range"] = req.TrimRange
	}
	if req.CropRect != nil {
		body["crop_rect"] = req.CropRect
	}
	if len(req.TargetTracks) > 0 {
		body["target_tracks"] = req.TargetTracks
	}
	if strings.TrimSpace(req.OutputFormat) != "" {
		body["output_format"] = req.OutputFormat
	}
	if strings.TrimSpace(req.DeriveFromNodeID) != "" {
		body["derive_from_node_id"] = req.DeriveFromNodeID
	}
	bodyJSON, _ := json.Marshal(body)

	submitURL := baseURL + submitPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build submit request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse submit response: %s", string(respBody[:min(len(respBody), 300)])))
	}
	taskID, _ := submitResp["id"].(string)
	if taskID == "" {
		if id, ok := submitResp["task_id"].(string); ok {
			taskID = id
		}
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoArkTask(ctx, baseURL, queryPath, apiKey, taskID)
}

// pollVideoArkTask polls a Volcengine-style async task until status=="succeeded"
// or "failed". The status vocabulary is queued / running / succeeded / failed
// (note: succeeded, not completed). The completed URL lives at content.video_url.
func (s *Service) pollVideoArkTask(ctx context.Context, baseURL, queryPath, apiKey, taskID string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	pollURL := baseURL + strings.ReplaceAll(queryPath, "{taskId}", taskID)

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}

	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
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

		var taskResp map[string]interface{}
		if json.Unmarshal(body, &taskResp) != nil {
			continue
		}

		status := strings.ToLower(fmt.Sprintf("%v", taskResp["status"]))
		switch status {
		case "failed", "error", "cancelled", "canceled":
			msg := ""
			if e, ok := taskResp["error"].(map[string]interface{}); ok {
				if m, ok := e["message"].(string); ok {
					msg = m
				}
				if c, ok := e["code"].(string); ok && c != "" {
					msg = c + ": " + msg
				}
			}
			if msg == "" {
				msg = string(body[:min(len(body), 500)])
			}
			return nil, apperror.New(apperror.CodeInternal, "Video generation failed: "+msg)
		case "succeeded", "success", "completed":
			if c, ok := taskResp["content"].(map[string]interface{}); ok {
				if u, ok := c["video_url"].(string); ok && u != "" {
					return &GenerateResult{Type: "url", Content: u}, nil
				}
			}
			if u := findStringField(taskResp, "video_url", 5); u != "" {
				return &GenerateResult{Type: "url", Content: u}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task succeeded but no video_url found. Raw: %s", string(body[:min(len(body), 800)])))
		}
		// queued / running / unknown — keep polling.
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// generateVideoDashScope talks to Alibaba DashScope's async video API
// (POST /services/aigc/video-generation/video-synthesis → poll /tasks/{id}).
// The request uses a nested {model, input:{prompt,media}, parameters:{resolution,duration}}
// shape with X-DashScope-Async header, and the response nests task_id under output.
func (s *Service) generateVideoDashScope(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	submitPath := resolveVideoSubmitPath(pc)
	queryPath := resolveVideoQueryPath(pc)
	if !strings.HasPrefix(submitPath, "/") {
		submitPath = "/" + submitPath
	}
	if !strings.HasPrefix(queryPath, "/") {
		queryPath = "/" + queryPath
	}

	// Defense-in-depth: reject documented-constraint violations locally.
	if err := validateDashScopeVideoRequest(req); err != nil {
		return nil, err
	}

	input := map[string]interface{}{}
	if strings.TrimSpace(req.Prompt) != "" {
		input["prompt"] = req.Prompt
	}
	// Build the input.media array. Unlike a pure images check, video-edit may
	// carry ONLY a source video (0 reference images), so we always build and
	// then attach media when non-empty. t2v yields an empty slice → no media.
	media, err := buildDashScopeVideoMedia(ctx, req)
	if err != nil {
		return nil, err
	}
	if len(media) > 0 {
		input["media"] = media
	}

	parameters := buildDashScopeVideoParameters(req)

	body := map[string]interface{}{
		"model":      req.Model,
		"input":      input,
		"parameters": parameters,
	}
	bodyJSON, _ := json.Marshal(body)

	submitURL := baseURL + submitPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build submit request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-DashScope-Async", "enable")

	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		// DashScope sometimes returns an empty 404 when the API key's
		// region doesn't match the model (e.g. Singapore key hitting
		// the Beijing-only HappyHorse models), when HappyHorse isn't
		// subscribed for this account, or when baseURL was edited wrong.
		// Surface the exact URL + status so the user can diagnose
		// region / quota / baseURL mismatches instead of staring at
		// "<empty body>".
		if resp.StatusCode == http.StatusNotFound && len(bytes.TrimSpace(respBody)) == 0 {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf(
				"Provider HTTP 404 (empty body) at %s — model %q not found. Check (1) API key region matches the model (HappyHorse 1.1 = cn-beijing only), (2) HappyHorse subscription is enabled in DashScope console, (3) baseURL is %q.",
				submitURL, req.Model, "https://dashscope.aliyuncs.com/api/v1",
			))
		}
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse submit response: %s", string(respBody[:min(len(respBody), 300)])))
	}

	taskID := ""
	if output, ok := submitResp["output"].(map[string]interface{}); ok {
		if id, ok := output["task_id"].(string); ok {
			taskID = id
		}
	}
	if taskID == "" {
		if id, ok := submitResp["task_id"].(string); ok {
			taskID = id
		}
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoDashScopeTask(ctx, baseURL, queryPath, apiKey, taskID)
}

// isKlingDashScopeModel reports whether the model is 可灵 Kling hosted on the
// Aliyun 百炼 DashScope channel (ids are prefixed "kling/", e.g.
// "kling/kling-v3-video-generation").
func isKlingDashScopeModel(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "kling/")
}

// buildKlingVideoParameters — 可灵的参数集与万相/HappyHorse 不同：
//   - mode(std/pro) 由分辨率档位换算（1080P→pro 默认、720P→std），不发 resolution；
//   - 宽高比键名是 aspect_ratio（万相是 ratio），仅文生/参考生场景发送 —
//     图生（首帧/首尾帧）与视频编辑跟随输入素材，发送会被拒；
//   - duration 3~15s（传入视频时上限 10s）；
//   - audio 是布尔（是否生成音效），复用 audioSetting 通道（"on" → true），
//     传入视频（base）时文档规定只能 false；
//   - 无 seed；水印沿用产品口径：不加。
func buildKlingVideoParameters(req GenerateRequest) map[string]interface{} {
	parameters := map[string]interface{}{"watermark": false}

	mode := "pro"
	if strings.EqualFold(strings.TrimSpace(req.Resolution), "720p") {
		mode = "std"
	}
	parameters["mode"] = mode

	refMode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	isVideoEdit := refMode == "video_edit"

	if req.Duration > 0 {
		duration := req.Duration
		if duration < 3 {
			duration = 3
		}
		maxDuration := 15
		if isVideoEdit {
			maxDuration = 10
		}
		if duration > maxDuration {
			duration = maxDuration
		}
		parameters["duration"] = duration
	}

	aspectAllowed := refMode == "" || refMode == "auto" || refMode == "image_reference"
	if r := strings.TrimSpace(req.AspectRatio); r != "" && !strings.EqualFold(r, "auto") && aspectAllowed {
		parameters["aspect_ratio"] = r
	}

	audio := strings.EqualFold(strings.TrimSpace(req.AudioSetting), "on")
	if isVideoEdit {
		audio = false
	}
	parameters["audio"] = audio
	return parameters
}

func buildDashScopeVideoParameters(req GenerateRequest) map[string]interface{} {
	if isKlingDashScopeModel(req.Model) {
		return buildKlingVideoParameters(req)
	}
	parameters := map[string]interface{}{
		// Intentional product choice: HappyHorse's default is watermark=true
		// ("Happy Horse" bottom-right), but we deliberately ship watermark-free
		// output. This overrides the doc default on purpose — not a bug.
		"watermark": false,
	}
	if req.Resolution != "" {
		parameters["resolution"] = req.Resolution
	}

	// Per the DashScope HappyHorse docs, ratio is accepted ONLY by 文生(t2v)
	// and 参考生(r2v). 首帧(i2v) output aspect auto-follows the first frame and
	// 视频编辑(video-edit) follows the source video — both REJECT aspect_ratio.
	// duration is accepted by t2v/i2v/r2v but NOT video-edit (follows source).
	// audio_setting is video-edit-ONLY. Gate each per mode.
	model := strings.ToLower(strings.TrimSpace(req.Model))
	isI2V := strings.HasPrefix(model, "happyhorse-") && strings.HasSuffix(model, "-i2v")
	// Share the video-edit predicate with the media builder + validator so all
	// three agree on suffix OR reference_mode==video_edit.
	isVideoEdit := isDashScopeVideoEdit(req)

	if req.Duration > 0 && !isVideoEdit {
		parameters["duration"] = req.Duration
	}
	if req.AspectRatio != "" && req.AspectRatio != "auto" && !isI2V && !isVideoEdit {
		// DashScope's video-synthesis parameter is "ratio" (NOT "aspect_ratio").
		// Sending the wrong key made DashScope ignore it and fall back to its
		// 16:9 default — the cause of "picked 9:16 but got 16:9".
		parameters["ratio"] = req.AspectRatio
	}
	if isVideoEdit {
		// Default "auto"; only "origin" is the other valid value.
		audio := strings.ToLower(strings.TrimSpace(req.AudioSetting))
		if audio != "origin" {
			audio = "auto"
		}
		parameters["audio_setting"] = audio
	}
	if req.Seed != nil {
		parameters["seed"] = *req.Seed
	}
	return parameters
}

var happyHorseResolutions = map[string]bool{"720p": true, "1080p": true}

var happyHorseRatios = map[string]bool{
	"16:9": true, "9:16": true, "1:1": true, "4:3": true, "3:4": true,
	"4:5": true, "5:4": true, "9:21": true, "21:9": true,
}

// validateDashScopeVideoRequest is defense-in-depth for the documented
// HappyHorse constraints, so a malformed direct API call (or a frontend bug)
// fails locally with a clear message instead of spending an upstream request.
// Only HappyHorse models carry these constraints; other DashScope video models
// pass through untouched.
var klingRatios = map[string]bool{"16:9": true, "9:16": true, "1:1": true}

// validateKlingVideoRequest — 可灵（百炼渠道）的本地约束校验（文档 2026-07）：
// 标准版仅支持文生/首帧/首尾帧；Omni 额外支持参考生（refer ≤7）与视频编辑
//（base 1 段 + refer ≤4）。宽高比仅 16:9/9:16/1:1，时长 3~15s。
func validateKlingVideoRequest(req GenerateRequest) error {
	model := strings.ToLower(strings.TrimSpace(req.Model))
	isOmni := strings.Contains(model, "omni")
	refMode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	imgs := len(req.ReferenceImages)
	vids := len(req.ReferenceVideos)
	if strings.TrimSpace(req.ReferenceVideo) != "" {
		vids++
	}

	if r := strings.TrimSpace(req.AspectRatio); r != "" && !strings.EqualFold(r, "auto") && !klingRatios[r] {
		return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("宽高比 %q 无效，可灵仅支持 16:9 / 9:16 / 1:1", req.AspectRatio))
	}
	if req.Duration > 0 && (req.Duration < 3 || req.Duration > 15) {
		return apperror.New(apperror.CodeInvalidInput, "可灵视频时长需为 3~15 秒之间的整数")
	}

	switch refMode {
	case "", "auto":
		if imgs > 0 || vids > 0 {
			return apperror.New(apperror.CodeInvalidInput, "文生视频不接受参考媒体，请切换到对应的参考模式")
		}
	case "first_frame":
		if imgs != 1 || vids > 0 {
			return apperror.New(apperror.CodeInvalidInput, "首帧模式需要且仅需 1 张图片")
		}
	case "start_end":
		if imgs < 1 || imgs > 2 || vids > 0 {
			return apperror.New(apperror.CodeInvalidInput, "首尾帧模式需要 1~2 张图片（首帧必填，尾帧可选）")
		}
	case "image_reference":
		if !isOmni {
			return apperror.New(apperror.CodeInvalidInput, "参考生视频仅 Omni 版可灵支持")
		}
		if imgs < 1 || imgs > 7 || vids > 0 {
			return apperror.New(apperror.CodeInvalidInput, "参考生需要 1~7 张参考图")
		}
	case "video_edit":
		if !isOmni {
			return apperror.New(apperror.CodeInvalidInput, "视频编辑仅 Omni 版可灵支持")
		}
		if vids != 1 {
			return apperror.New(apperror.CodeInvalidInput, "视频编辑需要且仅需 1 段待编辑视频")
		}
		if imgs > 4 {
			return apperror.New(apperror.CodeInvalidInput, "视频编辑最多 4 张参考图")
		}
	}
	return nil
}

func validateDashScopeVideoRequest(req GenerateRequest) error {
	model := strings.ToLower(strings.TrimSpace(req.Model))
	if isKlingDashScopeModel(model) {
		return validateKlingVideoRequest(req)
	}
	if !strings.HasPrefix(model, "happyhorse-") {
		return nil
	}
	isT2V := strings.HasSuffix(model, "-t2v")
	isI2V := strings.HasSuffix(model, "-i2v")
	isR2V := strings.HasSuffix(model, "-r2v")
	isVideoEdit := strings.HasSuffix(model, "-video-edit")

	if res := strings.ToLower(strings.TrimSpace(req.Resolution)); res != "" && !happyHorseResolutions[res] {
		return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("分辨率 %q 无效，仅支持 720P / 1080P", req.Resolution))
	}
	if isT2V || isR2V {
		if r := strings.TrimSpace(req.AspectRatio); r != "" && !strings.EqualFold(r, "auto") && !happyHorseRatios[r] {
			return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("宽高比 %q 无效", req.AspectRatio))
		}
	}
	if !isVideoEdit && req.Duration > 0 && (req.Duration < 3 || req.Duration > 15) {
		return apperror.New(apperror.CodeInvalidInput, "视频时长需为 3~15 秒之间的整数")
	}
	if req.Seed != nil && (*req.Seed < 0 || *req.Seed > 2147483647) {
		return apperror.New(apperror.CodeInvalidInput, "seed 需在 0~2147483647 之间")
	}

	imgs := len(req.ReferenceImages)
	hasVideo := strings.TrimSpace(req.ReferenceVideo) != "" || len(req.ReferenceVideos) > 0
	switch {
	case isT2V:
		if imgs > 0 || hasVideo {
			return apperror.New(apperror.CodeInvalidInput, "文生不接受任何参考媒体")
		}
	case isI2V:
		if imgs != 1 {
			return apperror.New(apperror.CodeInvalidInput, "首帧模式需要且仅需 1 张图片")
		}
		if hasVideo {
			return apperror.New(apperror.CodeInvalidInput, "首帧模式不接受视频参考")
		}
	case isR2V:
		if imgs < 1 || imgs > 9 {
			return apperror.New(apperror.CodeInvalidInput, "参考生需要 1~9 张参考图")
		}
		if hasVideo {
			return apperror.New(apperror.CodeInvalidInput, "参考生只接受参考图，不接受视频")
		}
	case isVideoEdit:
		if imgs > 5 {
			return apperror.New(apperror.CodeInvalidInput, "视频编辑最多 5 张参考图")
		}
		vids := len(req.ReferenceVideos)
		if strings.TrimSpace(req.ReferenceVideo) != "" {
			vids++
		}
		if vids != 1 {
			return apperror.New(apperror.CodeInvalidInput, "视频编辑需要且仅需 1 段源视频")
		}
	}
	return nil
}

// videoEditPresignTTL bounds how long the signed source-video URL stays valid.
// DashScope's async video-edit runs ~1-5min, then the model fetches the media;
// 1h comfortably covers submit → queue → fetch without over-exposing the object.
const videoEditPresignTTL = time.Hour

// buildKlingVideoMedia — 可灵（百炼渠道）的 media 词汇与万相/HappyHorse 不同：
// 逐素材角色 first_frame / last_frame / refer / base，且图片必须是可公开访问的
// HTTP(S) URL（文档不接受 base64）——私有 COS 对象照视频编辑的做法预签名。
func buildKlingVideoMedia(ctx context.Context, req GenerateRequest) ([]map[string]interface{}, error) {
	media := make([]map[string]interface{}, 0, len(req.ReferenceImages)+1)
	refMode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))

	if refMode == "video_edit" {
		videoURL := strings.TrimSpace(req.ReferenceVideo)
		if videoURL == "" && len(req.ReferenceVideos) > 0 {
			videoURL = strings.TrimSpace(req.ReferenceVideos[0])
		}
		if videoURL == "" {
			return nil, apperror.New(apperror.CodeInvalidInput, "视频编辑需要连接 1 段待编辑视频")
		}
		publicURL, err := resolveDashScopePublicVideoURL(ctx, videoURL)
		if err != nil {
			return nil, err
		}
		media = append(media, map[string]interface{}{
			"type": "base",
			"url":  publicURL,
		})
	}

	for i, raw := range req.ReferenceImages {
		publicURL, err := resolveKlingPublicImageURL(ctx, raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图片 #%d 处理失败", i+1), err)
		}
		role := "first_frame"
		switch refMode {
		case "start_end":
			if i > 0 {
				role = "last_frame"
			}
		case "image_reference", "video_edit":
			role = "refer"
		}
		media = append(media, map[string]interface{}{
			"type": role,
			"url":  publicURL,
		})
	}
	return media, nil
}

// resolveKlingPublicImageURL turns a reference-image URL into one DashScope 可灵
// can fetch. Mirrors resolveDashScopePublicVideoURL: presign private COS
// objects, pass public URLs through, reject base64/local paths (可灵图片要求
// HTTP/HTTPS，不接受 data URL).
func resolveKlingPublicImageURL(ctx context.Context, rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if strings.HasPrefix(rawURL, "data:") {
		return "", apperror.New(apperror.CodeInvalidInput, "可灵参考图片必须是可公开访问的 URL，不支持 base64")
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return "", apperror.New(apperror.CodeInvalidInput, "可灵参考图片必须是公网可访问的 URL")
	}
	if signed, err := assetstore.PresignGet(ctx, rawURL, videoEditPresignTTL); err == nil && signed != "" {
		return signed, nil
	}
	return rawURL, nil
}

func buildDashScopeVideoMedia(ctx context.Context, req GenerateRequest) ([]map[string]interface{}, error) {
	if isKlingDashScopeModel(req.Model) {
		return buildKlingVideoMedia(ctx, req)
	}
	media := make([]map[string]interface{}, 0, len(req.ReferenceImages)+1)

	// 视频编辑(video-edit): the DashScope contract requires exactly 1
	// {type:"video"} element (the clip to edit) plus 0-5 {type:"reference_image"}.
	// The video must be a PUBLIC, fetchable URL — never base64 (doc forbids it and
	// a 100MB clip is unencodable via the image-only localPathToDataURL). Our
	// uploads live in a private COS bucket, so presign the object to a
	// time-limited signed URL DashScope can GET.
	if isDashScopeVideoEdit(req) {
		videoURL := strings.TrimSpace(req.ReferenceVideo)
		if videoURL == "" && len(req.ReferenceVideos) > 0 {
			videoURL = strings.TrimSpace(req.ReferenceVideos[0])
		}
		if videoURL == "" {
			return nil, apperror.New(apperror.CodeInvalidInput, "视频编辑需要连接 1 段待编辑视频")
		}
		publicURL, err := resolveDashScopePublicVideoURL(ctx, videoURL)
		if err != nil {
			return nil, err
		}
		media = append(media, map[string]interface{}{
			"type": "video",
			"url":  publicURL,
		})
	}

	// Reference images: first_frame (i2v) / reference_image (r2v, video-edit).
	// Images may be base64 data URLs (<=20MB) — localPathToDataURL handles that.
	mediaType := dashScopeReferenceImageMediaType(req)
	for i, raw := range req.ReferenceImages {
		du, err := localPathToDataURL(raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
		}
		media = append(media, map[string]interface{}{
			"type": mediaType,
			"url":  du,
		})
	}
	return media, nil
}

// isDashScopeVideoEdit reports whether the request targets HappyHorse video-edit,
// keying off either the model suffix or the resolved reference_mode.
func isDashScopeVideoEdit(req GenerateRequest) bool {
	model := strings.ToLower(strings.TrimSpace(req.Model))
	if strings.HasPrefix(model, "happyhorse-") && strings.HasSuffix(model, "-video-edit") {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(req.ReferenceMode), "video_edit")
}

// resolveDashScopePublicVideoURL turns a source-video reference into a URL
// DashScope can fetch. Private COS objects are presigned; already-public URLs
// pass through. base64/local paths are rejected — the doc requires a public URL.
func resolveDashScopePublicVideoURL(ctx context.Context, rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if strings.HasPrefix(rawURL, "data:") {
		return "", apperror.New(apperror.CodeInvalidInput, "视频编辑的待编辑视频必须是可公开访问的 URL，不支持 base64/本地文件")
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return "", apperror.New(apperror.CodeInvalidInput, "视频编辑的待编辑视频必须是公网可访问的 URL")
	}
	// PresignGet returns "" for non-COS / already-public URLs (caller fetches
	// directly) and a signed URL for our private COS objects. A presign error is
	// non-fatal — fall back to the raw URL (mirrors the proxy-media handler).
	if signed, err := assetstore.PresignGet(ctx, rawURL, videoEditPresignTTL); err == nil && signed != "" {
		return signed, nil
	}
	return rawURL, nil
}

func dashScopeReferenceImageMediaType(req GenerateRequest) string {
	model := strings.ToLower(strings.TrimSpace(req.Model))
	switch {
	case strings.HasPrefix(model, "happyhorse-") && strings.HasSuffix(model, "-r2v"):
		return "reference_image"
	case strings.HasPrefix(model, "happyhorse-") && strings.HasSuffix(model, "-i2v"):
		return "first_frame"
	case strings.HasPrefix(model, "happyhorse-") && strings.HasSuffix(model, "-video-edit"):
		return "reference_image"
	}

	switch strings.ToLower(strings.TrimSpace(req.ReferenceMode)) {
	case "image_reference", "video_edit":
		// video_edit tags its images as reference_image (the source video is a
		// separate type:"video" element added by buildDashScopeVideoMedia).
		return "reference_image"
	case "first_frame", "start_frame":
		return "first_frame"
	default:
		return "first_frame"
	}
}

// pollVideoDashScopeTask polls a DashScope-style async task until
// output.task_status=="SUCCEEDED" or "FAILED". The status vocabulary is
// PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN.
func (s *Service) pollVideoDashScopeTask(ctx context.Context, baseURL, queryPath, apiKey, taskID string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	pollURL := baseURL + strings.ReplaceAll(queryPath, "{taskId}", taskID)

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}

	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
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

		var taskResp map[string]interface{}
		if json.Unmarshal(body, &taskResp) != nil {
			continue
		}

		var status string
		var output map[string]interface{}
		if o, ok := taskResp["output"].(map[string]interface{}); ok {
			output = o
			status = strings.ToUpper(fmt.Sprintf("%v", o["task_status"]))
		}

		switch status {
		case "FAILED":
			msg := ""
			if output != nil {
				if m, ok := output["message"].(string); ok {
					msg = m
				}
				if c, ok := output["code"].(string); ok && c != "" {
					msg = c + ": " + msg
				}
			}
			if msg == "" {
				msg = string(body[:min(len(body), 500)])
			}
			return nil, apperror.New(apperror.CodeInternal, "Video generation failed: "+msg)
		case "SUCCEEDED":
			if output != nil {
				if u, ok := output["video_url"].(string); ok && u != "" {
					return &GenerateResult{Type: "url", Content: u}, nil
				}
			}
			if u := findStringField(taskResp, "video_url", 5); u != "" {
				return &GenerateResult{Type: "url", Content: u}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task succeeded but no video_url found. Raw: %s", string(body[:min(len(body), 800)])))
		case "CANCELED", "UNKNOWN":
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task %s: status=%s", taskID, status))
		}
		// PENDING / RUNNING / other — keep polling.
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// pollVideoTask polls the provider's task endpoint until completed or failed.
// ── Manju 中转站 chat/completions 视频 ────────────────────────────────────────
// manjuapi.com 的视频生成不是 sora-style POST /videos，而是 POST /chat/completions
// 提交、响应带任务对象(id/poll_url)、GET /v1/videos/{id} 轮询。三个模型家族的
// 请求字段形态各不相同(接口文档 ssnsuyettr.apifox.cn)：
//   sora2:               messages[] 装提示词 + sora2_duration/sora2_ratio + input_reference
//   Veo 3.1 Fast 1080p:  根级 prompt + duration/aspect_ratio + input_reference
//   grok-imagine-video:  根级 prompt + duration/aspect_ratio/resolution + image_url

// isManjuChatVideoModel matches the relay's EXACT model names. Deliberately
// narrow so the standard /videos families (sora-2 / sora-v3-*) keep routing to
// the generic sora-style path: "sora2" has no hyphen, the relay's Veo name
// contains spaces, and grok-imagine-video is the relay's own slug.
func isManjuChatVideoModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "sora2" {
		return true
	}
	if strings.HasPrefix(m, "veo ") { // "veo 3.1 fast 1080p" — 带空格是中转站命名
		return true
	}
	return strings.HasPrefix(m, "grok-imagine")
}

func (s *Service) generateVideoChatCompletions(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	model := strings.ToLower(strings.TrimSpace(req.Model))
	ratio := strings.TrimSpace(req.AspectRatio)
	if ratio == "" {
		ratio = strings.TrimSpace(req.Size)
	}
	if ratio == "" || !strings.Contains(ratio, ":") {
		ratio = "16:9"
	}
	duration := req.Duration
	if duration <= 0 {
		duration = 8
	}

	// 参考图(图生视频)：中转站要求公网 http(s) URL(生成资产本就转存在 COS
	// 公共桶，前端传的是原图公网 URL)。只取第一张 —— 三个模型都是单参考。
	referenceURL := ""
	for i, raw := range req.ReferenceImages {
		ref := strings.TrimSpace(raw)
		if ref == "" {
			continue
		}
		if !strings.HasPrefix(ref, "http://") && !strings.HasPrefix(ref, "https://") {
			return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("ManjuAPI video reference #%d must be a public http(s) URL", i+1))
		}
		referenceURL = ref
		break
	}

	body := map[string]interface{}{
		"model":  req.Model,
		"stream": false,
	}
	switch {
	case model == "sora2":
		body["messages"] = []map[string]interface{}{{"role": "user", "content": req.Prompt}}
		body["sora2_duration"] = strconv.Itoa(duration)
		body["sora2_ratio"] = ratio
		if referenceURL != "" {
			body["input_reference"] = referenceURL
		}
	case strings.HasPrefix(model, "grok-imagine"):
		// grok 只接受 6/10/15 秒与 720p；时长取最接近的合法值。
		grokDur := 6
		for _, d := range []int{6, 10, 15} {
			if abs(duration-d) < abs(duration-grokDur) {
				grokDur = d
			}
		}
		if ratio != "16:9" && ratio != "9:16" {
			ratio = "16:9"
		}
		body["prompt"] = req.Prompt
		body["duration"] = strconv.Itoa(grokDur)
		body["aspect_ratio"] = ratio
		body["resolution"] = "720p"
		if referenceURL != "" {
			body["image_url"] = referenceURL
		}
	default: // Veo 3.1 家族
		body["prompt"] = req.Prompt
		body["duration"] = strconv.Itoa(duration)
		body["aspect_ratio"] = ratio
		if referenceURL != "" {
			body["input_reference"] = referenceURL
		}
	}

	bodyJSON, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, "/chat/completions"), bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := newProviderHTTPClient(60 * time.Second)
	resp, err := doProviderSubmitWithRetry(ctx, client, httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, readProviderError(resp)
	}
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read provider response", readErr)
	}

	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unrecognized submit response: %s", string(respBody[:min(len(respBody), 500)])))
	}
	// 同步兜底：万一网关直接返回了成片 URL。
	if url := findStringField(submitResp, "video_url", 5); url != "" && strings.HasPrefix(url, "http") {
		return &GenerateResult{Type: "url", Content: url}, nil
	}
	// 任务对象：taskID 在 task_id 或 id("sora2-xxx"/"grok-xxx");poll_url 可选。
	taskID := ""
	if id, ok := submitResp["task_id"].(string); ok && strings.TrimSpace(id) != "" {
		taskID = strings.TrimSpace(id)
	} else if id, ok := submitResp["id"].(string); ok && strings.TrimSpace(id) != "" {
		taskID = strings.TrimSpace(id)
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video submit returned no task id. Raw: %s", string(respBody[:min(len(respBody), 500)])))
	}
	queryPath := resolveVideoQueryPath(pc)
	if pollURL, ok := submitResp["poll_url"].(string); ok && strings.TrimSpace(pollURL) != "" {
		// poll_url 是绝对地址；pollVideoTask 的 resolveProviderURL 会原样保留。
		return s.pollVideoTask(ctx, baseURL, apiKey, strings.TrimSpace(pollURL), taskID)
	}
	return s.pollVideoTask(ctx, baseURL, apiKey, queryPath, taskID)
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func (s *Service) pollVideoTask(ctx context.Context, baseURL, apiKey, queryPath, taskID string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	if strings.TrimSpace(queryPath) == "" {
		queryPath = "/videos/{taskId}"
	}
	pollURL := resolveProviderURL(baseURL, strings.ReplaceAll(queryPath, "{taskId}", taskID))

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}

	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
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

		var taskResp map[string]interface{}
		if json.Unmarshal(body, &taskResp) != nil {
			continue
		}

		status := strings.ToLower(fmt.Sprintf("%v", taskResp["status"]))

		// 各网关的失败/完成词汇不一(sora-style: failed/completed;Manju 中转站:
		// error/succeeded 等)——统一按词表归类。
		if status == "failed" || status == "error" || status == "failure" || status == "cancelled" || status == "canceled" {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation failed. Raw: %s", string(body[:min(len(body), 500)])))
		}

		if status == "completed" || status == "succeeded" || status == "success" {
			// video_url at top level
			if videoURL, ok := taskResp["video_url"].(string); ok && videoURL != "" {
				return &GenerateResult{Type: "url", Content: videoURL}, nil
			}
			// Search recursively
			url := findStringField(taskResp, "video_url", 5)
			if url != "" {
				return &GenerateResult{Type: "url", Content: url}, nil
			}
			url = findStringField(taskResp, "url", 5)
			if url != "" && strings.HasPrefix(url, "http") {
				return &GenerateResult{Type: "url", Content: url}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video completed but no URL found. Raw: %s", string(body[:min(len(body), 800)])))
		}

		// Still processing — continue polling.
	}

	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// generateVideoApimart implements apimart.ai's video contract (docs.apimart.ai),
// mirroring generateImageApimart: POST /videos/generations with
//
//	{model, prompt, duration, aspect_ratio, resolution:"720p"|"1080p"|"4k",
//	 image_urls:[url|dataURI, …]}   // 首帧/参考图与文生视频同一端点
//
// → {code, data:[{status:"submitted", task_id}]} → GET /tasks/{task_id}
// until data.status=completed, video at data.result.videos[0].url.
func (s *Service) generateVideoApimart(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)

	aspectRatio := req.AspectRatio
	if aspectRatio == "" {
		aspectRatio = req.Size
	}

	body := map[string]interface{}{
		"model":  req.Model,
		"prompt": req.Prompt,
	}
	if v := strings.TrimSpace(aspectRatio); v != "" {
		body["aspect_ratio"] = v // 比例("16:9"/"9:16")；空则网关默认
	}
	if v := strings.TrimSpace(req.Resolution); v != "" {
		body["resolution"] = v // apimart 视频档位：720p/1080p/4k
	}
	if req.Duration > 0 {
		body["duration"] = req.Duration
	}

	// 首帧/参考图：apimart 网关侧下载，必须公网 http(s) URL 或 base64 data URI；
	// 本地路径转成 data URI 再传(与 generateImageApimart 的参考图约束一致)。
	if len(req.ReferenceImages) > 0 {
		urls := make([]string, 0, len(req.ReferenceImages))
		for _, raw := range req.ReferenceImages {
			ref := strings.TrimSpace(raw)
			if ref == "" {
				continue
			}
			if !strings.HasPrefix(ref, "http://") && !strings.HasPrefix(ref, "https://") && !strings.HasPrefix(ref, "data:") {
				du, err := localPathToDataURL(ref)
				if err != nil {
					return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image: %v", err), err)
				}
				ref = du
			}
			urls = append(urls, ref)
		}
		if len(urls) > 16 {
			urls = urls[:16]
		}
		if len(urls) > 0 {
			body["image_urls"] = urls
		}
	}

	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, "/videos/generations"), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := safehttp.Client(30 * time.Second) // SSRF guard: poll/result urls come from relay responses
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	// 同步兜底：万一网关直接返回成片(未见于文档，但通吃)。
	if url := extractApimartVideoURL(respBody); url != "" {
		return &GenerateResult{Type: "url", Content: url}, nil
	}
	taskID := extractImageTaskID(respBody) // {code, data:[{task_id}]} 通用任务 id 提取
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("apimart video submit returned no task id. Raw: %s", string(respBody[:min(len(respBody), 500)])))
	}
	return s.pollApimartVideoTask(ctx, baseURL, apiKey, taskID)
}

// pollApimartVideoTask polls GET /tasks/{id} until the video URL appears.
// Mirrors pollImageTask's robustness: completion is signalled by the presence
// of a video URL (gateways disagree on the exact status word), and failure is
// read from status at the top level OR nested under data (apimart uses
// data.status). The "timed out after polling" sentinel is required — the tasks
// worker matches it (isGenerationTimeout) to mark media timeouts SkipRetry and
// avoid re-charging a still-running task.
func (s *Service) pollApimartVideoTask(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second) // SSRF guard: result urls come from relay responses
	pollURL := resolveProviderURL(baseURL, "/tasks/"+taskID)

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
			continue
		}
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)

		resp, err := client.Do(httpReq)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastBody = body

		if url := extractApimartVideoURL(body); url != "" {
			return &GenerateResult{Type: "url", Content: url}, nil
		}
		if apimartTaskFailed(body) {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation failed. Raw: %s", string(body[:min(len(body), 500)])))
		}
	}

	if len(lastBody) > 0 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation timed out after polling. Last response: %s", string(lastBody[:min(len(lastBody), 800)])))
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// extractApimartVideoURL pulls the final video URL out of an apimart task
// response. apimart nests it at data.result.videos[].url (url may be a string
// or a [string]); we target that exact path first, then fall back to a generic
// video_url search so sibling relays with flatter shapes still work. Returns ""
// while the task is still running (submit response has data as an array, no
// result yet — so no false positive).
func extractApimartVideoURL(body []byte) string {
	var generic map[string]interface{}
	if json.Unmarshal(body, &generic) != nil {
		return ""
	}
	if url := apimartVideoURLFromResult(generic); url != "" {
		return url
	}
	if url := findStringField(generic, "video_url", 6); url != "" && (strings.HasPrefix(url, "http") || strings.HasPrefix(url, "data:")) {
		return url
	}
	return ""
}

// apimartVideoURLFromResult navigates the exact data.result.videos[].url path
// (data may be absent), avoiding a blind "url" search that could grab a
// thumbnail/cover URL.
func apimartVideoURLFromResult(generic map[string]interface{}) string {
	scope := generic
	if data, ok := generic["data"].(map[string]interface{}); ok {
		scope = data
	}
	result, ok := scope["result"].(map[string]interface{})
	if !ok {
		return ""
	}
	vids, ok := result["videos"].([]interface{})
	if !ok {
		return ""
	}
	for _, v := range vids {
		vm, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		switch u := vm["url"].(type) {
		case string:
			if strings.HasPrefix(u, "http") {
				return u
			}
		case []interface{}:
			for _, item := range u {
				if s, ok := item.(string); ok && strings.HasPrefix(s, "http") {
					return s
				}
			}
		}
	}
	return ""
}

// apimartTaskFailed reports an explicit failure status at the top level or
// nested under data (apimart puts it at data.status).
func apimartTaskFailed(body []byte) bool {
	var generic map[string]interface{}
	if json.Unmarshal(body, &generic) != nil {
		return false
	}
	isFail := func(v interface{}) bool {
		s, _ := v.(string)
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "failed", "error", "failure", "cancelled", "canceled":
			return true
		}
		return false
	}
	if isFail(generic["status"]) {
		return true
	}
	if data, ok := generic["data"].(map[string]interface{}); ok {
		if isFail(data["status"]) {
			return true
		}
	}
	return false
}
