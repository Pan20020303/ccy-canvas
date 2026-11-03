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
	"unicode/utf8"
)

const hopBaseMiniMaxRequestLimit = 64 << 20

type hopBaseMiniMaxCapabilities struct {
	minDuration int
	maxDuration int
	resolutions map[string]string
	multimodal  bool
	selfHosted  bool
}

func hopBaseMiniMaxCapabilitiesFor(model string) (hopBaseMiniMaxCapabilities, bool) {
	resolutions := func(values ...string) map[string]string {
		out := make(map[string]string, len(values))
		for _, value := range values {
			out[strings.ToLower(value)] = value
		}
		return out
	}
	switch strings.TrimSpace(model) {
	case "MiniMax-H3":
		return hopBaseMiniMaxCapabilities{minDuration: 4, maxDuration: 15, resolutions: resolutions("768P", "2K"), multimodal: true}, true
	case "MiniMax-H3-Max":
		return hopBaseMiniMaxCapabilities{minDuration: 5, maxDuration: 15, resolutions: resolutions("480P", "768P")}, true
	case "MiniMax-H3-SelfHosted":
		return hopBaseMiniMaxCapabilities{minDuration: 4, maxDuration: 15, resolutions: resolutions("480P", "768P", "1080P", "2K", "4K"), multimodal: true, selfHosted: true}, true
	default:
		return hopBaseMiniMaxCapabilities{}, false
	}
}

func isHopBaseMiniMaxH3Provider(pc *domain.ProviderConfig, baseURL, model string) bool {
	if !isHopBaseProvider(pc, baseURL) {
		return false
	}
	_, ok := hopBaseMiniMaxCapabilitiesFor(model)
	return ok
}

func hopBaseMiniMaxFrameMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "first_frame", "start_frame", "start_end":
		return true
	default:
		return false
	}
}

func validateHopBaseMiniMaxRequest(req GenerateRequest) error {
	caps, ok := hopBaseMiniMaxCapabilitiesFor(req.Model)
	if !ok {
		return apperror.New(apperror.CodeInvalidInput, "请使用精确型号 MiniMax-H3、MiniMax-H3-Max 或 MiniMax-H3-SelfHosted")
	}
	prompt := strings.TrimSpace(req.Prompt)
	if count := utf8.RuneCountInString(prompt); count < 1 || count > 7000 {
		return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 提示词长度必须为 1–7000 个字符")
	}
	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))
	if resolution != "" {
		if _, exists := caps.resolutions[resolution]; !exists {
			return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 不支持分辨率 %s", req.Model, req.Resolution))
		}
	}
	if req.Duration != 0 && (req.Duration < caps.minDuration || req.Duration > caps.maxDuration) {
		return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("型号 %s 时长必须为 %d–%d 秒整数", req.Model, caps.minDuration, caps.maxDuration))
	}
	ratio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if ratio == "auto" {
		ratio = "adaptive"
	}
	if ratio != "" && !hopBaseRatioAllowed(ratio) {
		return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 比例仅支持 21:9、16:9、4:3、1:1、3:4、9:16 或 adaptive")
	}

	images := req.ReferenceImages
	videos := collectArkReferenceVideos(req)
	audios := collectHopBaseReferenceAudios(req)
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	frameMode := hopBaseMiniMaxFrameMode(mode)
	hasMedia := len(images)+len(videos)+len(audios) > 0

	if frameMode {
		if len(images) < 1 || len(images) > 2 || len(videos) > 0 || len(audios) > 0 {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 首帧/首尾帧模式需要 1–2 张图片，不能混入参考视频或音频")
		}
		if (mode == "first_frame" || mode == "start_frame") && len(images) != 1 {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 首帧模式需要恰好 1 张图片")
		}
	} else if !caps.multimodal {
		if hasMedia {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax-H3-Max 仅支持文生视频或首帧/首尾帧模式")
		}
	} else {
		if len(images) > 9 || len(videos) > 3 || len(audios) > 3 {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 最多支持 9 张参考图、3 段参考视频和 3 段参考音频")
		}
		if len(images)+len(videos)+len(audios) > 12 {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 单次请求的参考媒体合计不能超过 12 个")
		}
		if len(audios) > 0 && len(images)+len(videos) == 0 {
			return apperror.New(apperror.CodeInvalidInput, "MiniMax H3 参考音频必须同时提供图片或视频参考")
		}
	}

	for _, batch := range []struct {
		kind string
		urls []string
	}{{"image", images}, {"video", videos}, {"audio", audios}} {
		for index, raw := range batch.urls {
			if err := validateHopBaseMiniMaxMediaURL(raw, batch.kind, caps.selfHosted); err != nil {
				return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 参考%s #%d 无法使用：%v", batch.kind, index+1, err))
			}
		}
	}
	return nil
}

func validateHopBaseMiniMaxMediaURL(raw, kind string, selfHosted bool) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("素材地址为空")
	}
	if strings.HasPrefix(raw, "data:") {
		if selfHosted && kind != "image" {
			return fmt.Errorf("自部署版参考视频和音频必须使用公网 HTTP(S) 地址")
		}
		prefix := "data:" + kind + "/"
		if !strings.HasPrefix(strings.ToLower(raw), prefix) {
			return fmt.Errorf("内嵌素材类型与 %s 不匹配", kind)
		}
		return nil
	}
	if strings.HasPrefix(raw, "/uploads/") {
		_, err := hopBaseLocalReferencePath(raw)
		return err
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("需要公网 HTTP(S) 地址、受支持的 data URI 或已上传素材")
	}
	if err := safehttp.ValidatePublicURL(raw); err != nil {
		return fmt.Errorf("素材地址不是可公开访问的 URL")
	}
	return nil
}

