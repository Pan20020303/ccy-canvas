package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

const hopBaseMidjourneyModel = "midjourney-v8-2"

var midjourneyPromptFlag = regexp.MustCompile(`(?i)(?:^|\s)--([a-z][a-z0-9-]*)`)
var midjourneyRatio = regexp.MustCompile(`^[0-9]+:[0-9]+$`)

func midjourneyInvalid(message string) error {
	return apperror.New(apperror.CodeInvalidInput, "Midjourney 8.2："+message)
}

// Canvas ratio/resolution controls become prompt flags, never JSON size or quality.
// A ratio selected on the canvas is authoritative. Pasted prompt flags must
// not silently override the ratio shown in the generation controls.
func hopBaseMidjourneyPrompt(req GenerateRequest) (string, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" || strings.HasPrefix(prompt, "--") {
		return "", midjourneyInvalid("请填写画面描述，不能只提供参数或参考图")
	}
	if strings.Contains(prompt, "::") {
		return "", midjourneyInvalid("不支持 :: 多段提示词权重")
	}
	resolution := strings.ToUpper(strings.TrimSpace(req.Resolution))
	if resolution != "" && resolution != "1K" && resolution != "2K" {
		return "", midjourneyInvalid("分辨率仅支持 1K 或 2K")
	}
	matches := midjourneyPromptFlag.FindAllStringSubmatchIndex(prompt, -1)
	hasRatio, hasHD := false, false
	ratio := ""
	ratioStart, ratioEnd := -1, -1
	for _, match := range matches {
		if strings.EqualFold(prompt[match[2]:match[3]], "hd") {
			hasHD = true
		}
	}
	for i, match := range matches {
		flag := strings.ToLower(prompt[match[2]:match[3]])
		end := len(prompt)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		values := strings.Fields(prompt[match[1]:end])
		switch flag {
		case "q", "quality", "niji", "repeat", "r", "oref", "cref", "stealth", "stop", "draft", "profile", "p":
			return "", midjourneyInvalid("不支持参数 --" + flag)
		case "ar", "aspect":
			if hasRatio || len(values) != 1 {
				return "", midjourneyInvalid("画幅参数只可填写一次，且须为一个整数比例，例如 --ar 16:9")
			}
			hasRatio, ratio = true, values[0]
			ratioStart, ratioEnd = match[0], end
		case "hd", "tile":
			if len(values) != 0 {
				return "", midjourneyInvalid("--" + flag + " 是开关，后面不能填写数值或描述")
			}
		case "s", "stylize", "c", "chaos", "weird", "w", "iw", "sw", "exp", "seed":
			if len(values) != 1 {
				return "", midjourneyInvalid("--" + flag + " 后须填写一个数值")
			}
			if flag == "seed" {
				if _, err := strconv.ParseInt(values[0], 10, 64); err != nil {
					return "", midjourneyInvalid("--seed 须为整数")
				}
				continue
			}
			maximum := map[string]float64{"s": 1000, "stylize": 1000, "c": 100, "chaos": 100, "weird": 3000, "w": 3000, "iw": 3, "sw": 1000, "exp": 100}[flag]
			n, err := strconv.ParseFloat(values[0], 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > maximum {
				return "", midjourneyInvalid(fmt.Sprintf("--%s 须为 0–%g 的数值", flag, maximum))
			}
		}
	}
	selectedRatio := strings.TrimSpace(req.Size)
	if selectedRatio == "" || strings.EqualFold(selectedRatio, "auto") {
		selectedRatio = strings.TrimSpace(req.AspectRatio)
	}
	if strings.EqualFold(selectedRatio, "auto") {
		selectedRatio = ""
	}
	if selectedRatio != "" {
		ratio = selectedRatio
	}
	if ratio != "" {
		if !midjourneyRatio.MatchString(ratio) {
			return "", midjourneyInvalid("画幅须为正整数比例，例如 16:9")
		}
		parts := strings.Split(ratio, ":")
		w, errW := strconv.ParseUint(parts[0], 10, 32)
		h, errH := strconv.ParseUint(parts[1], 10, 32)
		limit := uint64(14)
		if hasHD || resolution == "2K" {
			limit = 4
		}
		if errW != nil || errH != nil || w == 0 || h == 0 || w > h*limit || h > w*limit {
			return "", midjourneyInvalid(fmt.Sprintf("横竖画幅比例不可超过 %d:1", limit))
		}
		if hasRatio && selectedRatio != "" {
			prompt = strings.TrimSpace(prompt[:ratioStart]) + " --ar " + ratio + prompt[ratioEnd:]
		} else if !hasRatio {
			prompt += " --ar " + ratio
		}
	}
	if resolution == "2K" && !hasHD {
		prompt += " --hd"
	}
	return prompt, nil
}

