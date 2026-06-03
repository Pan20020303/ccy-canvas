// Package application contains model catalog use-case services.
package application

// parseProviderError converts an upstream non-2xx HTTP response into a
// human-readable error. It tries:
//   1. OpenAI-style `{"error":{"message,type,code,param}}`
//   2. Anthropic / generic `{"error":{"message,type}}` (same shape)
//   3. Plain text body
// HTTP status is always included so the operator can tell 401 from 429 from 500.
// Body is read once with a sane size cap; the response should already be Close'd
// by the caller's defer.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/shared/apperror"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Repository is the persistence port for the model catalog.
type Repository interface {
	// Provider (legacy single-provider)
	GetRelayProvider(ctx context.Context) (*domain.RelayProvider, error)
	CreateRelayProvider(ctx context.Context, name, providerType, baseURL, encryptedKey string) (*domain.RelayProvider, error)
	UpdateRelayProvider(ctx context.Context, id, baseURL, encryptedKey string) (*domain.RelayProvider, error)
	SetRelayProviderLastSync(ctx context.Context, id string) error

	// Models (legacy)
	ListModelDefinitions(ctx context.Context) ([]domain.ModelDefinition, error)
	ListEnabledModelDefinitions(ctx context.Context, userID, role string) ([]domain.ModelDefinition, error)
	GetModelDefinitionByID(ctx context.Context, id string) (*domain.ModelDefinition, error)
	InsertModelDefinitionIfNotExists(ctx context.Context, providerID, externalName, displayName, capability string) (*domain.ModelDefinition, error)
	UpdateModelDefinition(ctx context.Context, id, displayName, capability string, paramSchema, defaultParams, pricingRule json.RawMessage, sortOrder int32) (*domain.ModelDefinition, error)
	SetModelStatus(ctx context.Context, id, status string) (*domain.ModelDefinition, error)

	// ProviderConfig (multi-vendor)
	ListProviderConfigs(ctx context.Context) ([]domain.ProviderConfig, error)
	GetProviderConfigByID(ctx context.Context, id string) (*domain.ProviderConfig, error)
	CreateProviderConfig(ctx context.Context, pc domain.ProviderConfig) (*domain.ProviderConfig, error)
	UpdateProviderConfig(ctx context.Context, pc domain.ProviderConfig) (*domain.ProviderConfig, error)
	DeleteProviderConfig(ctx context.Context, id string) error
	ListEnabledProviderConfigs(ctx context.Context) ([]domain.AppProviderConfig, error)
}

// Service provides model catalog use cases.
type Service struct {
	repo          Repository
	encryptionKey []byte
}

// NewService creates a new model catalog Service.
func NewService(repo Repository, encryptionKey []byte) *Service {
	return &Service{repo: repo, encryptionKey: encryptionKey}
}

// GetProviderStatus returns the demasked relay provider status.
func (s *Service) GetProviderStatus(ctx context.Context) (domain.ProviderStatus, error) {
	provider, err := s.repo.GetRelayProvider(ctx)
	if err != nil {
		return domain.ProviderStatus{HasProvider: false}, nil //nolint:nilerr
	}
	if provider == nil {
		return domain.ProviderStatus{HasProvider: false}, nil
	}
	hint := ""
	apiKeySet := provider.EncryptedAPIKey != ""
	if apiKeySet && len(provider.EncryptedAPIKey) >= 4 {
		hint = "****" + provider.EncryptedAPIKey[len(provider.EncryptedAPIKey)-4:]
	}
	return domain.ProviderStatus{
		HasProvider: true,
		BaseURL:     provider.BaseURL,
		APIKeySet:   apiKeySet,
		APIKeyHint:  hint,
		Status:      provider.Status,
		LastSyncAt:  provider.LastSyncAt,
	}, nil
}

// ConfigureProvider creates or updates the relay provider configuration.
// If apiKey is non-empty it is encrypted and stored; otherwise the existing key is preserved.
func (s *Service) ConfigureProvider(ctx context.Context, baseURL, apiKey string) (domain.ProviderStatus, error) {
	existing, err := s.repo.GetRelayProvider(ctx)

	var encryptedKey string
	if apiKey != "" {
		encryptedKey, err = crypto.Encrypt(s.encryptionKey, apiKey)
		if err != nil {
			return domain.ProviderStatus{}, apperror.Wrap(apperror.CodeInternal, "Failed to encrypt API key", err)
		}
	}

	var provider *domain.RelayProvider
	if existing == nil {
		// First-time setup.
		provider, err = s.repo.CreateRelayProvider(ctx, "default", "newapi_openai_compatible", baseURL, encryptedKey)
	} else {
		// Preserve existing key when none supplied.
		if encryptedKey == "" {
			encryptedKey = existing.EncryptedAPIKey
		}
		provider, err = s.repo.UpdateRelayProvider(ctx, existing.ID, baseURL, encryptedKey)
	}
	if err != nil {
		return domain.ProviderStatus{}, apperror.Wrap(apperror.CodeInternal, "Failed to save provider config", err)
	}

	hint := ""
	apiKeySet := provider.EncryptedAPIKey != ""
	if apiKeySet && len(provider.EncryptedAPIKey) >= 4 {
		hint = "****" + provider.EncryptedAPIKey[len(provider.EncryptedAPIKey)-4:]
	}
	return domain.ProviderStatus{
		HasProvider: true,
		BaseURL:     provider.BaseURL,
		APIKeySet:   apiKeySet,
		APIKeyHint:  hint,
		Status:      provider.Status,
		LastSyncAt:  provider.LastSyncAt,
	}, nil
}