func hopBaseMiniMaxMediaURL(ctx context.Context, raw, kind string, selfHosted bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "data:") {
		if err := validateHopBaseMiniMaxMediaURL(raw, kind, selfHosted); err != nil {
			return "", err
		}
		return raw, nil
	}
	return hopBaseReferenceMediaURL(ctx, raw)
}

func buildHopBaseMiniMaxH3Body(ctx context.Context, req GenerateRequest) (map[string]any, error) {
	if err := validateHopBaseMiniMaxRequest(req); err != nil {
		return nil, err
	}
	caps, _ := hopBaseMiniMaxCapabilitiesFor(req.Model)
	resolution := caps.resolutions[strings.ToLower(strings.TrimSpace(req.Resolution))]
	if resolution == "" {
		resolution = "768P"
	}
	duration := req.Duration
	if duration == 0 {
		duration = caps.minDuration
	}
	images := req.ReferenceImages
	videos := collectArkReferenceVideos(req)
	audios := collectHopBaseReferenceAudios(req)
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	frameMode := hopBaseMiniMaxFrameMode(mode)
	ratio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if ratio == "auto" {
		ratio = "adaptive"
	}
	if frameMode {
		ratio = "adaptive"
	} else if len(images)+len(videos)+len(audios) == 0 && ratio == "adaptive" {
		// The UI exposes adaptive because the same model also supports reference
		// modes. MiniMax rejects adaptive for text-only requests, so normalize a
		// stale/automatic selection to the product default before the paid call.
		ratio = "16:9"
	} else if ratio == "" {
		if len(images)+len(videos)+len(audios) > 0 {
			ratio = "adaptive"
		} else {
			ratio = "16:9"
		}
	}

	content := make([]map[string]any, 0, 1+len(images)+len(videos)+len(audios))
	content = append(content, map[string]any{"type": "text", "text": strings.TrimSpace(req.Prompt)})
	for index, raw := range images {
		resolved, err := hopBaseMiniMaxMediaURL(ctx, raw, "image", caps.selfHosted)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 参考图 #%d 处理失败", index+1), err)
		}
		role := "reference_image"
		if frameMode || !caps.multimodal {
			role = "first_frame"
			if index == 1 {
				role = "last_frame"
			}
		}
		content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": resolved}, "role": role})
	}
	for index, raw := range videos {
		resolved, err := hopBaseMiniMaxMediaURL(ctx, raw, "video", caps.selfHosted)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 参考视频 #%d 处理失败", index+1), err)
		}
		content = append(content, map[string]any{"type": "video_url", "video_url": map[string]any{"url": resolved}, "role": "reference_video"})
	}
	for index, raw := range audios {
		resolved, err := hopBaseMiniMaxMediaURL(ctx, raw, "audio", caps.selfHosted)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 参考音频 #%d 处理失败", index+1), err)
		}
		content = append(content, map[string]any{"type": "audio_url", "audio_url": map[string]any{"url": resolved}, "role": "reference_audio"})
	}

	body := map[string]any{
		"model": req.Model, "content": content, "resolution": resolution,
		"duration": duration, "ratio": ratio,
	}
	if watermark, exists := req.Parameters["aigc_watermark"]; exists {
		if enabled, valid := watermark.(bool); valid {
			body["aigc_watermark"] = enabled
		}
	}
	return body, nil
}

func (s *Service) generateVideoHopBaseMiniMaxH3(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if req.UpstreamTaskID != "" {
		if pc == nil || pc.ID != req.UpstreamProviderID {
			return nil, apperror.New(apperror.CodeInvalidInput, "原视频任务渠道已变更，请恢复原渠道后查询任务，避免重复生成")
		}
		return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, req.UpstreamTaskID)
	}
	body, err := buildHopBaseMiniMaxH3Body(ctx, req)
	if err != nil {
		return nil, err
	}
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "编码 MiniMax H3 请求失败", err)
	}
	if len(bodyJSON) > hopBaseMiniMaxRequestLimit {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 请求体超过 64 MiB，请改用公网素材 URL")
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, hopBaseVideoSubmitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "创建 MiniMax H3 请求失败", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := doProviderSubmitOnce(ctx, safehttp.Client(hopBaseVideoSubmitTimeout()), httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.ProviderRequestFailure(err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, parseProviderErrorBytes(resp.StatusCode, respBody)
	}
	var submitted map[string]any
	if err := json.Unmarshal(respBody, &submitted); err != nil {
		return nil, apperror.ProviderResponseFailure(resp.StatusCode, respBody, "MiniMax H3 返回的任务数据无法解析")
	}
	if outputURL := hopBaseVideoOutputURL(submitted); outputURL != "" {
		return &GenerateResult{Type: "url", Content: outputURL}, nil
	}
	taskID := hopBaseTaskID(submitted)
	if taskID == "" {
		return nil, apperror.ProviderResponseFailure(resp.StatusCode, respBody, "MiniMax H3 未返回任务编号")
	}
	providerID := ""
	if pc != nil {
		providerID = pc.ID
	}
	s.rememberProviderTask(req.GenerationLogID, providerID, taskID)
	return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, taskID)
}
