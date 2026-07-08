package application

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	client := &http.Client{Timeout: 30 * time.Second}

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

			// Try to extract image from the response (flexible parsing).
			if result := s.tryExtractImageFromPollResponse(body); result != nil {
				return result, nil
			}

			// Check for explicit failure.
			var generic map[string]interface{}
			if json.Unmarshal(body, &generic) == nil {
				if status, _ := generic["status"].(string); status == "failed" || status == "error" {
					return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
				}
				if data, ok := generic["data"].(map[string]interface{}); ok {
					if status, _ := data["status"].(string); status == "failed" || status == "error" {
						return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
					}
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

// tryExtractImageFromPollResponse attempts to find an image URL in various response shapes.
func (s *Service) tryExtractImageFromPollResponse(body []byte) *GenerateResult {
	var generic map[string]interface{}
	if json.Unmarshal(body, &generic) != nil {
		return nil
	}

	// Completion is signalled by the presence of a final image URL — not by
	// a status string (gateways disagree on the exact value, and Manju may
	// even return Chinese statuses). If a usable URL is present the task is
	// done; if not, it's still in progress and the caller keeps polling.
	// Search recursively (depth 5) for nested shapes like result.images[0].url
	// and data[0].url.
	// Order matters: prefer the most specific final-image fields. Manju/NewAPI
	// completed tasks put the image in `result_url` or `final_url` (the latter
	// was previously missing). `detail_url` is a detail *page*, not an image,
	// so it's intentionally excluded.
	for _, key := range []string{"result_url", "final_url", "download_url", "image_url", "url"} {
		url := findStringField(generic, key, 5)
		if url != "" && (strings.HasPrefix(url, "http") || strings.HasPrefix(url, "data:")) {
			return &GenerateResult{Type: "url", Content: url}
		}
	}
	// Manju 图生图 poll response carries the image as markdown inside
	// choices[0].message.content: "![](https://manjuapi.com/generated/x.png)".
	if content := findStringField(generic, "content", 5); content != "" {
		if match := markdownImageURLPattern.FindStringSubmatch(content); len(match) == 2 {
			return &GenerateResult{Type: "url", Content: match[1]}
		}
		if match := plainImageURLPattern.FindString(content); match != "" {
			return &GenerateResult{Type: "url", Content: strings.TrimRight(match, ".,;")}
		}
	}
	b64 := findStringField(generic, "b64_json", 5)
	if b64 != "" {
		return &GenerateResult{Type: "url", Content: "data:image/png;base64," + b64}
	}
	return nil
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
