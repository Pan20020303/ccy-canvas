package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

const hopBaseWanSubmitPath = "/api/v1/services/aigc/video-generation/video-synthesis"

var hopBaseWanPollInterval = 15 * time.Second

type hopBaseWanMedia struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// Only documented fields are serialized. In particular, generic canvas size,
// quality, output_format and reference_mode must never leak to this strict API.
func buildHopBaseWan3Body(ctx context.Context, req GenerateRequest) (map[string]any, error) {
	invalid := func(message string) (map[string]any, error) {
		return nil, apperror.New(apperror.CodeInvalidInput, "万相 3.0："+message)
	}
	prompt := strings.TrimSpace(req.Prompt)
	if utf8.RuneCountInString(prompt) > 20000 {
		return invalid("提示词不能超过 20000 字符")
	}
	params := map[string]any{}
	for _, key := range []string{"resolution", "duration", "ratio", "audio", "prompt_extend", "watermark", "seed"} {
		if value, ok := req.Parameters[key]; ok {
			params[key] = value
		}
	}
	if req.Resolution != "" {
		params["resolution"] = req.Resolution
	}
	if req.Duration != 0 {
		params["duration"] = req.Duration
	}
	if req.AspectRatio != "" {
		params["ratio"] = req.AspectRatio
	}
	if req.Seed != nil {
		params["seed"] = *req.Seed
	}
	switch strings.ToLower(strings.TrimSpace(req.AudioSetting)) {
	case "on":
		params["audio"] = true
	case "off":
		params["audio"] = false
	case "", "auto": // Let the provider's default apply.
	default:
		return invalid("声音仅支持 on / off / auto")
	}
	if value, ok := params["resolution"]; ok {
		resolution, _ := value.(string)
		resolution = strings.ToUpper(strings.TrimSpace(resolution))
		if resolution != "480P" && resolution != "720P" && resolution != "1080P" {
			return invalid("分辨率仅支持 480P / 720P / 1080P")
		}
		params["resolution"] = resolution
	}
	if value, ok := params["ratio"]; ok {
		ratio, _ := value.(string)
		ratio = strings.ToLower(strings.TrimSpace(ratio))
		if ratio == "auto" {
			ratio = "adaptive"
		}
		switch ratio {
		case "adaptive", "16:9", "4:3", "1:1", "3:4", "9:16":
			params["ratio"] = ratio
		default:
			return invalid("比例仅支持自适应、16:9、4:3、1:1、3:4、9:16")
		}
	}
	if value, ok := params["duration"]; ok {
		n, valid := hopBaseWanInteger(value)
		if !valid || (n != -1 && (n < 2 || n > 30)) {
			return invalid("时长须为 2–30 秒整数或 -1（自动）")
		}
		params["duration"] = n
	}
	if value, ok := params["seed"]; ok {
		n, valid := hopBaseWanInteger(value)
		if !valid || n < 0 || n > 2147483647 {
			return invalid("seed 须为 0–2147483647 的整数")
		}
		params["seed"] = n
	}
	for _, key := range []string{"audio", "prompt_extend", "watermark"} {
		if value, ok := params[key]; ok {
			if _, valid := value.(bool); !valid {
				return invalid(key + " 必须是布尔值")
			}
		}
	}
	media := []hopBaseWanMedia{}
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	switch mode {
	case "", "auto", "image_reference", "multi-image", "all_reference", "all-in-one", "first_frame", "start_frame", "start_end", "last_frame":
	default:
		return invalid("不支持此参考模式，请选择首尾帧或全能参考")
	}
	for i, raw := range req.ReferenceImages {
		kind := "reference_image"
		switch mode {
		case "first_frame", "start_frame":
			kind = "first_frame"
		case "last_frame":
			kind = "last_frame"
		case "start_end":
			if i == 0 {
				kind = "first_frame"
			} else {
				kind = "last_frame"
			}
		}
		media = append(media, hopBaseWanMedia{Type: kind, URL: raw})
	}
	for _, raw := range collectArkReferenceVideos(req) {
		media = append(media, hopBaseWanMedia{Type: "reference_video", URL: raw})
	}
	for _, raw := range collectArkReferenceAudios(req) {
		media = append(media, hopBaseWanMedia{Type: "reference_audio", URL: raw})
	}
	// Advanced callers can supply typed media (including a document or webpage)
	// through the existing provider-specific parameters extension.
	if raw, ok := req.Parameters["media"]; ok {
		data, err := json.Marshal(raw)
		if err != nil {
			return invalid("media 必须是包含 type / url 的数组")
		}
		var extra []hopBaseWanMedia
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&extra); err != nil || len(extra) == 0 {
			return invalid("media 必须是包含 type / url 的非空数组")
		}
		media = append(media, extra...)
	}
	counts := map[string]int{}
	limits := map[string]int{"first_frame": 1, "last_frame": 1, "reference_image": 10, "reference_video": 5, "reference_audio": 5, "file": 1, "link": 1}
	for _, item := range media {
		limit, ok := limits[item.Type]
		if !ok {
			return invalid("未知素材类型：" + item.Type)
		}
		counts[item.Type]++
		if counts[item.Type] > limit {
			return invalid(fmt.Sprintf("%s 最多支持 %d 个", item.Type, limit))
		}
	}
	frames := counts["first_frame"] + counts["last_frame"]
	if frames > 0 && len(media) > frames {
		return invalid("首尾帧不能与参考图片、视频、音频、文档或网页混用")
	}
	if counts["file"] > 0 && counts["link"] > 0 {
		return invalid("文档与网页不能同时使用")
	}
	if prompt == "" && len(media) == 0 {
		return invalid("请提供提示词或参考素材")
	}
	for i, item := range media {
		resolved, err := hopBaseWanMediaURL(ctx, item.URL, item.Type == "link")
		if err != nil {
			return invalid(fmt.Sprintf("素材 #%d：%s", i+1, err.Error()))
		}
		media[i].URL = resolved
	}
	input := map[string]any{}
	if prompt != "" {
		input["prompt"] = prompt
	}
	if len(media) > 0 {
		input["media"] = media
	}
	body := map[string]any{"model": "wan3.0-video", "input": input}
	if len(params) > 0 {
		body["parameters"] = params
	}
	return body, nil
}

