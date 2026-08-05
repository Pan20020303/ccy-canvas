package application

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// mapAspectRatioToOpenAISize converts our internal aspect-ratio + resolution
// notation into a size string the OpenAI image edit endpoint accepts.
// Returns "" if the input doesn't look like an aspect ratio (the caller can
// then pass through whatever the relay supports).
func mapAspectRatioToOpenAIImageSize(size string) string {
	switch strings.ToLower(strings.TrimSpace(size)) {
	case "", "auto":
		return "auto"
	case "1:1":
		return "1024x1024"
	case "16:9", "4:3", "3:2", "5:4", "21:9", "2:1":
		return "1536x1024"
	case "9:16", "3:4", "2:3", "4:5", "1:2", "9:21":
		return "1024x1536"
	}
	// Already pixel-sized (e.g. "1024x1024") or vendor-specific — pass through.
	if strings.Contains(size, "x") {
		return size
	}
	return ""
}

func normalizeOpenAIImageQuality(quality string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "high", "medium", "low":
		return strings.ToLower(strings.TrimSpace(quality))
	default:
		return "auto"
	}
}

func parseImageDataEntries(respBody []byte) (*GenerateResult, bool, error) {
	var result struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil || len(result.Data) == 0 {
		return nil, false, nil
	}
	if result.Data[0].URL != "" {
		return &GenerateResult{Type: "url", Content: result.Data[0].URL}, true, nil
	}
	if result.Data[0].B64JSON != "" {
		return &GenerateResult{Type: "url", Content: "data:image/png;base64," + result.Data[0].B64JSON}, true, nil
	}
	return nil, true, apperror.New(apperror.CodeInternal, "Provider returned an image entry with neither url nor b64_json")
}

// parseImageGenerationResponse extracts a usable URL or b64_json from an
// OpenAI-style image response. Shared by text-only and edit code paths.
func parseImageGenerationResponse(respBody []byte) (*GenerateResult, error) {
	if taskID := extractImageTaskID(respBody); taskID != "" {
		return nil, apperror.New(apperror.CodeInternal, "Async task path not supported in edit mode yet; got task_id="+taskID)
	}
	if result, ok, err := parseImageDataEntries(respBody); ok {
		return result, err
	}
	return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unexpected provider response: %s", string(respBody[:min(len(respBody), 400)])))
}

var markdownImageURLPattern = regexp.MustCompile(`!\[[^\]]*\]\((https?://[^)\s]+)\)`)
var plainImageURLPattern = regexp.MustCompile(`https?://[^\s)]+`)

func parseChatImageGenerationResponse(respBody []byte) (*GenerateResult, error) {
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &result); err == nil && len(result.Choices) > 0 {
		content := strings.TrimSpace(result.Choices[0].Message.Content)
		if content != "" {
			if match := markdownImageURLPattern.FindStringSubmatch(content); len(match) == 2 {
				return &GenerateResult{Type: "url", Content: match[1]}, nil
			}
			if match := plainImageURLPattern.FindString(content); match != "" {
				return &GenerateResult{Type: "url", Content: strings.TrimRight(match, ".,;")}, nil
			}
		}
	}
	if result, ok, err := parseImageDataEntries(respBody); ok {
		return result, err
	}
	return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unexpected provider response: %s", string(respBody[:min(len(respBody), 400)])))
}

func extractImageTaskID(respBody []byte) string {
	var taskCheck map[string]interface{}
	if err := json.Unmarshal(respBody, &taskCheck); err != nil {
		return ""
	}
	if id, ok := taskCheck["task_id"].(string); ok && strings.TrimSpace(id) != "" {
		return strings.TrimSpace(id)
	}
	// Manju/NewAPI chat-image async stub: when 图生图 (POST /chat/completions)
	// is still processing, the gateway returns a chat.completion with empty
	// content and the task id embedded in the top-level `id`, e.g.
	// "chatcmpl-gemini-img-XXXX". The task-query endpoint
	// (GET /v1/tasks/{task_id}) expects the bare id, so strip the chatcmpl-
	// prefix. Gated on an "-img-" segment so a normal text chat.completion
	// id ("chatcmpl-abc123") is never mistaken for an image task.
	if id, ok := taskCheck["id"].(string); ok {
		id = strings.TrimSpace(id)
		bare := strings.TrimPrefix(id, "chatcmpl-")
		if strings.Contains(bare, "-img-") || strings.HasPrefix(bare, "img-") {
			return bare
		}
	}
	// apimart.ai buries the id one level down: {code, data:[{task_id:"task_…"}]}.
	// Recursive fallback only runs when the top-level fields miss, so the
	// Manju/NewAPI fast paths above keep their exact semantics.
	if id := findStringField(taskCheck, "task_id", 3); strings.TrimSpace(id) != "" {
		return strings.TrimSpace(id)
	}
	return ""
}