// TestProviderConnection decrypts the stored API key and sends a lightweight
// request to the provider's /v1/models endpoint to verify connectivity.
func (s *Service) TestProviderConnection(ctx context.Context) error {
	provider, err := s.repo.GetRelayProvider(ctx)
	if err != nil || provider == nil {
		return apperror.New(apperror.CodeInvalidInput, "Provider not configured")
	}
	if provider.BaseURL == "" {
		return apperror.New(apperror.CodeInvalidInput, "Provider base URL is not set")
	}
	if provider.EncryptedAPIKey == "" {
		return apperror.New(apperror.CodeInvalidInput, "Provider API key is not set")
	}

	apiKey, err := crypto.Decrypt(s.encryptionKey, provider.EncryptedAPIKey)
	if err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Failed to decrypt API key", err)
	}

	return testProviderConnection(ctx, provider.BaseURL, apiKey, 10*time.Second)
}

// TestProviderConnectionWithConfig tests unsaved form values so admins can
// validate a provider before committing it to encrypted storage.
func (s *Service) TestProviderConnectionWithConfig(ctx context.Context, baseURL, apiKey string) error {
	if strings.TrimSpace(baseURL) == "" {
		provider, err := s.repo.GetRelayProvider(ctx)
		if err != nil || provider == nil || provider.BaseURL == "" {
			return apperror.New(apperror.CodeInvalidInput, "Provider base URL is not set")
		}
		baseURL = provider.BaseURL
	}
	if strings.TrimSpace(apiKey) == "" {
		provider, err := s.repo.GetRelayProvider(ctx)
		if err != nil || provider == nil || provider.EncryptedAPIKey == "" {
			return apperror.New(apperror.CodeInvalidInput, "Provider API key is not set")
		}
		apiKey, err = crypto.Decrypt(s.encryptionKey, provider.EncryptedAPIKey)
		if err != nil {
			return apperror.Wrap(apperror.CodeInternal, "Failed to decrypt API key", err)
		}
	}
	return testProviderConnection(ctx, baseURL, apiKey, 10*time.Second)
}

func testProviderConnection(ctx context.Context, rawBaseURL, apiKey string, timeout time.Duration) error {
	baseURL := strings.TrimRight(strings.TrimSpace(rawBaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Failed to build test request", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Connection failed: %v", err), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider returned HTTP %d", resp.StatusCode))
	}
	return nil
}

// SyncModels fetches the provider's model list and inserts new entries as drafts.
func (s *Service) SyncModels(ctx context.Context) (int, error) {
	provider, err := s.repo.GetRelayProvider(ctx)
	if err != nil || provider == nil {
		return 0, apperror.New(apperror.CodeInvalidInput, "Provider not configured")
	}
	if provider.EncryptedAPIKey == "" {
		return 0, apperror.New(apperror.CodeInvalidInput, "Provider API key is not set")
	}

	apiKey, err := crypto.Decrypt(s.encryptionKey, provider.EncryptedAPIKey)
	if err != nil {
		return 0, apperror.Wrap(apperror.CodeInternal, "Failed to decrypt API key", err)
	}

	baseURL := strings.TrimRight(provider.BaseURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return 0, apperror.Wrap(apperror.CodeInternal, "Failed to build sync request", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Sync request failed: %v", err), err)
	}
	defer resp.Body.Close()

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, apperror.Wrap(apperror.CodeInternal, "Failed to parse provider model list", err)
	}

	inserted := 0
	for _, m := range result.Data {
		if m.ID == "" {
			continue
		}
		insertedModel, err := s.repo.InsertModelDefinitionIfNotExists(
			ctx, provider.ID, m.ID, m.ID, string(domain.CapabilityText),
		)
		if err != nil {
			continue // skip errors on individual models, best-effort sync
		}
		if insertedModel != nil {
			inserted++
		}
	}

	if err := s.repo.SetRelayProviderLastSync(ctx, provider.ID); err != nil {
		return inserted, apperror.Wrap(apperror.CodeInternal, "Failed to update sync timestamp", err)
	}
	return inserted, nil
}