func hopBaseWanInteger(value any) (int, bool) {
	switch n := value.(type) {
	case int:
		return n, true
	case float64:
		if !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= -1 && n <= 2147483647 {
			return int(n), true
		}
	case json.Number:
		v, err := n.Int64()
		if err == nil && v >= -1 && v <= 2147483647 {
			return int(v), true
		}
	}
	return 0, false
}

func hopBaseWanMediaURL(ctx context.Context, raw string, webpage bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "data:") && !webpage {
		header, payload, found := strings.Cut(raw, ",")
		if !found || !strings.HasSuffix(header, ";base64") || payload == "" {
			return "", fmt.Errorf("需要有效的 base64 data URL")
		}
		if _, err := io.Copy(io.Discard, base64.NewDecoder(base64.StdEncoding, strings.NewReader(payload))); err != nil {
			return "", fmt.Errorf("base64 素材编码无效")
		}
		return raw, nil
	}
	if webpage {
		if err := safehttp.ValidatePublicURL(raw); err != nil {
			return "", fmt.Errorf("网页必须是公网 http(s) 地址")
		}
		return raw, nil
	}
	// Reuse object-store signing/local upload support, not Ark's image resizing
	// or asset:// conversion: Wan has its own reference contract.
	resolved, err := arkReferenceMediaURL(ctx, raw)
	if err != nil {
		return "", fmt.Errorf("需要公网 http(s) 地址或 base64 素材，不支持 oss:// 或 asset://")
	}
	if err := safehttp.ValidatePublicURL(resolved); err != nil {
		return "", fmt.Errorf("参考素材不是有效的公网地址")
	}
	return resolved, nil
}

// Strip conventional API suffixes so switching from a /v1 channel does not
// accidentally submit to /v1/api/v1. Preserve custom reverse-proxy prefixes.
func hopBaseWanURL(baseURL, path string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	for _, suffix := range []string{"/api/v1", "/v1"} {
		if strings.HasSuffix(baseURL, suffix) {
			baseURL = strings.TrimSuffix(baseURL, suffix)
			break
		}
	}
	return resolveProviderURL(baseURL, path)
}

func (s *Service) generateVideoHopBaseWan3(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	body, err := buildHopBaseWan3Body(ctx, req)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "万相请求编码失败", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, hopBaseWanURL(baseURL, hopBaseWanSubmitPath), bytes.NewReader(encoded))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "万相接口地址无效", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := doWanSubmitWithPreflightRetry(ctx, newWanSubmitClient(), request, encoded)
	if err != nil {
		return nil, apperror.ProviderRequestFailure(err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, apperror.New(apperror.CodeUpstreamUnavailable, "万相生成接口返回重定向，已阻止自动重发；请检查渠道地址，上游受理状态待确认")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if readErr != nil {
		return nil, apperror.ProviderRequestFailure(readErr)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, parseProviderErrorBytes(response.StatusCode, data)
	}
	var submitted struct {
		Output struct {
			TaskID string `json:"task_id"`
		} `json:"output"`
	}
	if json.Unmarshal(data, &submitted) != nil || strings.TrimSpace(submitted.Output.TaskID) == "" {
		return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "万相未返回任务编号；请检查渠道，避免重复提交")
	}
	s.rememberProviderTask(req.GenerationLogID, pc.ID, submitted.Output.TaskID)
	return s.pollHopBaseWan3Task(ctx, baseURL, apiKey, submitted.Output.TaskID)
}

func (s *Service) pollHopBaseWan3Task(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	ctx, cancel := context.WithTimeout(ctx, videoGenerationTimeout())
	defer cancel()
	client := safehttp.Client(30 * time.Second)
	pollURL := hopBaseWanURL(baseURL, "/api/v1/tasks") + "/" + url.PathEscape(taskID)
	for {
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeTimeout, "万相任务查询超时，任务编号已保留；请先检查任务状态，避免重复提交")
		case <-time.After(hopBaseWanPollInterval):
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, "万相任务查询地址无效", err)
		}
		request.Header.Set("Authorization", "Bearer "+apiKey)
		response, err := client.Do(request)
		if err != nil {
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		response.Body.Close()
		// A quota check can reject GET even after the paid task was accepted.
		// That is not a terminal generation failure: keep querying the saved
		// task, bounded by ctx. Never resubmit video generation here.
		if readErr != nil || response.StatusCode == 402 || response.StatusCode == 429 || response.StatusCode >= 500 {
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, parseProviderErrorBytes(response.StatusCode, data)
		}
		var task struct {
			Output struct {
				Status   string `json:"task_status"`
				VideoURL string `json:"video_url"`
			} `json:"output"`
		}
		if json.Unmarshal(data, &task) != nil {
			continue
		}
		switch strings.ToUpper(task.Output.Status) {
		case "SUCCEEDED":
			if task.Output.VideoURL == "" {
				return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "万相任务已完成，但未返回视频地址")
			}
			return &GenerateResult{Type: "url", Content: task.Output.VideoURL}, nil
		case "FAILED":
			return nil, apperror.ProviderFailure(response.StatusCode, data)
			// Only SUCCEEDED and FAILED are terminal, including future unknown states.
		}
	}
}
