package application

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"bytes"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

// wan2.7 (万相2.7) SYNCHRONOUS multimodal image endpoint. One request returns
// the image(s) directly under output.choices[].message.content[]. We use the
// sync endpoint (not the async /services/aigc/image-generation/generation)
// because the async variant is only routed on the workspace maas domain
// (`{WorkspaceId}.<region>.maas.aliyuncs.com`), whereas sync works on the shared
// `dashscope.aliyuncs.com` domain too — hitting the async path on the shared
// domain returns "InvalidParameter: url error, please check url!".
const dashScopeImageSyncPath = "/services/aigc/multimodal-generation/generation"

// isWan27Image reports whether req targets a wan2.7 image model (the only image
// model routed through the DashScope multimodal builder). Other DashScope image
// rows (legacy text2image) are left on their existing path.
func isWan27Image(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "wan2.7-image")
}

// generateImageDashScope talks to Alibaba DashScope's async wan2.7 image API
// (POST /services/aigc/image-generation/generation → poll /tasks/{id}). The
// request uses the multimodal {model, input:{messages:[{role,content:[{text}|{image}]}]}, parameters}
// shape with the X-DashScope-Async header, and the response nests generated
// images under output.choices[0].message.content[] as multiple {image,type}
// entries (组图 returns up to 12). Mirrors generateVideoDashScope.
func (s *Service) generateImageDashScope(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)

	// Defense-in-depth: reject documented-constraint violations locally.
	if err := validateDashScopeImageRequest(req); err != nil {
		return nil, err
	}

	content, err := buildDashScopeImageContent(req)
	if err != nil {
		return nil, err
	}
	input := map[string]interface{}{
		"messages": []map[string]interface{}{
			{"role": "user", "content": content},
		},
	}

	body := map[string]interface{}{
		"model":      req.Model,
		"input":      input,
		"parameters": buildDashScopeImageParameters(req),
	}
	bodyJSON, _ := json.Marshal(body)

	submitURL := baseURL + dashScopeImageSyncPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	// The generation runs INSIDE this request (synchronous endpoint), so allow
	// generous time — 组图 can produce up to 12 images.
	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusNotFound && len(bytes.TrimSpace(respBody)) == 0 {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf(
				"Provider HTTP 404 (empty body) at %s — model %q not found. Check (1) API key region matches the model, (2) wan2.7-image subscription is enabled in DashScope console, (3) baseURL ends with /api/v1.",
				submitURL, req.Model,
			))
		}
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}

	var syncResp map[string]interface{}
	if err := json.Unmarshal(respBody, &syncResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse response: %s", string(respBody[:min(len(respBody), 300)])))
	}
	// A 200 can still carry a top-level error code on some paths.
	if code, _ := syncResp["code"].(string); code != "" {
		msg, _ := syncResp["message"].(string)
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Image generation failed: %s: %s", code, msg))
	}
	output, _ := syncResp["output"].(map[string]interface{})
	urls := parseDashScopeImageContent(output)
	if len(urls) > 0 {
		return &GenerateResult{Type: "url", Content: urls[0], ContentList: urls}, nil
	}
	return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task returned no image. Raw: %s", string(respBody[:min(len(respBody), 800)])))
}

// buildDashScopeImageContent assembles the input.messages[0].content array:
// the prompt as a {text} element followed by each reference image as an {image}
// element (URL or base64 data URI). 文生图 yields just the text element.
func buildDashScopeImageContent(req GenerateRequest) ([]map[string]interface{}, error) {
	content := make([]map[string]interface{}, 0, 1+len(req.ReferenceImages))
	if strings.TrimSpace(req.Prompt) != "" {
		content = append(content, map[string]interface{}{"text": req.Prompt})
	}
	for i, raw := range req.ReferenceImages {
		du, err := localPathToDataURL(raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
		}
		content = append(content, map[string]interface{}{"image": du})
	}
	if len(content) == 0 {
		return nil, apperror.New(apperror.CodeInvalidInput, "Prompt or a reference image is required")
	}
	return content, nil
}