// GetModelDefinitionByID returns a single model definition by ID, or nil if not found.
func (s *Service) GetModelDefinitionByID(ctx context.Context, id string) (*domain.ModelDefinition, error) {
	model, err := s.repo.GetModelDefinitionByID(ctx, id)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to get model", err)
	}
	if model == nil {
		return nil, apperror.New(apperror.CodeInvalidInput, "Model not found")
	}
	return model, nil
}

// ListAdminModels returns all model definitions for admin management.
func (s *Service) ListAdminModels(ctx context.Context) ([]domain.ModelDefinition, error) {
	models, err := s.repo.ListModelDefinitions(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list models", err)
	}
	return models, nil
}

// ListUserModels returns only enabled, priced models that the given user is permitted to use.
func (s *Service) ListUserModels(ctx context.Context, userID, role string) ([]domain.UserModel, error) {
	models, err := s.repo.ListEnabledModelDefinitions(ctx, userID, role)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list models", err)
	}
	result := make([]domain.UserModel, 0, len(models))
	for _, m := range models {
		if !m.HasPricing() {
			continue
		}
		result = append(result, domain.UserModel{
			ID:                m.ID,
			ExternalModelName: m.ExternalModelName,
			DisplayName:       m.DisplayName,
			Capability:        m.Capability,
			ParameterSchema:   m.ParameterSchema,
			DefaultParameters: m.DefaultParameters,
		})
	}
	return result, nil
}

// UpdateModelDefinition updates editable fields of a model definition.
func (s *Service) UpdateModelDefinition(ctx context.Context, id, displayName, capability string,
	paramSchema, defaultParams, pricingRule json.RawMessage, sortOrder int32) (*domain.ModelDefinition, error) {

	model, err := s.repo.UpdateModelDefinition(ctx, id, displayName, capability, paramSchema, defaultParams, pricingRule, sortOrder)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update model", err)
	}
	return model, nil
}

// EnableModel transitions a model to enabled status.
func (s *Service) EnableModel(ctx context.Context, id string) (*domain.ModelDefinition, error) {
	existing, err := s.GetModelDefinitionByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if !existing.HasPricing() {
		return nil, apperror.New(apperror.CodeInvalidInput, "Model pricing rule is required before enabling")
	}
	model, err := s.repo.SetModelStatus(ctx, id, string(domain.StatusEnabled))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to enable model", err)
	}
	return model, nil
}

// DisableModel transitions a model to disabled status.
func (s *Service) DisableModel(ctx context.Context, id string) (*domain.ModelDefinition, error) {
	model, err := s.repo.SetModelStatus(ctx, id, string(domain.StatusDisabled))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to disable model", err)
	}
	return model, nil
}

// ─── ProviderConfig (multi-vendor) ──────────────────────────────────────────

// ListProviderConfigs returns all provider configs for admin.
func (s *Service) ListProviderConfigs(ctx context.Context) ([]domain.ProviderConfig, error) {
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list provider configs", err)
	}
	return configs, nil
}

// CreateProviderConfig creates a new provider config entry.
// The API key is encrypted before storage.
func (s *Service) CreateProviderConfig(ctx context.Context, pc domain.ProviderConfig, rawAPIKey string) (*domain.ProviderConfig, error) {
	if rawAPIKey != "" {
		enc, err := crypto.Encrypt(s.encryptionKey, rawAPIKey)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encrypt API key", err)
		}
		pc.EncryptedAPIKey = enc
	}
	if pc.Status == "" {
		pc.Status = "enabled"
	}
	if pc.APISpec == "" {
		pc.APISpec = "openai"
	}
	result, err := s.repo.CreateProviderConfig(ctx, pc)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to create provider config", err)
	}
	return result, nil
}

// UpdateProviderConfig updates an existing provider config.
// If rawAPIKey is empty, the existing encrypted key is preserved.
func (s *Service) UpdateProviderConfig(ctx context.Context, pc domain.ProviderConfig, rawAPIKey string) (*domain.ProviderConfig, error) {
	existing, err := s.repo.GetProviderConfigByID(ctx, pc.ID)
	if err != nil || existing == nil {
		return nil, apperror.New(apperror.CodeInvalidInput, "Provider config not found")
	}
	if rawAPIKey != "" {
		enc, encErr := crypto.Encrypt(s.encryptionKey, rawAPIKey)
		if encErr != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to encrypt API key", encErr)
		}
		pc.EncryptedAPIKey = enc
	} else {
		pc.EncryptedAPIKey = existing.EncryptedAPIKey
	}
	result, err := s.repo.UpdateProviderConfig(ctx, pc)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update provider config", err)
	}
	return result, nil
}