func extractImageTaskPollURL(respBody []byte) string {
	var taskCheck map[string]interface{}
	if err := json.Unmarshal(respBody, &taskCheck); err != nil {
		return ""
	}
	if pollURL, ok := taskCheck["poll_url"].(string); ok && strings.TrimSpace(pollURL) != "" {
		return strings.TrimSpace(pollURL)
	}
	return ""
}

// pollImageTask polls an async image generation task until it completes or times out.
func (s *Service) pollImageTask(ctx context.Context, baseURL, apiKey, queryPath, taskID, pollURL string) (*GenerateResult, error) {
	client := safehttp.Client(30 * time.Second) // SSRF guard: poll_url comes from relay responses

	// Try multiple URL patterns used by various providers.
	// apimart.ai uses GET /v1/tasks/{task_id}
	pollURLs := make([]string, 0, 4)
	if strings.TrimSpace(pollURL) != "" {
		pollURLs = append(pollURLs, resolveProviderURL(baseURL, strings.TrimSpace(pollURL)))
	}
	if strings.TrimSpace(queryPath) != "" {
		pollURLs = append(pollURLs, resolveProviderURL(baseURL, strings.ReplaceAll(queryPath, "{taskId}", taskID)))
	}
	// Fallback patterns when the response didn't carry a usable poll_url.
	// Manju/NewAPI serves task status at {host}/api/tasks/{id} (note: /api,
	// not the /v1 generation prefix), so derive the host root too.
	hostRoot := baseURL
	if i := strings.Index(hostRoot, "/v1"); i > 0 {
		hostRoot = hostRoot[:i]
	}
	pollURLs = append(pollURLs,
		strings.TrimRight(hostRoot, "/")+"/api/tasks/"+taskID,
		baseURL+"/tasks/"+taskID,
		baseURL+"/images/generations/"+taskID,
		baseURL+"/async/tasks/"+taskID,
	)

	// Wait before first poll per upstream docs, then poll at a fixed interval.
	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(imageTaskPollInitialDelay):
	}

	for i := 0; i < imageTaskPollMaxAttempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(imageTaskPollInterval):
			}
		}

		var lastBody []byte
		for _, pollURL := range pollURLs {
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

			if resp.StatusCode == 404 || resp.StatusCode == 405 {
				continue // try next URL pattern
			}

			// A task is terminal only when the relay says it has completed and a
			// final media field is present. Poll/detail/input URLs may exist while
			// the task is still queued; treating any recursive `url` as the image
			// used to publish a false success several minutes too early.
			var generic map[string]interface{}
			if json.Unmarshal(body, &generic) == nil {
				state, status := classifyImagePollState(generic)
				if state == imagePollFailed {
					return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
				}
				if result := extractFinalImageResult(generic, state); result != nil {
					return result, nil
				}
				if state == imagePollSucceeded {
					log.Printf("[modelcatalog] image task %s reported terminal status %q without a final media URL; continuing to poll", taskID, status)
				}
			}

			break // got a valid response from this URL pattern, wait and retry
		}

		// On last attempt, return the raw response for debugging. The message
		// MUST contain "timed out after polling": the tasks worker matches that
		// sentinel (isGenerationTimeout) to mark media timeouts SkipRetry —
		// otherwise Asynq classifies this as transient and RESUBMITS the paid
		// generation while the upstream task is still running (duplicate
		// gateway tasks + double charge; the exact bug seen on Manju 图生图).
		if i == imageTaskPollMaxAttempts-1 && len(lastBody) > 0 {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Image generation timed out after polling. Last response: %s", string(lastBody[:min(len(lastBody), 800)])))
		}
	}

	return nil, apperror.New(apperror.CodeInternal, "Image generation timed out after polling")
}

type imagePollState int

const (
	imagePollUnknown imagePollState = iota
	imagePollActive
	imagePollSucceeded
	imagePollFailed
)

