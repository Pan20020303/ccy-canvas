package application

import (
	"bytes"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	if ResolveProfile(pc).ID == "dashscope" {
		return s.generateVideoDashScope(ctx, pc, baseURL, apiKey, req)
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

	client := &http.Client{Timeout: 30 * time.Second}
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
	// image count. Only the first/last-frame mode tags images with frame
	// roles; multi-image / all-in-one / motion modes leave them untagged so
	// Ark treats them as consistency references.
	//   start_end       → img[0]=first_frame, img[1]=last_frame (if present)
	//   start_frame     → img[0]=first_frame (legacy single-frame alias)
	//   (other / empty) → no roles
	useFrameRoles := req.ReferenceMode == "start_end" || req.ReferenceMode == "start_frame"
	for i, raw := range req.ReferenceImages {
		du, err := localPathToDataURL(raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
		}
		item := map[string]interface{}{
			"type":      "image_url",
			"image_url": map[string]interface{}{"url": du},
		}
		if useFrameRoles {
			if i == 0 {
				item["role"] = "first_frame"
			} else if i == 1 {
				item["role"] = "last_frame"
			}
		}
		content = append(content, item)
	}

	// Motion-mimic / video-edit reference videos ride in the same content
	// array as video_url items so Ark can condition on them.
	for _, rawVid := range collectArkReferenceVideos(req) {
		du, err := localPathToDataURL(rawVid)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference video: %v", err), err)
		}
		content = append(content, map[string]interface{}{
			"type":      "video_url",
			"video_url": map[string]interface{}{"url": du},
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

	client := &http.Client{Timeout: 30 * time.Second}
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
	client := &http.Client{Timeout: 30 * time.Second}
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

	input := map[string]interface{}{}
	if strings.TrimSpace(req.Prompt) != "" {
		input["prompt"] = req.Prompt
	}
	if len(req.ReferenceImages) > 0 {
		media, err := buildDashScopeVideoMedia(req)
		if err != nil {
			return nil, err
		}
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

	client := &http.Client{Timeout: 30 * time.Second}
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

func buildDashScopeVideoParameters(req GenerateRequest) map[string]interface{} {
	parameters := map[string]interface{}{
		"watermark": false,
	}
	if req.Resolution != "" {
		parameters["resolution"] = req.Resolution
	}
	if req.Duration > 0 {
		parameters["duration"] = req.Duration
	}
	if req.AspectRatio != "" && req.AspectRatio != "auto" {
		parameters["aspect_ratio"] = req.AspectRatio
	}
	return parameters
}

func buildDashScopeVideoMedia(req GenerateRequest) ([]map[string]interface{}, error) {
	mediaType := dashScopeReferenceImageMediaType(req)
	media := make([]map[string]interface{}, 0, len(req.ReferenceImages))
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
	case "image_reference":
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
	client := &http.Client{Timeout: 30 * time.Second}
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
func (s *Service) pollVideoTask(ctx context.Context, baseURL, apiKey, queryPath, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}
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

		if status == "failed" {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation failed. Raw: %s", string(body[:min(len(body), 500)])))
		}

		if status == "completed" {
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