// DeleteProviderConfig removes a provider config by ID.
func (s *Service) DeleteProviderConfig(ctx context.Context, id string) error {
	existing, err := s.repo.GetProviderConfigByID(ctx, id)
	if err != nil || existing == nil {
		return apperror.New(apperror.CodeInvalidInput, "Provider config not found")
	}
	if err := s.repo.DeleteProviderConfig(ctx, id); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Failed to delete provider config", err)
	}
	return nil
}

// ToggleProviderConfigStatus toggles the status of a provider config.
func (s *Service) ToggleProviderConfigStatus(ctx context.Context, id string) (*domain.ProviderConfig, error) {
	existing, err := s.repo.GetProviderConfigByID(ctx, id)
	if err != nil || existing == nil {
		return nil, apperror.New(apperror.CodeInvalidInput, "Provider config not found")
	}
	if existing.Status == "enabled" {
		existing.Status = "disabled"
	} else {
		existing.Status = "enabled"
	}
	result, err := s.repo.UpdateProviderConfig(ctx, *existing)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to toggle status", err)
	}
	return result, nil
}

// ListAppProviderConfigs returns enabled provider configs for regular users.
func (s *Service) ListAppProviderConfigs(ctx context.Context) ([]domain.AppProviderConfig, error) {
	configs, err := s.repo.ListEnabledProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list provider configs", err)
	}
	return configs, nil
}

// ─── Generation ─────────────────────────────────────────────────────────────

// GenerateRequest carries the user's generation request.
type GenerateRequest struct {
	ServiceType     string // image / text / video / audio
	Model           string // e.g. "gpt-image-2"
	Prompt          string
	Size            string // ratio like "1:1", "16:9", "auto"
	Resolution      string // image: "1k"/"2k"/"4k"; video: "480p"/"720p"
	Quality         string // image quality: auto / high / medium / low
	Duration        int    // video duration in seconds
	AspectRatio     string // video aspect ratio: "16:9", "9:16", etc.
	ReferenceImages []string
	ReferenceVideo  string
	ReferenceVideos []string
	ReferenceMode   string // auto / start_frame / start_end / image_reference
}

// GenerateResult carries the generation result.
type GenerateResult struct {
	Type    string `json:"type"`    // "text" or "url"
	Content string `json:"content"` // text content or image URL
}

// Generate finds the matching provider config, decrypts the API key, and calls the vendor.
func (s *Service) Generate(ctx context.Context, req GenerateRequest) (*GenerateResult, error) {
	// Find matching enabled provider config that contains the requested model.
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list configs", err)
	}

	var matched *domain.ProviderConfig
	for _, c := range configs {
		if c.Status != "enabled" {
			continue
		}
		if req.ServiceType != "" && c.ServiceType != req.ServiceType {
			continue
		}
		for _, m := range c.ModelList {
			if m == req.Model {
				matched = &c
				break
			}
		}
		if matched != nil {
			break
		}
	}
	if matched == nil {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("No enabled provider found for model %q", req.Model))
	}
	if matched.EncryptedAPIKey == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Provider API key is not configured")
	}

	apiKey, err := crypto.Decrypt(s.encryptionKey, matched.EncryptedAPIKey)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to decrypt API key", err)
	}

	baseURL := strings.TrimRight(matched.BaseURL, "/")

	// Dispatch by service type.
	switch matched.ServiceType {
	case "image":
		return s.generateImage(ctx, baseURL, apiKey, req)
	case "text":
		return s.generateText(ctx, baseURL, apiKey, req)
	case "video":
		return s.generateVideo(ctx, baseURL, apiKey, req)
	default:
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("Generation not yet supported for service type %q", matched.ServiceType))
	}
}

func (s *Service) generateImage(ctx context.Context, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	// Image-to-image (ref + prompt) requires the multipart /images/edits endpoint —
	// the standard /images/generations is text-only and silently ignores reference
	// fields, which previously produced visually unrelated outputs.
	if len(req.ReferenceImages) > 0 {
		return s.generateImageEdit(ctx, baseURL, apiKey, req)
	}
	return s.generateImageTextOnly(ctx, baseURL, apiKey, req)
}

