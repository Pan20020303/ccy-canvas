package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

// dmxQueryModel is DMXAPI's sentinel "model" value that turns a POST /responses
// into a task-status query instead of a new generation.
const dmxQueryModel = "seedance-2-0-get"

// generateVideoDMX talks to DMXAPI's OpenAI-"Responses"-style Seedance 2.0 relay
// (https://www.dmxapi.cn/v1/responses). It differs from Ark's native task API:
//   - submit and poll share ONE endpoint (POST {base}/responses);
//   - the content array key is "input" (not Ark's "content");
//   - polling re-POSTs {model:"seedance-2-0-get", input:"<task_id>"} — there is
//     no REST GET .../tasks/{id};
//   - the finished video_url is a JSON STRING buried at
//     output[0].content[0].text that must be re-parsed.
//
// The input items themselves mirror Ark (text / image_url+role / video_url+role),
// so reference resolution reuses arkReferenceImageURL (size-normalized signed
// URL) and arkReferenceMediaURL exactly as the Ark path does.
func (s *Service) generateVideoDMX(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	submitPath := resolveVideoSubmitPath(pc)
	if !strings.HasPrefix(submitPath, "/") {
		submitPath = "/" + submitPath
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

	input := make([]map[string]interface{}, 0, 1+len(req.ReferenceImages))
	if strings.TrimSpace(req.Prompt) != "" {
		input = append(input, map[string]interface{}{"type": "text", "text": req.Prompt})
	}

	// Same role assignment as Ark: start_end/start_frame drive first/last frame,
	// everything else is a subject-consistency reference_image.
	useFrameRoles := req.ReferenceMode == "start_end" || req.ReferenceMode == "start_frame"
	for i, raw := range req.ReferenceImages {
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
		input = append(input, map[string]interface{}{
			"type":      "image_url",
			"image_url": map[string]interface{}{"url": refURL},
			"role":      role,
		})
	}
	for _, rawVid := range collectArkReferenceVideos(req) {
		refURL, err := arkReferenceMediaURL(ctx, rawVid)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考视频处理失败", err)
		}
		input = append(input, map[string]interface{}{
			"type":      "video_url",
			"video_url": map[string]interface{}{"url": refURL},
			"role":      "reference_video",
		})
	}

	body := map[string]interface{}{
		"model":     req.Model,
		"input":     input,
		"ratio":     ratio,
		"duration":  duration,
		"watermark": false,
	}
	if req.Resolution != "" {
		body["resolution"] = req.Resolution
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
	// Task id is the top-level "id" (or "request_id" on some responses).
	taskID, _ := submitResp["id"].(string)
	if taskID == "" {
		if id, ok := submitResp["request_id"].(string); ok {
			taskID = id
		}
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoDMX(ctx, submitURL, apiKey, taskID)
}

// pollVideoDMX polls DMXAPI's single /responses endpoint with the sentinel model
// until the nested status is terminal. Poll budget/interval reuse the shared
// video poll knobs (see videoGenerationTimeout).
func (s *Service) pollVideoDMX(ctx context.Context, submitURL, apiKey, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	queryBody, _ := json.Marshal(map[string]interface{}{
		"model": dmxQueryModel,
		"input": taskID,
	})

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

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewReader(queryBody))
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		videoURL, status, perr := parseDMXPollResponse(body)
		if perr != nil {
			// Outer envelope not ready / transient — keep polling.
			continue
		}
		switch status {
		case "succeeded", "success", "completed":
			if videoURL != "" {
				return &GenerateResult{Type: "url", Content: videoURL}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task succeeded but no video_url. Raw: %s", string(body[:min(len(body), 800)])))
		case "failed", "error", "expired", "cancelled", "canceled":
			return nil, apperror.New(apperror.CodeInternal, "Video generation failed: "+status)
		}
		// queued / running / unknown — keep polling.
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// parseDMXPollResponse pulls (video_url, status) out of DMXAPI's nested Responses
// payload: output[0].content[0].text is itself a JSON string carrying
// {content:{video_url}, status}. Returns an error while the envelope isn't ready
// yet (so the caller keeps polling rather than failing).
func parseDMXPollResponse(body []byte) (videoURL, status string, err error) {
	var outer struct {
		Output []struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if uerr := json.Unmarshal(body, &outer); uerr != nil {
		return "", "", uerr
	}
	if len(outer.Output) == 0 || len(outer.Output[0].Content) == 0 {
		return "", "", fmt.Errorf("no output content yet")
	}
	text := strings.TrimSpace(outer.Output[0].Content[0].Text)
	if text == "" {
		return "", "", fmt.Errorf("empty output text")
	}
	var inner struct {
		Content struct {
			VideoURL string `json:"video_url"`
		} `json:"content"`
		Status string `json:"status"`
	}
	if uerr := json.Unmarshal([]byte(text), &inner); uerr != nil {
		return "", "", uerr
	}
	return inner.Content.VideoURL, strings.ToLower(strings.TrimSpace(inner.Status)), nil
}
