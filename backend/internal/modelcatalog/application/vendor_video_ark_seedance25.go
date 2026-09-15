package application

import (
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"
)

func isSeedance25Model(model string) bool {
	model = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(model)), ".", "-")
	return strings.Contains(model, "seedance-2-5")
}

func collectArkReferenceAudios(req GenerateRequest) []string {
	seen := make(map[string]bool)
	var refs []string
	for _, raw := range append([]string{req.ReferenceAudio}, req.ReferenceAudios...) {
		ref := strings.TrimSpace(raw)
		if ref != "" && !seen[ref] {
			refs = append(refs, ref)
			seen[ref] = true
		}
	}
	return refs
}

// These are 2.5-only preflight checks. Media duration/size/content moderation
// still belongs to Ark; preserve its actual errors rather than guessing them.
func validateArkSeedance25Request(req GenerateRequest) error {
	invalid := func(message string) error { return apperror.New(apperror.CodeInvalidInput, message) }
	if req.Duration != 0 && req.Duration != -1 && (req.Duration < 4 || req.Duration > 30) {
		return invalid("Seedance 2.5 视频时长需为 4～30 秒，或 -1（自动）。")
	}
	switch strings.ToLower(strings.TrimSpace(req.Resolution)) {
	case "", "480p", "720p":
	default:
		return invalid("Seedance 2.5 仅支持 480p / 720p 分辨率。")
	}
	switch strings.ToLower(strings.TrimSpace(req.OutputFormat)) {
	case "", "mp4", "mov":
	default:
		return invalid("Seedance 2.5 仅支持 MP4 / MOV 输出格式。")
	}
	switch strings.ToLower(strings.TrimSpace(req.AudioSetting)) {
	case "", "on", "off":
	default:
		return invalid("Seedance 2.5 音频设置仅支持 on / off。")
	}
	videoCount, audioCount := len(collectArkReferenceVideos(req)), len(collectArkReferenceAudios(req))
	if len(req.ReferenceImages) > 30 || videoCount > 10 || audioCount > 10 {
		return invalid("Seedance 2.5 最多支持 30 张参考图片、10 段参考视频和 10 段参考音频。")
	}
	switch req.ReferenceMode {
	case "start_end", "start_frame", "first_frame":
		maxImages := 1
		if req.ReferenceMode == "start_end" {
			maxImages = 2
		}
		if len(req.ReferenceImages) < 1 || len(req.ReferenceImages) > maxImages || videoCount > 0 || audioCount > 0 {
			return invalid("Seedance 2.5 首帧/首尾帧模式不能混用多模态参考；混合图片、视频或音频请使用全能参考。")
		}
	case "", "auto", "image_reference", "motion_mimic":
	default:
		return invalid("当前 Seedance 2.5 官方模板支持文生视频、首尾帧和多模态参考生成。")
	}
	return nil
}

func applyArkSeedance25Options(body map[string]interface{}, req GenerateRequest) {
	// Map the existing canvas audio switch to Ark's boolean, including false.
	body["generate_audio"] = !strings.EqualFold(strings.TrimSpace(req.AudioSetting), "off")
	format := strings.ToLower(strings.TrimSpace(req.OutputFormat))
	if format == "" {
		format = "mp4"
	}
	body["output_format"] = format
	if resolution := strings.ToLower(strings.TrimSpace(req.Resolution)); resolution != "" {
		body["resolution"] = resolution
	}
	// Explicit reference mode prevents Ark from interpreting a reference clip
	// as a video-edit/extension request. First/last frames are a separate mode.
	frameMode := req.ReferenceMode == "start_end" || req.ReferenceMode == "start_frame" || req.ReferenceMode == "first_frame"
	if !frameMode && len(req.ReferenceImages)+len(collectArkReferenceVideos(req))+len(collectArkReferenceAudios(req)) > 0 {
		body["omni_reference_task_type"] = "reference"
	}
}