func validateHopBaseMidjourney(req GenerateRequest) error {
	if req.OutputCount != 0 && req.OutputCount != 4 {
		return midjourneyInvalid("每次任务固定生成并计费 4 张图，请将张数设为 4")
	}
	if len(req.ReferenceImages) > 1 {
		return midjourneyInvalid("最多支持 1 张参考图")
	}
	if len(collectArkReferenceVideos(req))+len(collectHopBaseReferenceAudios(req)) > 0 {
		return midjourneyInvalid("不支持视频或音频参考")
	}
	if strings.TrimSpace(req.MaskImage) != "" {
		return midjourneyInvalid("不支持蒙版编辑")
	}
	for _, ref := range req.ReferenceImages {
		ref = strings.TrimSpace(ref)
		if !strings.HasPrefix(ref, "/uploads/") {
			parsed, err := url.Parse(ref)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return midjourneyInvalid("参考图需要已上传的文件或公网 HTTP(S) 链接")
			}
		}
	}
	_, err := hopBaseMidjourneyPrompt(req)
	return err
}

func buildHopBaseMidjourneyBody(ctx context.Context, req GenerateRequest) (map[string]any, error) {
	if err := validateHopBaseMidjourney(req); err != nil {
		return nil, err
	}
	prompt, _ := hopBaseMidjourneyPrompt(req)
	body := map[string]any{"model": hopBaseMidjourneyModel, "prompt": prompt, "n": 4}
	if len(req.ReferenceImages) == 1 {
		resolved, err := arkReferenceMediaURL(ctx, req.ReferenceImages[0])
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, "Midjourney 参考图无法转换为可访问链接", err)
		}
		if err := safehttp.ValidatePublicURL(resolved); err != nil {
			return nil, midjourneyInvalid("参考图需要公网 HTTP(S) 链接")
		}
		body["images"] = []map[string]string{{"url": resolved}}
	}
	return body, nil
}

func (s *Service) generateImageHopBaseMidjourney(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if req.UpstreamTaskID != "" {
		if pc == nil || pc.ID != req.UpstreamProviderID {
			return nil, midjourneyInvalid("原任务渠道已变更，请恢复原渠道后查询")
		}
		return s.pollHopBaseMidjourneyTask(ctx, baseURL, apiKey, req.UpstreamTaskID)
	}
	body, err := buildHopBaseMidjourneyBody(ctx, req)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Midjourney 请求编码失败", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, hopBaseWanURL(baseURL, "/v1/images/generations"), bytes.NewReader(encoded))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "Midjourney 接口地址无效", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := doProviderSubmitOnce(ctx, newProviderHTTPClient(imageGenerationTimeout()), request, encoded)
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
	var submitted struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &submitted) != nil || strings.TrimSpace(submitted.ID) == "" {
		return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "Midjourney 未返回任务编号；请先检查上游任务，避免重复提交")
	}
	if s.repo != nil && pc != nil && req.GenerationLogID != "" {
		persistCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := s.repo.SetGenerationLogUpstreamTask(persistCtx, req.GenerationLogID, pc.ID, submitted.ID); err != nil {
			log.Printf("[midjourney] failed to save task checkpoint log=%s task=%s: %v", req.GenerationLogID, submitted.ID, err)
		}
		cancel()
	}
	return s.pollHopBaseMidjourneyTask(ctx, baseURL, apiKey, submitted.ID)
}

// Only completed/failed are terminal. Preserve the full set of four URLs.
func (s *Service) pollHopBaseMidjourneyTask(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	ctx, cancel := context.WithTimeout(ctx, MidjourneyTaskPollBudget)
	defer cancel()
	client := safehttp.Client(30 * time.Second)
	pollURL := hopBaseWanURL(baseURL, "/v1/video/tasks") + "/" + url.PathEscape(taskID)
	for attempt := 0; ; attempt++ {
		delay := imageTaskPollInterval
		if attempt == 0 {
			delay = imageTaskPollInitialDelay
		}
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeTimeout, "Midjourney 查询超时，任务编号已保留，请先查询原任务，避免重复生成")
		case <-time.After(delay):
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInvalidInput, "Midjourney 查询地址无效", err)
		}
		request.Header.Set("Authorization", "Bearer "+apiKey)
		response, err := client.Do(request)
		if err != nil {
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		response.Body.Close()
		if readErr != nil || response.StatusCode == 408 || response.StatusCode == 429 || response.StatusCode >= 500 {
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, parseProviderErrorBytes(response.StatusCode, data)
		}
		var task struct {
			Status  string   `json:"status"`
			Outputs []string `json:"outputs"`
		}
		if json.Unmarshal(data, &task) != nil {
			continue
		}
		switch strings.ToLower(task.Status) {
		case "failed":
			return nil, apperror.ProviderFailure(response.StatusCode, data)
		case "completed":
			if len(task.Outputs) != 4 {
				continue // Output publication may lag behind the status update.
			}
			for _, raw := range task.Outputs {
				u, err := url.Parse(raw)
				if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
					return nil, apperror.ProviderResponseFailure(response.StatusCode, data, "Midjourney 返回的图片链接无效")
				}
			}
			return &GenerateResult{Type: "url", Content: task.Outputs[0], ContentList: task.Outputs}, nil
		}
	}
}