func (s *Service) generateImageTextOnly(ctx context.Context, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	size := mapAspectRatioToOpenAIImageSize(req.Size)
	quality := normalizeOpenAIImageQuality(req.Quality)

	body := map[string]interface{}{
		"model":         req.Model,
		"prompt":        req.Prompt,
		"n":             1,
		"size":          size,
		"quality":       quality,
		"background":    "auto",
		"output_format": "png",
	}
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/images/generations", strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, readProviderError(resp)
	}

	// Read full body for flexible parsing.
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read provider response", readErr)
	}

	// Parse response — supports both sync (standard OpenAI) and async (task-based) formats.
	if taskID := extractImageTaskID(respBody); taskID != "" {
		return s.pollImageTask(ctx, baseURL, apiKey, taskID)
	}

	return parseImageGenerationResponse(respBody)
}

// generateImageEdit calls /v1/images/edits with multipart/form-data so reference
// images actually influence the result. Used whenever the request has at least
// one reference image.
func (s *Service) generateImageEdit(ctx context.Context, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	// Decode and re-encode each reference image as JPEG, downscaled if needed,
	// using the same pipeline as the text-only flow so we send a sane payload.
	type refImage struct {
		name  string
		bytes []byte
	}
	refs := make([]refImage, 0, len(req.ReferenceImages))
	for i, raw := range req.ReferenceImages {
		dataURL, err := localPathToDataURL(raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to load reference image #%d", i+1), err)
		}
		// localPathToDataURL returns data: for /uploads/* paths; for http(s)/remote
		// URLs we fall back to fetching them ourselves so the upstream relay
		// doesn't need network access back to us.
		var b []byte
		if strings.HasPrefix(dataURL, "data:") {
			// data:image/jpeg;base64,XXXX
			if idx := strings.Index(dataURL, "base64,"); idx > 0 {
				decoded, derr := base64.StdEncoding.DecodeString(dataURL[idx+len("base64,"):])
				if derr != nil {
					return nil, apperror.Wrap(apperror.CodeInternal, "Failed to decode reference image", derr)
				}
				b = decoded
			}
		} else if strings.HasPrefix(dataURL, "http://") || strings.HasPrefix(dataURL, "https://") {
			fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			fr, ferr := http.NewRequestWithContext(fetchCtx, http.MethodGet, dataURL, nil)
			if ferr != nil {
				cancel()
				return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build fetch", ferr)
			}
			fetchResp, ferr := (&http.Client{Timeout: 30 * time.Second}).Do(fr)
			if ferr != nil {
				cancel()
				return nil, apperror.Wrap(apperror.CodeInternal, "Failed to fetch reference URL", ferr)
			}
			b, ferr = io.ReadAll(io.LimitReader(fetchResp.Body, 8*1024*1024))
			fetchResp.Body.Close()
			cancel()
			if ferr != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read reference", ferr)
			}
		}
		if len(b) == 0 {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Reference image #%d resolved to empty bytes", i+1))
		}
		refs = append(refs, refImage{name: fmt.Sprintf("ref-%d.jpg", i+1), bytes: b})
	}

	// Build multipart body.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, r := range refs {
		part, err := mw.CreateFormFile("image", r.name)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build multipart", err)
		}
		if _, err := part.Write(r.bytes); err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to write multipart image", err)
		}
	}
	_ = mw.WriteField("model", req.Model)
	_ = mw.WriteField("prompt", req.Prompt)
	_ = mw.WriteField("n", "1")
	if size := mapAspectRatioToOpenAIImageSize(req.Size); size != "" {
		_ = mw.WriteField("size", size)
	}
	_ = mw.WriteField("quality", normalizeOpenAIImageQuality(req.Quality))
	_ = mw.WriteField("background", "auto")
	_ = mw.WriteField("output_format", "png")
	_ = mw.Close()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/images/edits", &body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build edit request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())

	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, readProviderError(resp)
	}

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read provider response", readErr)
	}

	// Reuse the same flexible response parser as the text-only path.
	return parseImageGenerationResponse(respBody)
}

// mapAspectRatioToOpenAISize converts our internal aspect-ratio + resolution
// notation into a size string the OpenAI image edit endpoint accepts.
// Returns "" if the input doesn't look like an aspect ratio (the caller can
// then pass through whatever the relay supports).
func mapAspectRatioToOpenAIImageSize(size string) string {
	switch strings.ToLower(strings.TrimSpace(size)) {
	case "", "auto":
		return "auto"
	case "1:1":
		return "1024x1024"
	case "16:9", "4:3", "3:2", "5:4", "21:9", "2:1":
		return "1536x1024"
	case "9:16", "3:4", "2:3", "4:5", "1:2", "9:21":
		return "1024x1536"
	}
	// Already pixel-sized (e.g. "1024x1024") or vendor-specific — pass through.
	if strings.Contains(size, "x") {
		return size
	}
	return ""
}

func normalizeOpenAIImageQuality(quality string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "high", "medium", "low":
		return strings.ToLower(strings.TrimSpace(quality))
	default:
		return "auto"
	}
}