// classifyImagePollState reads status only from task-response wrappers. It
// deliberately does not recurse through arbitrary input/request metadata,
// where an unrelated status could override the actual task state.
func classifyImagePollState(payload map[string]interface{}) (imagePollState, string) {
	var visit func(interface{}, int) (imagePollState, string)
	visit = func(value interface{}, depth int) (imagePollState, string) {
		if depth <= 0 {
			return imagePollUnknown, ""
		}
		switch current := value.(type) {
		case map[string]interface{}:
			for _, key := range []string{"status", "state", "task_status"} {
				if raw, ok := current[key].(string); ok {
					status := strings.ToLower(strings.TrimSpace(raw))
					switch status {
					case "failed", "failure", "error", "errored", "cancelled", "canceled", "expired", "timeout", "timed_out", "失败", "已失败", "已取消", "超时":
						return imagePollFailed, raw
					case "completed", "complete", "success", "succeeded", "finished", "done", "已完成", "成功", "完成":
						return imagePollSucceeded, raw
					case "submitted", "created", "queued", "pending", "processing", "running", "in_progress", "in-progress", "generating", "starting", "进行中", "处理中", "排队中", "生成中", "等待中":
						return imagePollActive, raw
					}
				}
			}
			for _, key := range []string{"data", "task", "result", "output"} {
				if child, ok := current[key]; ok {
					if state, status := visit(child, depth-1); state != imagePollUnknown {
						return state, status
					}
				}
			}
		case []interface{}:
			for _, child := range current {
				if state, status := visit(child, depth-1); state != imagePollUnknown {
					return state, status
				}
			}
		}
		return imagePollUnknown, ""
	}
	return visit(payload, 5)
}

// tryExtractImageFromPollResponse attempts to find an image URL in various response shapes.
func (s *Service) tryExtractImageFromPollResponse(body []byte) *GenerateResult {
	var generic map[string]interface{}
	if json.Unmarshal(body, &generic) != nil {
		return nil
	}
	state, _ := classifyImagePollState(generic)
	return extractFinalImageResult(generic, state)
}

func extractFinalImageResult(payload map[string]interface{}, state imagePollState) *GenerateResult {
	// An explicit non-terminal/failed status always wins over URLs carried in
	// request echoes, progress metadata or task-detail links.
	if state == imagePollActive || state == imagePollFailed {
		return nil
	}
	if finalURL := findFinalImageURL(payload, false, 6); finalURL != "" {
		return &GenerateResult{Type: "url", Content: finalURL}
	}
	return nil
}

// findFinalImageURL traverses only known response/output containers. Generic
// `url` and `content` fields are accepted only after entering one of those
// containers, so input.url, poll_url and detail_url can never become output.
func findFinalImageURL(value interface{}, allowGenericOutput bool, depth int) string {
	if depth <= 0 {
		return ""
	}
	switch current := value.(type) {
	case map[string]interface{}:
		for _, key := range []string{"result_url", "final_url", "download_url", "image_url"} {
			if candidate := firstStringValue(current[key]); isRenderableImageValue(candidate) {
				return candidate
			}
		}
		if allowGenericOutput {
			if candidate := firstStringValue(current["url"]); isRenderableImageValue(candidate) {
				return candidate
			}
			if b64 := firstStringValue(current["b64_json"]); strings.TrimSpace(b64) != "" {
				return "data:image/png;base64," + strings.TrimSpace(b64)
			}
			if content := firstStringValue(current["content"]); content != "" {
				if match := markdownImageURLPattern.FindStringSubmatch(content); len(match) == 2 {
					return match[1]
				}
				if match := plainImageURLPattern.FindString(content); match != "" {
					return strings.TrimRight(match, ".,;")
				}
			}
		}
		for _, key := range []string{"data", "result", "output", "outputs", "images", "artifacts", "choices", "message"} {
			if child, ok := current[key]; ok {
				if found := findFinalImageURL(child, true, depth-1); found != "" {
					return found
				}
			}
		}
	case []interface{}:
		for _, child := range current {
			if found := findFinalImageURL(child, allowGenericOutput, depth-1); found != "" {
				return found
			}
		}
	}
	return ""
}

func firstStringValue(value interface{}) string {
	switch current := value.(type) {
	case string:
		return strings.TrimSpace(current)
	case []interface{}:
		for _, item := range current {
			if candidate, ok := item.(string); ok && strings.TrimSpace(candidate) != "" {
				return strings.TrimSpace(candidate)
			}
		}
	}
	return ""
}

func isRenderableImageValue(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "data:image/")
}

// findStringField recursively searches a map for a non-empty string field by key name, up to maxDepth.
// Handles cases where the value is a string OR a []string (takes first element).
func findStringField(obj interface{}, key string, maxDepth int) string {
	if maxDepth <= 0 {
		return ""
	}
	switch v := obj.(type) {
	case map[string]interface{}:
		if val, ok := v[key]; ok {
			switch tv := val.(type) {
			case string:
				if tv != "" {
					return tv
				}
			case []interface{}:
				// url might be ["https://..."] — take first string element.
				for _, item := range tv {
					if s, ok := item.(string); ok && s != "" {
						return s
					}
				}
			}
		}
		for _, val := range v {
			if found := findStringField(val, key, maxDepth-1); found != "" {
				return found
			}
		}
	case []interface{}:
		for _, item := range v {
			if found := findStringField(item, key, maxDepth-1); found != "" {
				return found
			}
		}
	}
	return ""
}
