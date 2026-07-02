package application

import (
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"encoding/json"
	"fmt"
	"strings"
)

type providerParameterSchema struct {
	AllowedParameters []string                           `json:"allowed_parameters"`
	Defaults          map[string]interface{}             `json:"defaults"`
	Models            map[string]providerParameterSchema `json:"models"`
	ParameterAliases  map[string]string                  `json:"parameter_aliases"`
	ModelRoutes       []providerModelRoute               `json:"model_routes"`
	RequestFormat     string                             `json:"request_format"`
	ReferenceFormat   string                             `json:"reference_request_format"`
	QualityOptions    []string                           `json:"quality_options"`
	// CreditCost is the per-call price in credits for this provider config
	// (or per-model when set inside Models). Resolved by resolveCreditCost.
	// nil → fall back to the config-level value, then the global default.
	CreditCost *int32 `json:"credit_cost,omitempty"`
}

type providerModelRoute struct {
	Match map[string]interface{} `json:"match"`
	Model string                 `json:"model"`
}

func inferImageParameterSchema(modelName string) providerParameterSchema {
	model := strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.Contains(model, "gpt-image"):
		return providerParameterSchema{
			AllowedParameters: []string{"model", "prompt", "n", "size", "quality", "background", "output_format", "moderation"},
			Defaults: map[string]interface{}{
				"background":    "auto",
				"output_format": "png",
			},
		}
	case strings.Contains(model, "dall-e-3"):
		return providerParameterSchema{
			AllowedParameters: []string{"model", "prompt", "n", "size", "quality", "response_format"},
			Defaults: map[string]interface{}{
				"quality": "standard",
			},
		}
	case strings.Contains(model, "dall-e-2"):
		return providerParameterSchema{
			AllowedParameters: []string{"model", "prompt", "n", "size", "response_format"},
		}
	default:
		return providerParameterSchema{}
	}
}

func providerImageParameterSchema(pc *domain.ProviderConfig, modelName string) providerParameterSchema {
	fallback := inferImageParameterSchema(modelName)
	if pc == nil || len(pc.ParameterSchema) == 0 || string(pc.ParameterSchema) == "{}" {
		return fallback
	}
	var parsed providerParameterSchema
	if err := json.Unmarshal(pc.ParameterSchema, &parsed); err != nil {
		return fallback
	}
	if len(parsed.Models) > 0 {
		if modelSchema, ok := parsed.Models[modelName]; ok {
			parsed = modelSchema
		} else {
			lowerModel := strings.ToLower(strings.TrimSpace(modelName))
			for key, modelSchema := range parsed.Models {
				if strings.ToLower(strings.TrimSpace(key)) == lowerModel {
					parsed = modelSchema
					break
				}
			}
		}
	}
	if len(parsed.AllowedParameters) == 0 {
		parsed.AllowedParameters = fallback.AllowedParameters
	}
	if parsed.Defaults == nil {
		parsed.Defaults = fallback.Defaults
	}
	return parsed
}

func isChatCompletionsImageSchema(schema providerParameterSchema) bool {
	switch strings.ToLower(strings.TrimSpace(schema.RequestFormat)) {
	case "chat_completions_image", "chat-image", "multimodal_chat_image":
		return true
	default:
		return false
	}
}

func isChatCompletionsReferenceImageSchema(schema providerParameterSchema) bool {
	switch strings.ToLower(strings.TrimSpace(schema.ReferenceFormat)) {
	case "chat_completions_image", "chat-image", "multimodal_chat_image":
		return true
	default:
		return false
	}
}

func allowedParamSet(names []string) map[string]bool {
	if len(names) == 0 {
		return nil
	}
	set := make(map[string]bool, len(names))
	for _, name := range names {
		key := strings.TrimSpace(name)
		if key != "" {
			set[key] = true
		}
	}
	return set
}

func allowParams(allowed map[string]bool, names ...string) map[string]bool {
	if allowed == nil {
		return nil
	}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name != "" {
			allowed[name] = true
		}
	}
	return allowed
}

func mergeAllowedParameters(body map[string]interface{}, allowed map[string]bool, params map[string]any) {
	for key, value := range params {
		if key == "" || value == nil {
			continue
		}
		if allowed != nil && !allowed[key] {
			continue
		}
		body[key] = value
	}
}

func setAllowedParameter(body map[string]interface{}, allowed map[string]bool, key string, value interface{}) {
	key = strings.TrimSpace(key)
	if key == "" || value == nil {
		return
	}
	if text, ok := value.(string); ok {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		value = text
	}
	if allowed != nil && !allowed[key] {
		return
	}
	body[key] = value
}