// parseImageGenerationResponse extracts a usable URL or b64_json from an
// OpenAI-style image response. Shared by text-only and edit code paths.
func parseImageGenerationResponse(respBody []byte) (*GenerateResult, error) {
	if taskID := extractImageTaskID(respBody); taskID != "" {
		return nil, apperror.New(apperror.CodeInternal, "Async task path not supported in edit mode yet; got task_id="+taskID)
	}

	var result struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil || len(result.Data) == 0 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unexpected provider response: %s", string(respBody[:min(len(respBody), 400)])))
	}
	if result.Data[0].URL != "" {
		return &GenerateResult{Type: "url", Content: result.Data[0].URL}, nil
	}
	if result.Data[0].B64JSON != "" {
		return &GenerateResult{Type: "url", Content: "data:image/png;base64," + result.Data[0].B64JSON}, nil
	}
	return nil, apperror.New(apperror.CodeInternal, "Provider returned an image entry with neither url nor b64_json")
}

func extractImageTaskID(respBody []byte) string {
	var taskCheck map[string]interface{}
	if err := json.Unmarshal(respBody, &taskCheck); err != nil {
		return ""
	}
	if id, ok := taskCheck["task_id"].(string); ok && id != "" {
		return id
	}
	return ""
}

// pollImageTask polls an async image generation task until it completes or times out.
func (s *Service) pollImageTask(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}

	// Try multiple URL patterns used by various providers.
	// apimart.ai uses GET /v1/tasks/{task_id}
	pollURLs := []string{
		baseURL + "/tasks/" + taskID,
		baseURL + "/images/generations/" + taskID,
		baseURL + "/async/tasks/" + taskID,
	}

	// Wait 10s before first poll per apimart docs, then every 5s.
	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(10 * time.Second):
	}

	for i := 0; i < 30; i++ { // max ~2.5 minutes after initial wait
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(5 * time.Second):
			}
		}

		var lastBody []byte
		for _, pollURL := range pollURLs {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
			if err != nil {
				continue
			}
			req.Header.Set("Authorization", "Bearer "+apiKey)

			resp, err := client.Do(req)
			if err != nil {
				continue
			}

			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			lastBody = body

			if resp.StatusCode == 404 || resp.StatusCode == 405 {
				continue // try next URL pattern
			}

			// Try to extract image from the response (flexible parsing).
			if result := s.tryExtractImageFromPollResponse(body); result != nil {
				return result, nil
			}

			// Check for explicit failure.
			var generic map[string]interface{}
			if json.Unmarshal(body, &generic) == nil {
				if data, ok := generic["data"].(map[string]interface{}); ok {
					if status, _ := data["status"].(string); status == "failed" || status == "error" {
						return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
					}
				}
			}

			break // got a valid response from this URL pattern, wait and retry
		}

		// On last attempt, return the raw response for debugging.
		if i == 59 && len(lastBody) > 0 {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Timed out. Last response: %s", string(lastBody[:min(len(lastBody), 800)])))
		}
	}

	return nil, apperror.New(apperror.CodeInternal, "Image generation timed out after polling")
}

// tryExtractImageFromPollResponse attempts to find an image URL in various response shapes.
func (s *Service) tryExtractImageFromPollResponse(body []byte) *GenerateResult {
	var generic map[string]interface{}
	if json.Unmarshal(body, &generic) != nil {
		return nil
	}

	// Check if status indicates completion — status can be at top level or under "data".
	status := ""
	if s2, ok := generic["status"].(string); ok {
		status = s2
	}
	if data, ok := generic["data"].(map[string]interface{}); ok {
		if s2, ok := data["status"].(string); ok {
			status = s2
		}
	}
	status = strings.ToLower(status)
	if status != "" && status != "completed" && status != "succeeded" && status != "success" {
		return nil // still in progress
	}

	// Search for image URL recursively — increase depth to 5 to handle nested result.images[0].url
	url := findStringField(generic, "url", 5)
	if url != "" && (strings.HasPrefix(url, "http") || strings.HasPrefix(url, "data:")) {
		return &GenerateResult{Type: "url", Content: url}
	}
	b64 := findStringField(generic, "b64_json", 5)
	if b64 != "" {
		return &GenerateResult{Type: "url", Content: "data:image/png;base64," + b64}
	}
	return nil
}