// buildDashScopeImageParameters builds the wan2.7 parameters object with
// per-mode gating (see the mode contract matrix): size (4K only for 文生图),
// n (1-4 non-group / 1-12 组图), enable_sequential (组图 only), thinking_mode
// (文生图 only), seed (all). Watermark ships off, matching the video vendor's
// deliberate product choice.
func buildDashScopeImageParameters(req GenerateRequest) map[string]interface{} {
	parameters := map[string]interface{}{
		"watermark": false,
	}
	hasImages := len(req.ReferenceImages) > 0
	isGroup := req.EnableSequential != nil && *req.EnableSequential

	// wan2.7's size accepts "1K"/"2K"/"4K" or a "W*H" pixel string — NOT aspect
	// ratios like "16:9". The app may send an aspect ratio in Size and the image
	// resolution (1K/2K/4K) in Resolution, so pick the first valid wan size and
	// drop anything else (DashScope then defaults to 2K).
	if s := pickWanImageSize(req.Resolution, req.Size); s != "" {
		parameters["size"] = s
	}
	if req.OutputCount > 0 {
		parameters["n"] = req.OutputCount
	}
	if isGroup {
		parameters["enable_sequential"] = true
	}
	// thinking_mode only takes effect for 文生图 (no image + no group).
	if !hasImages && !isGroup && req.ThinkingMode != nil {
		parameters["thinking_mode"] = *req.ThinkingMode
	}
	if req.Seed != nil {
		parameters["seed"] = *req.Seed
	}
	return parameters
}

// pickWanImageSize returns the first candidate that is a valid wan2.7 size —
// a "<n>K" spec (1K/2K/4K) or a "W*H" pixel string — normalizing the K form to
// upper-case. Aspect ratios ("16:9") and "auto" are rejected (empty result).
func pickWanImageSize(candidates ...string) string {
	for _, raw := range candidates {
		v := strings.TrimSpace(raw)
		if v == "" || strings.EqualFold(v, "auto") {
			continue
		}
		if strings.Contains(v, "*") {
			return v // W*H pixel size
		}
		up := strings.ToUpper(v)
		if strings.HasSuffix(up, "K") {
			digits := strings.TrimSuffix(up, "K")
			if digits != "" && strings.IndexFunc(digits, func(r rune) bool { return r < '0' || r > '9' }) == -1 {
				return up
			}
		}
	}
	return ""
}

// validateDashScopeImageRequest is defense-in-depth for the documented wan2.7
// constraints. Only wan2.7 image models carry these; other models pass through.
func validateDashScopeImageRequest(req GenerateRequest) error {
	if !isWan27Image(req.Model) {
		return nil
	}
	hasImages := len(req.ReferenceImages) > 0
	isGroup := req.EnableSequential != nil && *req.EnableSequential

	if len(req.ReferenceImages) > 9 {
		return apperror.New(apperror.CodeInvalidInput, "参考图最多 9 张")
	}
	if n := req.OutputCount; n != 0 {
		if isGroup {
			if n < 1 || n > 12 {
				return apperror.New(apperror.CodeInvalidInput, "组图模式生成数量 n 需在 1-12 之间")
			}
		} else if n < 1 || n > 4 {
			return apperror.New(apperror.CodeInvalidInput, "生成数量 n 需在 1-4 之间")
		}
	}
	if strings.EqualFold(strings.TrimSpace(req.Size), "4K") && (hasImages || isGroup) {
		return apperror.New(apperror.CodeInvalidInput, "4K 分辨率仅文生图（无参考图、非组图）支持")
	}
	return nil
}

// parseDashScopeImageContent walks output.choices[].message.content[] collecting
// every {type:"image", image:URL} entry in order.
func parseDashScopeImageContent(output map[string]interface{}) []string {
	urls := []string{}
	if output == nil {
		return urls
	}
	choices, _ := output["choices"].([]interface{})
	for _, ch := range choices {
		chm, ok := ch.(map[string]interface{})
		if !ok {
			continue
		}
		msg, ok := chm["message"].(map[string]interface{})
		if !ok {
			continue
		}
		content, ok := msg["content"].([]interface{})
		if !ok {
			continue
		}
		for _, item := range content {
			im, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			if t, _ := im["type"].(string); t != "" && t != "image" {
				continue
			}
			if u, ok := im["image"].(string); ok && u != "" {
				urls = append(urls, u)
			}
		}
	}
	return urls
}
