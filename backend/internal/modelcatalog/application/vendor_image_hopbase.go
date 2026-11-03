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
)

// generateImageHopBase implements HopBase's OpenAI Images compatibility
// layer. Seedream is deliberately special-cased: unlike ordinary OpenAI image
// editing it accepts reference images in the JSON `image` field on the same
// /images/generations endpoint. Keeping that request JSON also avoids the
// multipart/mask semantics that Seedream explicitly does not support.
func (s *Service) generateImageHopBase(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if req.Model == hopBaseMidjourneyModel {
		return s.generateImageHopBaseMidjourney(ctx, pc, baseURL, apiKey, req)
	}
	model := strings.ToLower(strings.TrimSpace(req.Model))
	if len(req.ReferenceImages) > 0 && !strings.HasPrefix(model, "seedream-") {
		return s.generateImageEdit(ctx, pc, baseURL, apiKey, req)
	}
	if strings.TrimSpace(req.MaskImage) != "" && strings.HasPrefix(model, "seedream-") {
		return nil, apperror.New(apperror.CodeInvalidInput, "HopBase Seedream 不支持传统 mask；请把标注直接画在参考图上并在提示词中说明修改区域")
	}

	body := map[string]interface{}{
		"model":  req.Model,
		"prompt": req.Prompt,
		"n":      requestedImageCount(req),
	}
	if size := hopBaseImageSize(req); size != "" {
		body["size"] = size
	}

	switch {
	case strings.HasPrefix(model, "seedream-"):
		maxRefs := 14
		if model == "seedream-5-0-pro" {
			maxRefs = 10
		}
		if len(req.ReferenceImages) > maxRefs {
			return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("%s 最多支持 %d 张参考图", req.Model, maxRefs))
		}
		format := strings.ToLower(strings.TrimSpace(req.OutputFormat))
		if model == "seedream-4-5" {
			format = "jpeg"
		} else if format != "jpeg" {
			format = "png"
		}
		body["output_format"] = format
		body["response_format"] = "url"
		body["optimize_prompt_options"] = map[string]interface{}{"mode": "standard"}
		if len(req.ReferenceImages) > 0 {
			refs := make([]string, 0, len(req.ReferenceImages))
			for i, raw := range req.ReferenceImages {
				resolved, err := localPathToDataURL(raw)
				if err != nil {
					return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
				}
				refs = append(refs, resolved)
			}
			body["image"] = refs
		}
	case strings.Contains(model, "gpt-image"):
		body["quality"] = normalizeOpenAIImageQuality(req.Quality)
		body["background"] = "opaque"
		format := strings.ToLower(strings.TrimSpace(req.OutputFormat))
		if format == "" {
			format = "png"
		}
		body["output_format"] = format
	// Gemini compatibility varies by model. HopBase documents model, prompt,
	// size and n as the portable subset, so avoid speculative GPT-only fields.
	case strings.Contains(model, "gemini"):
	default:
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("HopBase 图片模型 %q 尚未登记", req.Model))
	}

	for key, value := range req.Parameters {
		if value == nil {
			continue
		}
		switch key {
		case "quality", "background", "output_format", "response_format", "input_fidelity":
			body[key] = value
		}
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encode HopBase image request", err)
	}
	endpoint := resolveProviderURL(baseURL, "/images/generations")
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build HopBase image request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := doProviderSubmitOnce(ctx, newProviderHTTPClient(imageGenerationTimeout()), httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, providerRequestErrorMessage(err), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, readProviderError(resp)
	}
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read HopBase image response", err)
	}
	return parseImageGenerationResponse(respBody)
}

// seedreamSizeMap maps an explicit aspect ratio to the exact <w>x<h> pixels
// per official Volcengine Seedream resolution tier. Sending exact pixels
// (method 1) makes the requested ratio actually take effect; sending only a
// tier string like "2K" leaves the aspect ratio to the model's discretion,
// which is why picking 16:9 used to come back square.
var seedreamSizeMap = map[string]map[string]string{
	"1K": {
		"1:1":  "1024x1024",
		"4:3":  "1152x864",
		"3:4":  "864x1152",
		"16:9": "1312x736",
		"9:16": "736x1312",
		"3:2":  "1248x832",
		"2:3":  "832x1248",
		"21:9": "1568x672",
	},
	"2K": {
		"1:1":  "2048x2048",
		"4:3":  "2304x1728",
		"3:4":  "1728x2304",
		"16:9": "2848x1600",
		"9:16": "1600x2848",
		"3:2":  "2496x1664",
		"2:3":  "1664x2496",
		"21:9": "3136x1344",
	},
}

func seedreamSizeForRatio(tier, ratio string) (string, bool) {
	if m, ok := seedreamSizeMap[tier]; ok {
		if px, ok := m[ratio]; ok {
			return px, true
		}
	}
	return "", false
}

func hopBaseImageSize(req GenerateRequest) string {
	resolution := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(req.Resolution), " ", ""))
	model := strings.ToLower(strings.TrimSpace(req.Model))
	aspectRatio := strings.ToLower(strings.TrimSpace(req.Size))
	if strings.HasPrefix(model, "seedream-") {
		// Resolve tier. Seedream 5.0 Pro only supports 1K / 2K (1.5K is NOT a
		// valid tier for Pro and was silently ignored by the upstream, which
		// produced wrong/cropped images).
		tier := "1K"
		switch resolution {
		case "2K", "3K", "4K":
			tier = "2K"
		case "1.5K", "720P", "1K", "":
			tier = "1K"
		}
		// 5.0 Lite / 4.5 default to 2K when no explicit tier is chosen.
		if (model == "seedream-5-0-lite" || model == "seedream-4-5") &&
			(resolution == "" || resolution == "720P" || resolution == "1K" || resolution == "1.5K") {
			tier = "2K"
		}
		// If the user picked an explicit aspect ratio, map it to exact pixels
		// for the chosen tier so the ratio actually takes effect.
		if aspectRatio != "" && aspectRatio != "auto" && aspectRatio != "1x1" {
			if px, ok := seedreamSizeForRatio(tier, aspectRatio); ok {
				return px
			}
		}
		// No explicit ratio — send the tier string and let the model decide.
		return tier
	}
	if size := mapAspectRatioToOpenAIImageSize(req.Size); size != "" {
		return size
	}
	return "auto"
}