// findStringField recursively searches a map for a non-empty string field by key name, up to maxDepth.
// Handles cases where the value is a string OR a []string (takes first element).
func findStringField(obj interface{}, key string, maxDepth int) string {
	if maxDepth <= 0 {
		return ""
	}
	switch v := obj.(type) {
	case map[string]interface{}:
		if val, ok := v[key]; ok {
			switch tv := val.(type) {
			case string:
				if tv != "" {
					return tv
				}
			case []interface{}:
				// url might be ["https://..."] — take first string element.
				for _, item := range tv {
					if s, ok := item.(string); ok && s != "" {
						return s
					}
				}
			}
		}
		for _, val := range v {
			if found := findStringField(val, key, maxDepth-1); found != "" {
				return found
			}
		}
	case []interface{}:
		for _, item := range v {
			if found := findStringField(item, key, maxDepth-1); found != "" {
				return found
			}
		}
	}
	return ""
}

func (s *Service) generateText(ctx context.Context, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	body := map[string]interface{}{
		"model": req.Model,
		"messages": []map[string]string{
			{"role": "user", "content": req.Prompt},
		},
		"max_tokens": 2048,
	}
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Provider request failed: %v", err), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, readProviderError(resp)
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to parse provider response", err)
	}
	if len(result.Choices) == 0 {
		return nil, apperror.New(apperror.CodeInternal, "Provider returned no completions")
	}

	return &GenerateResult{Type: "text", Content: result.Choices[0].Message.Content}, nil
}

// ─── Video Generation (sora-style: POST /v1/videos → poll GET /v1/videos/{id}) ──

const maxRefImageDim = 1920
const maxRefImageBytes = 4 * 1024 * 1024 // 4 MB JPEG budget

// localPathToDataURL reads a local /uploads/... path, downscales if needed,
// re-encodes as JPEG, and returns a data:image/jpeg;base64,... string.
// Non-local paths (http/https or already data: URLs) are returned as-is.
func localPathToDataURL(rawURL string) (string, error) {
	if strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "data:") {
		return rawURL, nil
	}
	// Expect paths like "/uploads/2026-01/xxx.png".
	if !strings.HasPrefix(rawURL, "/uploads/") {
		return rawURL, nil
	}
	diskPath := filepath.Join("uploads", strings.TrimPrefix(rawURL, "/uploads/"))

	f, err := os.Open(diskPath)
	if err != nil {
		return "", fmt.Errorf("open reference file %s: %w", diskPath, err)
	}
	defer f.Close()

	src, _, err := image.Decode(f)
	if err != nil {
		return "", fmt.Errorf("decode reference image %s: %w", diskPath, err)
	}

	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w > maxRefImageDim || h > maxRefImageDim {
		ratio := float64(maxRefImageDim) / float64(max(w, h))
		nw, nh := int(float64(w)*ratio), int(float64(h)*ratio)
		dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
		draw.BiLinear.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
		src = dst
	}

	var buf bytes.Buffer
	quality := 85
	for quality >= 40 {
		buf.Reset()
		if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: quality}); err != nil {
			return "", fmt.Errorf("encode reference JPEG: %w", err)
		}
		if buf.Len() <= maxRefImageBytes {
			break
		}
		quality -= 10
	}

	encoded := base64.StdEncoding.EncodeToString(buf.Bytes())
	return "data:image/jpeg;base64," + encoded, nil
}

func (s *Service) generateVideo(ctx context.Context, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	aspectRatio := req.AspectRatio
	if aspectRatio == "" {
		aspectRatio = req.Size
	}
	if aspectRatio == "" {
		aspectRatio = "16:9"
	}
	resolution := req.Resolution
	if resolution == "" {
		resolution = "720p"
	}
	duration := req.Duration
	if duration <= 0 {
		duration = 5
	}

	body := map[string]interface{}{
		"model":        req.Model,
		"prompt":       req.Prompt,
		"aspect_ratio": aspectRatio,
		"resolution":   resolution,
		"duration":     duration,
	}
	if len(req.ReferenceImages) > 0 {
		resolved := make([]string, 0, len(req.ReferenceImages))
		for _, ref := range req.ReferenceImages {
			du, err := localPathToDataURL(ref)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image: %v", err), err)
			}
			resolved = append(resolved, du)
		}
		body["reference_images"] = resolved
		mode := req.ReferenceMode
		if mode == "" {
			mode = "auto"
		}
		body["reference_mode"] = mode
	}
	if req.ReferenceVideo != "" {
		body["reference_video"] = req.ReferenceVideo
	}
	if len(req.ReferenceVideos) > 0 {
		body["reference_videos"] = req.ReferenceVideos
	}
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/videos", strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
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

	// Parse task ID from response — format: { id: "..." } or { task_id: "..." }
	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse submit response: %s", string(respBody[:min(len(respBody), 300)])))
	}

	taskID := ""
	if id, ok := submitResp["id"].(string); ok && id != "" {
		taskID = id
	} else if id, ok := submitResp["task_id"].(string); ok && id != "" {
		taskID = id
	}
	if taskID == "" {
		// Maybe result is already inline (synchronous provider).
		if videoURL, ok := submitResp["video_url"].(string); ok && videoURL != "" {
			return &GenerateResult{Type: "url", Content: videoURL}, nil
		}
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoTask(ctx, baseURL, apiKey, taskID)
}

