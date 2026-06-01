// Package application contains model catalog use-case services.
package application

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/shared/apperror"
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
	ServiceType string // image / text / video / audio
	Model       string // e.g. "gpt-image-2"
	Prompt      string
	Size        string // ratio like "1:1", "16:9", "auto"
	Resolution  string // image: "1k"/"2k"/"4k"; video: "480p"/"720p"
	Duration    int    // video duration in seconds
	AspectRatio string // video aspect ratio: "16:9", "9:16", etc.
	ReferenceImages []string
	ReferenceVideo  string
	ReferenceVideos []string
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
	size := req.Size
	if size == "" {
		size = "1:1"
	}
	resolution := req.Resolution
	if resolution == "" {
		resolution = "1k"
	}

	body := map[string]interface{}{
		"model":      req.Model,
		"prompt":     req.Prompt,
		"n":          1,
		"size":       size,
		"resolution": resolution,
	}
	if len(req.ReferenceImages) > 0 {
		body["reference_images"] = req.ReferenceImages
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
		var errBody struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&errBody); decErr == nil && errBody.Error.Message != "" {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider error: %s", errBody.Error.Message))
		}
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider returned HTTP %d", resp.StatusCode))
	}

	// Read full body for flexible parsing.
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to read provider response", readErr)
	}

	// Parse response — supports both sync (standard OpenAI) and async (task-based) formats.
	var result struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
			Status  string `json:"status"`
			TaskID  string `json:"task_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse provider response: %s", string(respBody[:min(len(respBody), 300)])))
	}
	if len(result.Data) == 0 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider returned no images. Raw: %s", string(respBody[:min(len(respBody), 500)])))
	}

	entry := result.Data[0]

	// Async task: poll until completed.
	if entry.TaskID != "" && entry.URL == "" && entry.B64JSON == "" {
		return s.pollImageTask(ctx, baseURL, apiKey, entry.TaskID)
	}

	imageURL := entry.URL
	if imageURL == "" && entry.B64JSON != "" {
		imageURL = "data:image/png;base64," + entry.B64JSON
	}
	if imageURL == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider response has no url or b64_json. Raw: %s", string(respBody[:min(len(respBody), 800)])))
	}

	return &GenerateResult{Type: "url", Content: imageURL}, nil
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
		var errBody struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&errBody); decErr == nil && errBody.Error.Message != "" {
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider error: %s", errBody.Error.Message))
		}
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider returned HTTP %d", resp.StatusCode))
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
		body["reference_images"] = req.ReferenceImages
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
		var errBody struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(respBody, &errBody) == nil {
			msg := errBody.Error.Message
			if msg == "" {
				msg = errBody.Detail
			}
			if msg != "" {
				return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider error: %s", msg))
			}
		}
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Provider returned HTTP %d: %s", resp.StatusCode, string(respBody[:min(len(respBody), 300)])))
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
