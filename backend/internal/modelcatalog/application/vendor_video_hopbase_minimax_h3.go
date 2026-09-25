package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

func isHopBaseMiniMaxH3Model(model string) bool {
	return model == "MiniMax-H3" || model == "MiniMax-H3-Max"
}

func validateHopBaseMiniMaxH3(req GenerateRequest) error {
	invalid := func(message string) error {
		return apperror.New(apperror.CodeInvalidInput, "MiniMax H3："+message)
	}
	if !isHopBaseMiniMaxH3Model(req.Model) {
		return invalid("型号仅支持 MiniMax-H3 或 MiniMax-H3-Max")
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" || utf8.RuneCountInString(prompt) > 7000 {
		return invalid("提示词须为 1–7000 个字符")
	}
	resolution := strings.ToUpper(strings.TrimSpace(req.Resolution))
	if resolution != "" && resolution != "768P" && resolution != "2K" && resolution != "480P" {
		return invalid("分辨率无效")
	}
	if req.Model == "MiniMax-H3" && resolution == "480P" || req.Model == "MiniMax-H3-Max" && resolution == "2K" {
		return invalid("此型号不支持所选分辨率")
	}
	minimum := 4
	if req.Model == "MiniMax-H3-Max" {
		minimum = 5
	}
	if req.Duration != 0 && (req.Duration < minimum || req.Duration > 15) {
		return invalid(fmt.Sprintf("时长须为 %d–15 秒整数", minimum))
	}
	images := len(req.ReferenceImages)
	videos := len(collectArkReferenceVideos(req))
	audios := len(collectHopBaseReferenceAudios(req))
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	frameMode := mode == "first_frame" || mode == "start_frame" || mode == "start_end" || mode == "last_frame"
	switch mode {
	case "", "auto", "first_frame", "start_frame", "start_end", "last_frame", "image_reference", "multi-image", "all-in-one", "motion_mimic":
	default:
		return invalid("参考模式无效")
	}
	if images > 9 || videos > 3 || audios > 3 || images+videos+audios > 12 {
		return invalid("最多支持 9 张图、3 条视频、3 条音频，合计不超过 12 个素材")
	}
	if frameMode {
		if images < 1 || images > 2 || videos > 0 || audios > 0 || mode != "start_end" && images != 1 {
			return invalid("首尾帧模式需 1–2 张图，不能混用视频或音频参考")
		}
	} else if images+videos+audios > 0 {
		if req.Model == "MiniMax-H3-Max" {
			return invalid("H3 Max 仅支持首尾帧，不支持多模态参考")
		}
		if audios > 0 && images+videos == 0 {
			return invalid("音频参考需同时提供图片或视频参考")
		}
	}
	if req.Model == "MiniMax-H3-Max" && videos+audios > 0 {
		return invalid("H3 Max 不支持视频或音频参考")
	}
	ratio := strings.TrimSpace(req.AspectRatio)
	if ratio == "" {
		ratio = strings.TrimSpace(req.Size)
	}
	if ratio != "" && ratio != "auto" && ratio != "adaptive" && !hopBaseRatioAllowed(ratio) {
		return invalid("比例仅支持 21:9、16:9、4:3、1:1、3:4、9:16 或自适应")
	}
	if images+videos+audios == 0 && (ratio == "auto" || ratio == "adaptive") {
		return invalid("文生视频需选择明确的画幅比例")
	}
	if value, present := req.Parameters["aigc_watermark"]; present {
		if _, ok := value.(bool); !ok {
			return invalid("水印参数须为布尔值")
		}
	}
	return nil
}