// pollVideoTask polls GET /v1/videos/{taskId} until completed or failed.
func (s *Service) pollVideoTask(ctx context.Context, baseURL, apiKey, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	pollURL := baseURL + "/videos/" + taskID

	// Wait 8 seconds before first poll.
	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(8 * time.Second):
	}

	for i := 0; i < 60; i++ { // max ~5 minutes
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(8 * time.Second):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, err := client.Do(req)
		if err != nil {
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var taskResp map[string]interface{}
		if json.Unmarshal(body, &taskResp) != nil {
			continue
		}

		status := strings.ToLower(fmt.Sprintf("%v", taskResp["status"]))

		if status == "failed" {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video generation failed. Raw: %s", string(body[:min(len(body), 500)])))
		}

		if status == "completed" {
			// video_url at top level
			if videoURL, ok := taskResp["video_url"].(string); ok && videoURL != "" {
				return &GenerateResult{Type: "url", Content: videoURL}, nil
			}
			// Search recursively
			url := findStringField(taskResp, "video_url", 5)
			if url != "" {
				return &GenerateResult{Type: "url", Content: url}, nil
			}
			url = findStringField(taskResp, "url", 5)
			if url != "" && strings.HasPrefix(url, "http") {
				return &GenerateResult{Type: "url", Content: url}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Video completed but no URL found. Raw: %s", string(body[:min(len(body), 800)])))
		}

		// Still processing — continue polling.
	}

	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// readProviderError converts an upstream non-2xx response into an *apperror.
// It tries the OpenAI-style { error: { message, type, code, param } } shape and
// falls back to including HTTP status + raw body so opaque relays like
// "openai_error" still produce something actionable.
func readProviderError(resp *http.Response) error {
	// Cap the body so a buggy upstream that sends megabytes of HTML doesn't
	// blow up the error message we surface to the user/admin.
	const maxBody = 4 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	return parseProviderErrorBytes(resp.StatusCode, body)
}

// parseProviderErrorBytes is the readProviderError logic for callers that have
// already read the response body (e.g. video task submission).
func parseProviderErrorBytes(statusCode int, body []byte) error {
	const maxBody = 4 * 1024
	trimmed := bytes.TrimSpace(body)

	var parsed struct {
		Error struct {
			Message string          `json:"message"`
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
			Param   string          `json:"param"`
		} `json:"error"`
	}

	msg := ""
	if len(trimmed) > 0 && trimmed[0] == '{' {
		if json.Unmarshal(trimmed, &parsed) == nil {
			parts := []string{}
			if parsed.Error.Message != "" {
				parts = append(parts, parsed.Error.Message)
			}
			if parsed.Error.Type != "" && parsed.Error.Type != parsed.Error.Message {
				parts = append(parts, fmt.Sprintf("type=%s", parsed.Error.Type))
			}
			if len(parsed.Error.Code) > 0 && string(parsed.Error.Code) != `null` && string(parsed.Error.Code) != `""` {
				parts = append(parts, fmt.Sprintf("code=%s", strings.Trim(string(parsed.Error.Code), `"`)))
			}
			if parsed.Error.Param != "" {
				parts = append(parts, fmt.Sprintf("param=%s", parsed.Error.Param))
			}
			msg = strings.Join(parts, " · ")
		}
	}

	// If the parsed message is suspiciously opaque (e.g. just "openai_error"
	// from a relay), include a snippet of the raw body so admins can see what
	// the upstream actually returned.
	opaque := msg == "" || isOpaqueProviderMsg(msg)
	if opaque {
		snippet := string(trimmed)
		if len(snippet) > maxBody {
			snippet = snippet[:maxBody] + "…(truncated)"
		}
		if snippet == "" {
			snippet = "<empty body>"
		}
		return apperror.New(
			apperror.CodeInternal,
			fmt.Sprintf("Provider HTTP %d: %s", statusCode, snippet),
		)
	}

	return apperror.New(
		apperror.CodeInternal,
		fmt.Sprintf("Provider HTTP %d: %s", statusCode, msg),
	)
}

// Some relays return error.message values that don't tell you anything
// (e.g. literal "openai_error", "error", "internal"). Treat those as opaque
// so we fall through to dumping the raw body.
func isOpaqueProviderMsg(msg string) bool {
	low := strings.ToLower(strings.TrimSpace(msg))
	switch low {
	case "", "error", "openai_error", "internal", "internal error", "unknown", "unknown error":
		return true
	}
	return false
}
