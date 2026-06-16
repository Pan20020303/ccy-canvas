package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

type ProviderPluginIcon struct {
	Key string `json:"key,omitempty"`
	URL string `json:"url,omitempty"`
}

type ProviderPluginPreview struct {
	ID              string             `json:"id,omitempty"`
	ServiceType     string             `json:"service_type"`
	Vendor          string             `json:"vendor"`
	Name            string             `json:"name"`
	APISpec         string             `json:"api_spec"`
	Protocol        string             `json:"protocol"`
	BaseURL         string             `json:"base_url"`
	SubmitEndpoint  string             `json:"submit_endpoint,omitempty"`
	QueryEndpoint   string             `json:"query_endpoint,omitempty"`
	ModelList       []string           `json:"model_list"`
	DefaultModel    string             `json:"default_model,omitempty"`
	Capabilities    []string           `json:"capabilities,omitempty"`
	ParameterSchema json.RawMessage    `json:"parameter_schema,omitempty"`
	Icon            ProviderPluginIcon `json:"icon,omitempty"`
}

type tsRunnerRequest struct {
	Operation string         `json:"operation"`
	Code      string         `json:"code"`
	Function  string         `json:"function,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Context   map[string]any `json:"context,omitempty"`
	TimeoutMS int            `json:"timeout_ms,omitempty"`
}

type tsRunnerResponse struct {
	OK     bool                  `json:"ok"`
	Vendor ProviderPluginPreview `json:"vendor,omitempty"`
	Result GenerateResult        `json:"result,omitempty"`
	Error  string                `json:"error,omitempty"`
}

// PreviewProviderPlugin parses a self-contained TS provider adapter and returns
// the vendor metadata that can be applied to an admin provider config form.
func (s *Service) PreviewProviderPlugin(ctx context.Context, code string) (*ProviderPluginPreview, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "TS provider code is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := s.callTSProviderRunner(ctx, tsRunnerRequest{
		Operation: "inspect",
		Code:      code,
		TimeoutMS: 5000,
	})
	if err != nil {
		return nil, err
	}
	preview := resp.Vendor
	normalizeProviderPluginPreview(&preview)
	if preview.ServiceType == "" || preview.Name == "" || len(preview.ModelList) == 0 {
		return nil, apperror.New(apperror.CodeInvalidInput, "TS provider must export vendor.serviceType, vendor.name, and at least one model")
	}
	return &preview, nil
}

func normalizeProviderPluginPreview(p *ProviderPluginPreview) {
	p.ServiceType = strings.ToLower(strings.TrimSpace(p.ServiceType))
	p.Vendor = strings.TrimSpace(p.Vendor)
	p.Name = strings.TrimSpace(p.Name)
	p.APISpec = strings.TrimSpace(p.APISpec)
	if p.APISpec == "" {
		p.APISpec = "custom"
	}
	p.Protocol = strings.TrimSpace(p.Protocol)
	if p.Protocol == "" {
		p.Protocol = "openai_compatible"
	}
	p.BaseURL = strings.TrimSpace(p.BaseURL)
	p.SubmitEndpoint = strings.TrimSpace(p.SubmitEndpoint)
	p.QueryEndpoint = strings.TrimSpace(p.QueryEndpoint)
	p.ModelList = compactStringList(p.ModelList)
	p.DefaultModel = strings.TrimSpace(p.DefaultModel)
	if p.DefaultModel == "" && len(p.ModelList) > 0 {
		p.DefaultModel = p.ModelList[0]
	}
	if len(p.Capabilities) == 0 && p.ServiceType != "" {
		p.Capabilities = []string{p.ServiceType}
	}
	if len(p.ParameterSchema) == 0 {
		p.ParameterSchema = json.RawMessage("{}")
	}
	p.Icon.Key = sanitizeProviderIconKey(p.Icon.Key)
	p.Icon.URL = sanitizeProviderIconURL(p.Icon.URL)
}

func compactStringList(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func (s *Service) runTSProvider(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if strings.TrimSpace(pc.AdapterCode) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "TS provider adapter code is empty")
	}
	functionName, err := providerPluginFunctionForService(pc.ServiceType)
	if err != nil {
		return nil, apperror.New(apperror.CodeInvalidInput, "Unsupported TS provider service type: "+pc.ServiceType)
	}
	resp, err := s.callTSProviderRunner(ctx, tsRunnerRequest{
		Operation: "run",
		Code:      pc.AdapterCode,
		Function:  functionName,
		Input:     generateRequestPayload(req),
		Context: map[string]any{
			"apiKey":         apiKey,
			"baseURL":        baseURL,
			"providerID":     pc.ID,
			"providerName":   pc.Name,
			"vendor":         pc.Vendor,
			"serviceType":    pc.ServiceType,
			"model":          req.Model,
			"submitEndpoint": pc.SubmitEndpoint,
			"queryEndpoint":  pc.QueryEndpoint,
		},
	})
	if err != nil {
		return nil, err
	}
	if resp.Result.Type == "" {
		return nil, apperror.New(apperror.CodeInternal, "TS provider returned empty result type")
	}
	if resp.Result.Content == "" {
		return nil, apperror.New(apperror.CodeInternal, "TS provider returned empty result content")
	}
	return &resp.Result, nil
}

func generateRequestPayload(req GenerateRequest) map[string]any {
	return map[string]any{
		"service_type":        req.ServiceType,
		"provider_config_id":  req.ProviderConfigID,
		"model":               req.Model,
		"prompt":              req.Prompt,
		"size":                req.Size,
		"resolution":          req.Resolution,
		"quality":             req.Quality,
		"edit_operation":      req.EditOperation,
		"mask_image":          req.MaskImage,
		"output_count":        req.OutputCount,
		"expand_direction":    req.ExpandDirection,
		"derive_from_node_id": req.DeriveFromNodeID,
		"trim_range":          req.TrimRange,
		"crop_rect":           req.CropRect,
		"target_tracks":       req.TargetTracks,
		"output_format":       req.OutputFormat,
		"parameters":          req.Parameters,
		"duration":            req.Duration,
		"aspect_ratio":        req.AspectRatio,
		"reference_images":    req.ReferenceImages,
		"reference_video":     req.ReferenceVideo,
		"reference_videos":    req.ReferenceVideos,
		"reference_mode":      req.ReferenceMode,
		"generation_log_id":   req.GenerationLogID,
		"user_id":             req.UserID,
		"node_id":             req.NodeID,
		"request_id":          req.RequestID,
	}
}

func (s *Service) callTSProviderRunner(ctx context.Context, payload tsRunnerRequest) (*tsRunnerResponse, error) {
	script, err := resolveTSProviderRunnerScript()
	if err != nil {
		return nil, err
	}
	nodeBin := strings.TrimSpace(os.Getenv("PROVIDER_TS_RUNNER_NODE"))
	if nodeBin == "" {
		nodeBin = "node"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encode TS provider request", err)
	}
	cmd := exec.CommandContext(ctx, nodeBin, script)
	cmd.Dir = filepath.Dir(script)
	cmd.Stdin = bytes.NewReader(body)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, apperror.New(apperror.CodeInternal, "TS provider runner failed: "+msg)
	}
	var resp tsRunnerResponse
	if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to decode TS provider runner response", err)
	}
	if !resp.OK {
		if strings.TrimSpace(resp.Error) == "" {
			resp.Error = "TS provider runner returned an unknown error"
		}
		return nil, apperror.New(apperror.CodeInternal, resp.Error)
	}
	return &resp, nil
}

func resolveTSProviderRunnerScript() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("PROVIDER_TS_RUNNER_PATH")); configured != "" {
		if _, err := os.Stat(configured); err == nil {
			return configured, nil
		}
		return "", apperror.New(apperror.CodeInternal, "PROVIDER_TS_RUNNER_PATH does not exist: "+configured)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, "Failed to resolve working directory", err)
	}
	for {
		candidates := []string{
			filepath.Join(cwd, "backend", "scripts", "provider_ts_runner.mjs"),
			filepath.Join(cwd, "scripts", "provider_ts_runner.mjs"),
		}
		for _, candidate := range candidates {
			if _, err := os.Stat(candidate); err == nil {
				return candidate, nil
			}
		}
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	return "", apperror.New(apperror.CodeInternal, "TS provider runner script not found")
}

func isTSProvider(pc *domain.ProviderConfig) bool {
	return pc != nil && strings.EqualFold(strings.TrimSpace(pc.AdapterRuntime), "ts")
}

func providerPluginFunctionForService(serviceType string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(serviceType)) {
	case "text", "image", "video", "audio":
		return strings.ToLower(strings.TrimSpace(serviceType)) + "Request", nil
	default:
		return "", errors.New("unsupported service type")
	}
}