func imageResolutionForProvider(req GenerateRequest) string {
	res := strings.ToUpper(strings.TrimSpace(req.Resolution))
	if res == "" || res == "720P" {
		switch normalizeOpenAIImageQuality(req.Quality) {
		case "high":
			return "4K"
		case "medium":
			return "2K"
		case "low":
			return "1K"
		default:
			return ""
		}
	}
	res = strings.ReplaceAll(res, " ", "")
	switch res {
	case "1K", "2K", "4K":
		return res
	default:
		return strings.ToUpper(strings.TrimSpace(req.Resolution))
	}
}

func normalizeProviderImageQuality(quality string, schema providerParameterSchema) string {
	q := normalizeOpenAIImageQuality(quality)
	if len(schema.QualityOptions) == 0 {
		return q
	}
	options := make([]string, 0, len(schema.QualityOptions))
	for _, option := range schema.QualityOptions {
		option = strings.TrimSpace(option)
		if option != "" {
			options = append(options, option)
		}
	}
	if len(options) == 0 {
		return q
	}
	for _, option := range options {
		if strings.EqualFold(option, q) {
			return option
		}
	}
	if q == "auto" {
		if defaultQuality, ok := schema.Defaults["quality"].(string); ok {
			for _, option := range options {
				if strings.EqualFold(option, strings.TrimSpace(defaultQuality)) {
					return option
				}
			}
		}
		return options[0]
	}
	matchers := map[string][]string{
		"high":   {"high", "ultra", "4k"},
		"medium": {"medium", "hd", "2k"},
		"low":    {"low", "standard", "1k"},
	}
	for _, token := range matchers[q] {
		for _, option := range options {
			if strings.Contains(strings.ToLower(option), token) {
				return option
			}
		}
	}
	return options[0]
}

func applyImageParameterAliases(body map[string]interface{}, allowed map[string]bool, schema providerParameterSchema, req GenerateRequest) {
	aliases := schema.ParameterAliases
	if len(aliases) == 0 {
		return
	}
	if target := aliases["size"]; target != "" {
		setAllowedParameter(body, allowed, target, mapAspectRatioToOpenAIImageSize(req.Size))
	}
	if target := aliases["aspect_ratio"]; target != "" {
		ratio := strings.TrimSpace(req.Size)
		if ratio == "" || strings.EqualFold(ratio, "auto") {
			ratio = "1:1"
		}
		setAllowedParameter(body, allowed, target, ratio)
	}
	if target := aliases["resolution"]; target != "" {
		setAllowedParameter(body, allowed, target, imageResolutionForProvider(req))
	}
	if target := aliases["quality"]; target != "" {
		setAllowedParameter(body, allowed, target, normalizeProviderImageQuality(req.Quality, schema))
	}
}

// applyGeminiProImageResolution hardwires the REQUIRED output_resolution field
// for the gemini-3.0-pro-image family (Nano Pro 高清). The vendor exposes the
// family as two model ids — "gemini-3.0-pro-image" (2K) and
// "gemini-3.0-pro-image 4K" — and both require output_resolution in the body.
// The UI stores the BASE model name plus a resolution param (2k/4k), so this
// maps resolution → output_resolution and appends the " 4K" model suffix,
// without depending on the provider row carrying a parameter schema (mirrors
// the wan2.7 model-name routing precedent). A model that already carries the
// " 4K" suffix wins over the resolution param, so legacy nodes keep working.
func applyGeminiProImageResolution(body map[string]interface{}, allowed map[string]bool, req GenerateRequest) {
	model := strings.TrimSpace(req.Model)
	if !strings.HasPrefix(strings.ToLower(model), "gemini-3.0-pro-image") {
		return
	}
	res := "2K"
	requested := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(req.Resolution), " ", ""))
	if strings.HasSuffix(strings.ToUpper(model), " 4K") || requested == "4K" {
		res = "4K"
	}
	allowParams(allowed, "output_resolution")
	body["output_resolution"] = res
	if res == "4K" && !strings.HasSuffix(strings.ToUpper(model), " 4K") {
		body["model"] = model + " 4K"
	}
}

func applyProviderModelRoutes(body map[string]interface{}, schema providerParameterSchema) {
	if len(schema.ModelRoutes) == 0 {
		return
	}
	for _, route := range schema.ModelRoutes {
		if strings.TrimSpace(route.Model) == "" || len(route.Match) == 0 {
			continue
		}
		matched := true
		for key, want := range route.Match {
			got, ok := body[key]
			if !ok {
				matched = false
				break
			}
			if !strings.EqualFold(fmt.Sprint(got), fmt.Sprint(want)) {
				matched = false
				break
			}
		}
		if matched {
			body["model"] = route.Model
			return
		}
	}
}

func pruneUnsupportedParameters(body map[string]interface{}, allowed map[string]bool) {
	if allowed == nil {
		return
	}
	for key := range body {
		if !allowed[key] {
			delete(body, key)
		}
	}
}