func buildHopBaseMiniMaxH3Body(ctx context.Context, req GenerateRequest) (map[string]any, error) {
	if err := validateHopBaseMiniMaxH3(req); err != nil {
		return nil, err
	}
	resolution := strings.ToUpper(strings.TrimSpace(req.Resolution))
	if resolution == "" {
		resolution = "768P"
	}
	duration := req.Duration
	if duration == 0 {
		duration = 5
	}
	content := []map[string]any{{"type": "text", "text": strings.TrimSpace(req.Prompt)}}
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	frameMode := mode == "first_frame" || mode == "start_frame" || mode == "start_end" || mode == "last_frame"
	for i, raw := range req.ReferenceImages {
		mediaURL, err := hopBaseWanMediaURL(ctx, raw, false)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 图片 #%d 无法访问", i+1), err)
		}
		role := "reference_image"
		if frameMode {
			role = "first_frame"
			if mode == "last_frame" || mode == "start_end" && i == 1 {
				role = "last_frame"
			}
		}
		content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": mediaURL}, "role": role})
	}
	for i, raw := range collectArkReferenceVideos(req) {
		mediaURL, err := hopBaseWanMediaURL(ctx, raw, false)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 视频 #%d 无法访问", i+1), err)
		}
		content = append(content, map[string]any{"type": "video_url", "video_url": map[string]string{"url": mediaURL}, "role": "reference_video"})
	}
	for i, raw := range collectHopBaseReferenceAudios(req) {
		mediaURL, err := hopBaseWanMediaURL(ctx, raw, false)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("MiniMax H3 音频 #%d 无法访问", i+1), err)
		}
		content = append(content, map[string]any{"type": "audio_url", "audio_url": map[string]string{"url": mediaURL}, "role": "reference_audio"})
	}
	body := map[string]any{"model": req.Model, "content": content, "resolution": resolution, "duration": duration}
	ratio := strings.TrimSpace(req.AspectRatio)
	if ratio == "" {
		ratio = strings.TrimSpace(req.Size)
	}
	if len(content) == 1 && ratio == "" {
		ratio = "16:9"
	}
	if ratio != "" && ratio != "auto" && ratio != "adaptive" {
		body["ratio"] = ratio
	}
	if value, ok := req.Parameters["aigc_watermark"]; ok {
		body["aigc_watermark"] = value
	}
	return body, nil
}

func (s *Service) generateVideoHopBaseMiniMaxH3(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = hopBaseWanURL(baseURL, "")
	if req.UpstreamTaskID != "" {
		if pc == nil || pc.ID != req.UpstreamProviderID {
			return nil, apperror.New(apperror.CodeInvalidInput, "原视频任务渠道已变更，请恢复原渠道后查询任务")
		}
		return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, req.UpstreamTaskID)
	}
	body, err := buildHopBaseMiniMaxH3Body(ctx, req)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "MiniMax H3 请求编码失败", err)
	}
	if len(encoded) > 64<<20 {
		return nil, apperror.New(apperror.CodeInvalidInput, "MiniMax H3 请求超过 64 MiB，请改用素材链接")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, hopBaseVideoSubmitPath), bytes.NewReader(encoded))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "MiniMax H3 接口地址无效", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := doProviderSubmitOnce(ctx, safehttp.Client(hopBaseVideoSubmitTimeout()), request, encoded)
	if err != nil {
		return nil, apperror.ProviderRequestFailure(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, apperror.ProviderRequestFailure(err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, parseProviderErrorBytes(response.StatusCode, data)
	}
	var submitted map[string]any
	if json.Unmarshal(data, &submitted) != nil {
		return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "MiniMax H3 未返回可识别的任务信息")
	}
	taskID := hopBaseTaskID(submitted)
	if taskID == "" {
		taskID, _ = submitted["id"].(string)
		taskID = strings.TrimSpace(taskID)
	}
	if taskID == "" {
		return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "MiniMax H3 未返回任务编号；请先检查上游任务，避免重复提交")
	}
	if pc != nil {
		s.rememberProviderTask(req.GenerationLogID, pc.ID, taskID)
	}
	return s.pollHopBaseVideoTask(ctx, baseURL, apiKey, taskID)
}
