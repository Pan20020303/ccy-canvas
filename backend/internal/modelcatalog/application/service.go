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
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/shared/apperror"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	imageGenerationTimeoutSeconds = 600
	videoGenerationTimeoutSeconds = 900
	providerTLSHandshakeTimeout   = 30 * time.Second
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

	// Channel health (migration 011).
	MarkChannelSuccess(ctx context.Context, providerID string) error
	IncrementChannelFailure(ctx context.Context, providerID, errMsg string) (failureCount, consecutiveCooldowns int32, err error)
	SetChannelCooldown(ctx context.Context, providerID string, until time.Time) error
	ResetChannelHealth(ctx context.Context, providerID string) error
	InsertGenerationAttempt(ctx context.Context, attempt domain.GenerationAttempt) error
	ListGenerationAttemptsByLog(ctx context.Context, logID string) ([]domain.GenerationAttempt, error)

	// Channel timeout counter (migration 012) — bumped instead of the
	// failure counter so timeouts don't trigger cooldown. The router
	// makes no decisions based on this; it's diagnostic data for the
	// admin badge.
	MarkChannelTimeout(ctx context.Context, providerID string) error

	// Generation log lifecycle — needed by the detached task runner so the
	// goroutine can write its own outcome even after the client has hung up.
	UpdateGenerationLogResult(ctx context.Context, logID, status, resultURL, errMsg string, durationMs int32) error
}

// Service provides model catalog use cases.
type Service struct {
	repo          Repository
	encryptionKey []byte
	// eventBus is optional — when set, the detached task goroutine
	// publishes TaskEvent on completion so SSE-subscribed clients get
	// realtime updates instead of waiting for the 8s recovery poller.
	eventBus *TaskEventBus
}

// NewService creates a new model catalog Service.
func NewService(repo Repository, encryptionKey []byte) *Service {
	return &Service{repo: repo, encryptionKey: encryptionKey}
}

// WithEventBus wires an event bus into the service so completion
// events can be pushed. Returns the service for chaining.
func (s *Service) WithEventBus(bus *TaskEventBus) *Service {
	s.eventBus = bus
	return s
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

// ResolveModelEndpoint looks up which enabled provider serves the given model
// and returns its base URL + decrypted API key. Used by the agent runner so it
// can talk to the same upstream as the rest of the app.
//
// When multiple providers declare the same model (the user-facing UI dedupes
// model names but keeps every vendor's config), this returns only the first
// match. Callers that want automatic fallback across vendors should use
// ResolveModelEndpoints instead.
func (s *Service) ResolveModelEndpoint(ctx context.Context, model string) (baseURL, apiKey string, err error) {
	endpoints, err := s.ResolveModelEndpoints(ctx, model)
	if err != nil {
		return "", "", err
	}
	first := endpoints[0]
	return first.BaseURL, first.APIKey, nil
}

// ModelEndpoint describes one upstream provider that can serve a given model.
// The ProviderID lets callers report success/failure back to the channel-
// health layer so the next request can avoid a sick channel.
type ModelEndpoint struct {
	ProviderID string
	Vendor     string
	BaseURL    string
	APIKey     string
	// CooldownUntil is the channel's stored cooldown timestamp (zero if
	// healthy). When ResolveModelEndpoints falls back to returning ALL
	// channels because every one is cooled, this is used to sort soonest-
	// available first.
	CooldownUntil time.Time
}

// ResolveModelEndpoints returns every enabled provider that declares the
// given model, in priority order. Cooled-down channels are filtered out
// up front so the next request automatically skips a sick relay.
//
// FALLBACK GUARANTEE: when EVERY channel is currently in cooldown (rare
// disaster scenario where all relays went down at once), this returns the
// full list anyway, sorted by `cooldown_until` ASC. That way the request
// at least tries the channel that's closest to recovering, instead of
// erroring out with "no provider available".
//
// Callers iterate this slice for cross-vendor fallback and MUST call
// `MarkChannelSuccess`/`MarkChannelFailure` on the returned ProviderID so
// the next request can route around the bad channel.
func (s *Service) ResolveModelEndpoints(ctx context.Context, model string) ([]ModelEndpoint, error) {
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list configs", err)
	}

	now := time.Now()
	healthy := []ModelEndpoint{}
	cooled := []ModelEndpoint{} // fallback pool when every channel is cooled
	for _, c := range configs {
		if c.Status != "enabled" {
			continue
		}
		serves := false
		for _, m := range c.ModelList {
			if m == model {
				serves = true
				break
			}
		}
		if !serves {
			continue
		}
		if c.EncryptedAPIKey == "" {
			continue
		}
		key, derr := crypto.Decrypt(s.encryptionKey, c.EncryptedAPIKey)
		if derr != nil {
			continue
		}
		ep := ModelEndpoint{
			ProviderID: c.ID,
			Vendor:     c.Vendor,
			BaseURL:    c.BaseURL,
			APIKey:     key,
		}
		if c.InCooldown(now) {
			ep.CooldownUntil = *c.CooldownUntil
			cooled = append(cooled, ep)
		} else {
			healthy = append(healthy, ep)
		}
	}

	if len(healthy) > 0 {
		return healthy, nil
	}

	// All-cooled fallback: sort cooled endpoints by soonest recovery time
	// so we try the channel that's closest to being back online first.
	if len(cooled) > 0 {
		sort.SliceStable(cooled, func(i, j int) bool {
			return cooled[i].CooldownUntil.Before(cooled[j].CooldownUntil)
		})
		return cooled, nil
	}

	return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("No enabled provider found for model %q", model))
}

// ListProviderConfigs returns all provider configs for admin.
func (s *Service) ListProviderConfigs(ctx context.Context) ([]domain.ProviderConfig, error) {
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list provider configs", err)
	}
	return configs, nil
}

// GetProviderConfigByID returns a single config or nil when not found.
// Thin passthrough exposed so the admin handler can refresh a row after
// mutating its health state.
func (s *Service) GetProviderConfigByID(ctx context.Context, id string) (*domain.ProviderConfig, error) {
	return s.repo.GetProviderConfigByID(ctx, id)
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
	// GenerationLogID is the parent row in generation_logs (when the caller
	// pre-creates the log before invoking Generate). Used to link each
	// per-attempt row in generation_attempts back to the request. Empty
	// string is allowed — attempts are still recorded, just unlinked.
	GenerationLogID string
	// UserID identifies the requesting user. Needed by the detached task
	// goroutine to fan completion events through TaskEventBus on the
	// per-user channel. Optional; when empty, completion events are
	// skipped and only the generation_logs row is updated.
	UserID string
	// NodeID is the canvas node that requested this generation. Surfaced
	// on TaskEvent so SSE clients can correlate the push back to the
	// right node without an extra DB lookup.
	NodeID string
}

// GenerateResult carries the generation result.
type GenerateResult struct {
	Type    string `json:"type"`    // "text" or "url"
	Content string `json:"content"` // text content or image URL
}

// candidateChannel is a provider that matched the request's (service_type,
// model) tuple along with its decrypted API key. Built by buildCandidates
// so Generate can iterate them for cross-vendor fallback.
type candidateChannel struct {
	cfg     *domain.ProviderConfig
	baseURL string
	apiKey  string
}

// buildCandidates returns every healthy (not-in-cooldown) provider that
// could serve req, in priority order. When every match is in cooldown we
// fall back to the all-cooled list sorted by soonest recovery — same
// disaster-recovery posture as ResolveModelEndpoints uses for the agent
// streaming path.
func (s *Service) buildCandidates(req GenerateRequest) ([]candidateChannel, error) {
	configs, err := s.repo.ListProviderConfigs(context.Background())
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list configs", err)
	}
	now := time.Now()
	healthy, cooled := []candidateChannel{}, []candidateChannel{}
	for i := range configs {
		c := configs[i]
		if c.Status != "enabled" {
			continue
		}
		if req.ServiceType != "" && c.ServiceType != req.ServiceType {
			continue
		}
		serves := false
		for _, m := range c.ModelList {
			if m == req.Model {
				serves = true
				break
			}
		}
		if !serves {
			continue
		}
		if c.EncryptedAPIKey == "" {
			continue
		}
		apiKey, derr := crypto.Decrypt(s.encryptionKey, c.EncryptedAPIKey)
		if derr != nil {
			continue
		}
		cand := candidateChannel{
			cfg:     &c,
			baseURL: strings.TrimRight(c.BaseURL, "/"),
			apiKey:  apiKey,
		}
		if c.InCooldown(now) {
			cooled = append(cooled, cand)
		} else {
			healthy = append(healthy, cand)
		}
	}
	if len(healthy) > 0 {
		return healthy, nil
	}
	if len(cooled) > 0 {
		sort.SliceStable(cooled, func(i, j int) bool {
			return cooled[i].cfg.CooldownUntil.Before(*cooled[j].cfg.CooldownUntil)
		})
		return cooled, nil
	}
	return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("No enabled provider found for model %q", req.Model))
}

// dispatchToVendor runs ONE attempt against the supplied channel by
// routing to the existing vendor-specific helper. Centralizes the switch
// so the fallback loop in Generate doesn't have to duplicate it.
func (s *Service) dispatchToVendor(ctx context.Context, c candidateChannel, req GenerateRequest) (*GenerateResult, error) {
	switch c.cfg.ServiceType {
	case "image":
		return s.generateImage(ctx, c.cfg, c.baseURL, c.apiKey, req)
	case "text":
		return s.generateText(ctx, c.baseURL, c.apiKey, req)
	case "video":
		return s.generateVideo(ctx, c.cfg, c.baseURL, c.apiKey, req)
	default:
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("Generation not yet supported for service type %q", c.cfg.ServiceType))
	}
}

// Generate routes the request to a vendor. Image requests get automatic
// cross-vendor fallback: when the first channel fails with anything other
// than a CategoryClientFault (bad prompt) we move on to the next candidate
// and keep going until one succeeds or we exhaust the list. Video/audio
// retain the previous "first match only" behavior — they're long-running
// async tasks where mid-flight switching wastes upstream quota. All
// service types still report success / failure to the channel-health
// layer so admins can see which vendor is sick in the UI.
// maxRuntimeForType returns the maximum wall-clock time a detached task
// goroutine is allowed to run for a given service type. Env overrides:
//
//	IMAGE_TASK_MAX_RUNTIME_SECONDS
//	VIDEO_TASK_MAX_RUNTIME_SECONDS
//	AUDIO_TASK_MAX_RUNTIME_SECONDS
//
// Defaults: image 15 min, video 30 min, audio 10 min. This is the *hard*
// upper bound — well past every provider's typical worst case, so a task
// hitting it almost always means the upstream is truly stuck.
func maxRuntimeForType(serviceType string) time.Duration {
	envKey := ""
	def := 5 * time.Minute
	switch serviceType {
	case "image":
		envKey = "IMAGE_TASK_MAX_RUNTIME_SECONDS"
		def = 15 * time.Minute
	case "video":
		envKey = "VIDEO_TASK_MAX_RUNTIME_SECONDS"
		def = 30 * time.Minute
	case "audio":
		envKey = "AUDIO_TASK_MAX_RUNTIME_SECONDS"
		def = 10 * time.Minute
	}
	if envKey != "" {
		if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return time.Duration(n) * time.Second
			}
		}
	}
	return def
}

func (s *Service) Generate(callerCtx context.Context, req GenerateRequest) (*GenerateResult, error) {
	candidates, err := s.buildCandidates(req)
	if err != nil {
		return nil, err
	}

	// Detach the generation work from the caller's context. The caller
	// (HTTP handler bound to client connection) may give up and return 408
	// to the browser, but the upstream task can keep running and write its
	// outcome to generation_logs. Stage 2 will surface those late results
	// to the UI; Stage 1's contract is "no more lost generations".
	detachedCtx, cancelDetached := context.WithTimeout(context.Background(), maxRuntimeForType(req.ServiceType))

	type genResult struct {
		result *GenerateResult
		err    error
	}
	doneCh := make(chan genResult, 1)
	startedAt := time.Now()

	go func() {
		defer cancelDetached()

		result, runErr := s.runCandidateLoop(detachedCtx, candidates, req)

		// Cache the upstream URL to local disk so the asset survives
		// after the provider's signed URL expires. Best-effort: on
		// failure the original URL is kept. Skipped for inline-text
		// results (no URL to download) and for already-cached / data:
		// URLs. See PersistRemoteAsset for the full skip rules.
		if runErr == nil && result != nil && result.Type == "url" && result.Content != "" {
			if cachedURL, cacheErr := PersistRemoteAsset(detachedCtx, result.Content); cacheErr == nil {
				result.Content = cachedURL
			}
		}

		// Persist the outcome ourselves. The handler used to do this, but
		// now the handler may have already returned to the client by the
		// time we finish — so the goroutine owns the lifecycle write.
		duration := time.Since(startedAt)
		s.persistGenerationOutcome(req.GenerationLogID, result, runErr, duration)

		// Push to SSE subscribers (no-op if no eventBus or no userID).
		s.publishTaskEvent(req, result, runErr, duration)

		doneCh <- genResult{result: result, err: runErr}
	}()

	select {
	case res := <-doneCh:
		return res.result, res.err
	case <-callerCtx.Done():
		// Client disconnected / aborted. Goroutine continues; the
		// persist call inside it will eventually write the final state.
		return nil, callerCtx.Err()
	}
}

// runCandidateLoop preserves the original per-service-type dispatch logic:
// video/audio = single shot, image/text = priority-order fallback. Extracted
// so Generate() can wrap it cleanly inside the detached goroutine.
func (s *Service) runCandidateLoop(ctx context.Context, candidates []candidateChannel, req GenerateRequest) (*GenerateResult, error) {
	if req.ServiceType == "video" || req.ServiceType == "audio" {
		c := candidates[0]
		started := time.Now()
		result, err := s.dispatchToVendor(ctx, c, req)
		duration := int(time.Since(started).Milliseconds())
		s.recordChannelOutcome(ctx, req, c, 1, err, duration)
		return result, err
	}

	var lastErr error
	for i, c := range candidates {
		started := time.Now()
		result, err := s.dispatchToVendor(ctx, c, req)
		duration := int(time.Since(started).Milliseconds())
		s.recordChannelOutcome(ctx, req, c, i+1, err, duration)
		if err == nil {
			return result, nil
		}
		lastErr = err
		cat := ClassifyError(httpStatusFromError(err), err.Error())
		if cat == CategoryClientFault {
			// User's input is malformed — no point trying other vendors.
			return nil, err
		}
		// Otherwise: try the next candidate (MarkChannelFailure was
		// already called inside recordChannelOutcome).
	}
	return nil, lastErr
}

// persistGenerationOutcome writes the final status/result/error to the
// generation_logs row. Uses a fresh background context with a small
// budget so the write succeeds even when the detached ctx has expired
// from its own maxRuntime cap. Best-effort: a write failure is logged
// implicitly via the silent error return — the channel-attempt audit
// trail still records the underlying upstream outcome.
func (s *Service) persistGenerationOutcome(logID string, result *GenerateResult, err error, duration time.Duration) {
	if logID == "" || s.repo == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	status := "success"
	errMsg := ""
	resultURL := ""
	if err != nil {
		status = "error"
		errMsg = err.Error()
	} else if result != nil {
		resultURL = result.Content
	}
	_ = s.repo.UpdateGenerationLogResult(ctx, logID, status, resultURL, errMsg, int32(duration.Milliseconds()))
}

// publishTaskEvent emits a TaskEvent to all SSE subscribers of the user
// who initiated this generation. Skips silently when no event bus is
// wired or no userID was attached (e.g. anonymous-tested generations).
func (s *Service) publishTaskEvent(req GenerateRequest, result *GenerateResult, err error, duration time.Duration) {
	if s.eventBus == nil || req.UserID == "" {
		return
	}
	status := "success"
	errMsg := ""
	resultURL := ""
	if err != nil {
		status = "error"
		errMsg = err.Error()
	} else if result != nil {
		resultURL = result.Content
	}
	s.eventBus.Publish(req.UserID, TaskEvent{
		TaskID:      req.GenerationLogID,
		NodeID:      req.NodeID,
		ServiceType: req.ServiceType,
		Status:      status,
		ResultURL:   resultURL,
		ErrorMsg:    errMsg,
		DurationMs:  int(duration.Milliseconds()),
	})
}

// recordChannelOutcome updates the channel's health state AND inserts a
// generation_attempts row so admins can see exactly which vendor served
// each request. Called from Generate's fallback loop for every attempt.
//
// The current GenerationLogID is not yet threaded here — the generate
// handler creates a generation_logs row independently. We pass an empty
// log ID for now; the per-attempt logs are still useful aggregated by
// (provider, time) even without the back-pointer.
func (s *Service) recordChannelOutcome(
	ctx context.Context,
	req GenerateRequest,
	c candidateChannel,
	attemptNumber int,
	err error,
	durationMs int,
) {
	httpStatus := httpStatusFromError(err)
	var errMsg string
	if err != nil {
		errMsg = err.Error()
		cat := ClassifyError(httpStatus, errMsg)
		// Timeouts get their own counter (Stage 4) and are NOT counted
		// against the cooldown threshold. Everything else flows through
		// the existing failure-counter / cooldown machinery.
		if cat == CategoryTimeout {
			s.MarkChannelTimeout(ctx, c.cfg.ID)
		} else {
			s.MarkChannelFailure(ctx, c.cfg.ID, cat, errMsg)
		}
	} else {
		s.MarkChannelSuccess(ctx, c.cfg.ID)
	}
	logID := req.GenerationLogID // empty when not threaded yet
	s.RecordGenerationAttempt(ctx, logID, c.cfg.ID, c.cfg.Vendor,
		attemptNumber, httpStatus, durationMs, errMsg)
}

// isVolcengine returns true when a provider config targets Volcengine ark
// (火山引擎). Matches by Vendor field first, then by BaseURL host fallback.
func isVolcengine(pc *domain.ProviderConfig) bool {
	if pc == nil {
		return false
	}
	v := strings.ToLower(strings.TrimSpace(pc.Vendor))
	if v == "volcengine" {
		return true
	}
	return strings.Contains(pc.BaseURL, "volces.com")
}

func isSeedance20Model(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(m, "seedance-2-0")
}

func isArkVideoContract(pc *domain.ProviderConfig) bool {
	if pc == nil {
		return false
	}
	submit := strings.ToLower(strings.TrimSpace(pc.SubmitEndpoint))
	query := strings.ToLower(strings.TrimSpace(pc.QueryEndpoint))
	return strings.Contains(submit, "/contents/generations/tasks") ||
		strings.Contains(query, "/contents/generations/tasks/")
}

func resolveProviderURL(baseURL, endpoint string) string {
	base := strings.TrimSpace(baseURL)
	path := strings.TrimSpace(endpoint)
	if path == "" {
		return strings.TrimRight(base, "/")
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return strings.TrimRight(base, "/") + path
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if basePath != "" && (path == basePath || strings.HasPrefix(path, basePath+"/")) {
		parsed.Path = path
		return strings.TrimRight(parsed.String(), "/")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	return strings.TrimRight(parsed.String(), "/")
}

func (s *Service) generateImage(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	if ResolveProfile(pc).ID == "ark" {
		return s.generateImageVolcengine(ctx, pc, baseURL, apiKey, req)
	}
	// Image-to-image (ref + prompt) requires the multipart /images/edits endpoint —
	// the standard /images/generations is text-only and silently ignores reference
	// fields, which previously produced visually unrelated outputs.
	if len(req.ReferenceImages) > 0 {
		return s.generateImageEdit(ctx, pc, baseURL, apiKey, req)
	}
	return s.generateImageTextOnly(ctx, pc, baseURL, apiKey, req)
}

// generateImageVolcengine talks to Volcengine ark's /images/generations.
// The endpoint URL matches OpenAI but the accepted payload fields are
// different — passing OpenAI-only fields like `quality` / `background` /
// `output_format` makes ark close the connection (manifests as EOF in Go).
// Reference images go in an `image` field (string or []string), not via a
// separate multipart `/images/edits` endpoint.
func (s *Service) generateImageVolcengine(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	size := mapAspectRatioToVolcengineSize(req.Model, req.Size, req.Quality)
	submitPath := resolveImageGenPath(pc)

	body := map[string]interface{}{
		"model":                       req.Model,
		"prompt":                      req.Prompt,
		"size":                        size,
		"stream":                      false,
		"output_format":               "png",
		"response_format":             "url",
		"watermark":                   false,
		"sequential_image_generation": "disabled",
	}

	// Resolve reference images to URLs (preferred by ark) or base64 data URIs.
	if len(req.ReferenceImages) > 0 {
		refs := make([]string, 0, len(req.ReferenceImages))
		for i, raw := range req.ReferenceImages {
			du, err := localPathToDataURL(raw)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
			}
			refs = append(refs, du)
		}
		if len(refs) == 1 {
			body["image"] = refs[0]
		} else {
			body["image"] = refs
		}
	}

	bodyJSON, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := newProviderHTTPClient(imageGenerationTimeout())
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
	return parseImageGenerationResponse(respBody)
}

// mapAspectRatioToVolcengineSize converts our ratio-oriented UI values into a
// Volcengine Seedream-compatible size. Seedream image endpoints accept
// WIDTHxHEIGHT or model-specific buckets like 2k/3k/4k, but not plain ratios.
func mapAspectRatioToVolcengineSize(modelName, size, quality string) string {
	s := strings.ToLower(strings.TrimSpace(size))
	switch s {
	case "1k", "2k", "3k", "4k":
		return s
	}
	if strings.Contains(s, "x") {
		return s
	}

	if s == "" || s == "auto" || s == "adaptive" {
		return defaultVolcengineImageSize(modelName, quality)
	}

	if strings.Contains(s, ":") {
		return buildVolcengineImageSizeFromRatio(s, quality)
	}
	return defaultVolcengineImageSize(modelName, quality)
}

func defaultVolcengineImageSize(modelName, quality string) string {
	model := strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.Contains(model, "seedream-5"),
		strings.Contains(model, "seedream-4-5"),
		strings.Contains(model, "seedream-4-0"):
		switch normalizeVolcengineImageQuality(quality) {
		case "high":
			return "4k"
		case "medium":
			return "3k"
		case "low":
			return "2k"
		default:
			return "2k"
		}
	case strings.Contains(model, "seedream-3"):
		return "1024x1024"
	default:
		return "2k"
	}
}

func buildVolcengineImageSizeFromRatio(ratio, quality string) string {
	parts := strings.Split(strings.TrimSpace(ratio), ":")
	if len(parts) != 2 {
		return "2048x2048"
	}
	left, errLeft := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	right, errRight := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if errLeft != nil || errRight != nil || left <= 0 || right <= 0 {
		return "2048x2048"
	}

	base := 2048.0
	switch normalizeVolcengineImageQuality(quality) {
	case "high":
		base = 4096
	case "medium":
		base = 3072
	case "low":
		base = 2048
	}

	width := base
	height := base
	if left >= right {
		height = roundToMultiple(base*(right/left), 64)
	} else {
		width = roundToMultiple(base*(left/right), 64)
	}

	if width < 512 {
		width = 512
	}
	if height < 512 {
		height = 512
	}

	return fmt.Sprintf("%dx%d", int(width), int(height))
}

func roundToMultiple(value, step float64) float64 {
	if step <= 0 {
		return value
	}
	return math.Round(value/step) * step
}

func imageGenerationTimeout() time.Duration {
	// Some image relays hold the request open for several minutes before
	// sending response headers. Keep the backend aligned with the frontend's
	// explicit 600-second abort window so we do not fail early locally.
	return time.Duration(imageGenerationTimeoutSeconds) * time.Second
}

func newProviderHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext
	transport.TLSHandshakeTimeout = providerTLSHandshakeTimeout
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

func videoGenerationTimeout() time.Duration {
	return time.Duration(videoGenerationTimeoutSeconds) * time.Second
}

func videoPollInitialDelay() time.Duration {
	return 8 * time.Second
}

func videoPollInterval() time.Duration {
	return 6 * time.Second
}

func videoPollMaxAttempts() int {
	timeout := videoGenerationTimeout()
	initialDelay := videoPollInitialDelay()
	interval := videoPollInterval()
	if timeout <= initialDelay {
		return 1
	}
	return 1 + int((timeout-initialDelay)/interval)
}

func normalizeVolcengineImageQuality(quality string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "high", "medium", "low":
		return strings.ToLower(strings.TrimSpace(quality))
	default:
		return "auto"
	}
}

func (s *Service) generateImageTextOnly(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	size := mapAspectRatioToOpenAIImageSize(req.Size)
	quality := normalizeOpenAIImageQuality(req.Quality)
	submitPath := resolveImageGenPath(pc)
	queryPath := resolveImageQueryPath(pc)

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

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := newProviderHTTPClient(imageGenerationTimeout())
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
		return s.pollImageTask(ctx, baseURL, apiKey, queryPath, taskID)
	}

	return parseImageGenerationResponse(respBody)
}

// generateImageEdit calls /v1/images/edits with multipart/form-data so reference
// images actually influence the result. Used whenever the request has at least
// one reference image.
func (s *Service) generateImageEdit(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	// Decode and re-encode each reference image as JPEG, downscaled if needed,
	// using the same pipeline as the text-only flow so we send a sane payload.
	type refImage struct {
		name  string
		bytes []byte
	}
	refs := make([]refImage, 0, len(req.ReferenceImages))
	// NOTE: submit_endpoint maps to the GENERATION operation; the edit
	// path is resolved separately (with sibling derivation) so a config
	// carrying "/images/generations" no longer hijacks multipart edits.
	submitPath := resolveImageEditPath(pc)
	queryPath := resolveImageQueryPath(pc)
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
			var ferr error
			b, ferr = fetchRemoteReferenceBytes(ctx, dataURL)
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

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), &body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build edit request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())

	client := newProviderHTTPClient(imageGenerationTimeout())
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

	if taskID := extractImageTaskID(respBody); taskID != "" {
		return s.pollImageTask(ctx, baseURL, apiKey, queryPath, taskID)
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
func (s *Service) pollImageTask(ctx context.Context, baseURL, apiKey, queryPath, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}

	// Try multiple URL patterns used by various providers.
	// apimart.ai uses GET /v1/tasks/{task_id}
	pollURLs := make([]string, 0, 4)
	if strings.TrimSpace(queryPath) != "" {
		pollURLs = append(pollURLs, resolveProviderURL(baseURL, strings.ReplaceAll(queryPath, "{taskId}", taskID)))
	}
	pollURLs = append(pollURLs,
		baseURL+"/tasks/"+taskID,
		baseURL+"/images/generations/"+taskID,
		baseURL+"/async/tasks/"+taskID,
	)

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
const remoteReferenceFetchTimeout = 90 * time.Second

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
	diskPath, err := resolveUploadDiskPath(rawURL)
	if err != nil {
		return "", err
	}

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

func resolveUploadDiskPath(rawURL string) (string, error) {
	rel := strings.TrimSpace(rawURL)
	rel = strings.TrimPrefix(rel, "/uploads/")
	rel = strings.TrimPrefix(rel, "uploads/")
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = filepath.Clean(rel)
	if rel == "." || rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("invalid upload reference path %q", rawURL)
	}

	candidateRoots := make([]string, 0, 16)
	if cwd, err := os.Getwd(); err == nil {
		candidateRoots = appendUploadRootCandidates(candidateRoots, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		candidateRoots = appendUploadRootCandidates(candidateRoots, filepath.Dir(exe))
	}

	seen := map[string]struct{}{}
	checked := make([]string, 0, len(candidateRoots))
	for _, root := range candidateRoots {
		if _, ok := seen[root]; ok {
			continue
		}
		seen[root] = struct{}{}
		candidate := filepath.Join(root, "uploads", rel)
		checked = append(checked, candidate)
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("upload reference %q not found; checked %s", rawURL, strings.Join(checked, ", "))
}

func appendUploadRootCandidates(out []string, start string) []string {
	dir, err := filepath.Abs(start)
	if err != nil {
		dir = start
	}
	for i := 0; i < 6 && dir != ""; i++ {
		out = append(out, dir)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return out
}

func fetchRemoteReferenceBytes(ctx context.Context, rawURL string) ([]byte, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, remoteReferenceFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build remote reference request: %w", err)
	}
	req.Header.Set("User-Agent", "ccy-canvas/1.0")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")

	resp, err := (&http.Client{Timeout: remoteReferenceFetchTimeout}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch remote reference: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("remote reference returned %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read remote reference body: %w", err)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("remote reference body is empty")
	}
	return body, nil
}

func (s *Service) generateVideo(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	// Volcengine ark uses a different async-task contract (path + payload + status
	// vocabulary) than the sora-style /videos endpoint. Route only providers that
	// actually use the Ark task contract, not every custom provider with explicit
	// submit/query paths.
	if ResolveProfile(pc).ID == "ark" {
		return s.generateVideoArk(ctx, pc, baseURL, apiKey, req)
	}
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
	submitPath := resolveVideoSubmitPath(pc)
	queryPath := resolveVideoQueryPath(pc)

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

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
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

	return s.pollVideoTask(ctx, baseURL, apiKey, queryPath, taskID)
}

// generateVideoArk talks to Volcengine ark's async video API
// (POST /contents/generations/tasks → poll /contents/generations/tasks/{id}).
// The submit/query endpoints come from ProviderConfig so other custom vendors
// that mimic this shape can reuse the path. The request payload differs from
// sora-style /videos: prompt and references go into a `content` array of
// {type:"text"|"image_url", ...} items, and completion is signalled by
// status=="succeeded" with the URL at content.video_url.
func (s *Service) generateVideoArk(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	submitPath := resolveVideoSubmitPath(pc)
	queryPath := resolveVideoQueryPath(pc)
	if !strings.HasPrefix(submitPath, "/") {
		submitPath = "/" + submitPath
	}
	if !strings.HasPrefix(queryPath, "/") {
		queryPath = "/" + queryPath
	}

	ratio := strings.TrimSpace(req.AspectRatio)
	if ratio == "" {
		ratio = strings.TrimSpace(req.Size)
	}
	if ratio == "" || strings.EqualFold(ratio, "auto") {
		ratio = "adaptive"
	}
	duration := req.Duration
	if duration <= 0 {
		duration = 5
	}

	if len(req.ReferenceImages) > 2 && !isSeedance20Model(req.Model) {
		return nil, apperror.New(
			apperror.CodeInvalidInput,
			"当前 Seedance 模型最多支持 2 张参考图；1~9 张多图参考仅支持 Seedance 2.0 系列。",
		)
	}

	content := make([]map[string]interface{}, 0, 1+len(req.ReferenceImages))
	if strings.TrimSpace(req.Prompt) != "" {
		content = append(content, map[string]interface{}{
			"type": "text",
			"text": req.Prompt,
		})
	}
	for i, raw := range req.ReferenceImages {
		du, err := localPathToDataURL(raw)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, fmt.Sprintf("Failed to process reference image #%d", i+1), err)
		}
		item := map[string]interface{}{
			"type":      "image_url",
			"image_url": map[string]interface{}{"url": du},
		}
		if len(req.ReferenceImages) == 2 {
			if i == 0 {
				item["role"] = "first_frame"
			}
			if i == 1 {
				item["role"] = "last_frame"
			}
		} else if req.ReferenceMode == "start_frame" && i == 0 {
			item["role"] = "first_frame"
		}
		content = append(content, item)
	}

	body := map[string]interface{}{
		"model":     req.Model,
		"content":   content,
		"ratio":     ratio,
		"duration":  duration,
		"watermark": false,
	}
	if req.Resolution != "" {
		body["resolution"] = req.Resolution
	}
	bodyJSON, _ := json.Marshal(body)

	submitURL := baseURL + submitPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build submit request", err)
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

	var submitResp map[string]interface{}
	if err := json.Unmarshal(respBody, &submitResp); err != nil {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Failed to parse submit response: %s", string(respBody[:min(len(respBody), 300)])))
	}
	taskID, _ := submitResp["id"].(string)
	if taskID == "" {
		if id, ok := submitResp["task_id"].(string); ok {
			taskID = id
		}
	}
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("No task ID in response: %s", string(respBody[:min(len(respBody), 500)])))
	}

	return s.pollVideoArkTask(ctx, baseURL, queryPath, apiKey, taskID)
}

// pollVideoArkTask polls a Volcengine-style async task until status=="succeeded"
// or "failed". The status vocabulary is queued / running / succeeded / failed
// (note: succeeded, not completed). The completed URL lives at content.video_url.
func (s *Service) pollVideoArkTask(ctx context.Context, baseURL, queryPath, apiKey, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	pollURL := baseURL + strings.ReplaceAll(queryPath, "{taskId}", taskID)

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}

	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(videoPollInterval()):
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
		switch status {
		case "failed", "error", "cancelled", "canceled":
			msg := ""
			if e, ok := taskResp["error"].(map[string]interface{}); ok {
				if m, ok := e["message"].(string); ok {
					msg = m
				}
				if c, ok := e["code"].(string); ok && c != "" {
					msg = c + ": " + msg
				}
			}
			if msg == "" {
				msg = string(body[:min(len(body), 500)])
			}
			return nil, apperror.New(apperror.CodeInternal, "Video generation failed: "+msg)
		case "succeeded", "success", "completed":
			if c, ok := taskResp["content"].(map[string]interface{}); ok {
				if u, ok := c["video_url"].(string); ok && u != "" {
					return &GenerateResult{Type: "url", Content: u}, nil
				}
			}
			if u := findStringField(taskResp, "video_url", 5); u != "" {
				return &GenerateResult{Type: "url", Content: u}, nil
			}
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Task succeeded but no video_url found. Raw: %s", string(body[:min(len(body), 800)])))
		}
		// queued / running / unknown — keep polling.
	}
	return nil, apperror.New(apperror.CodeInternal, "Video generation timed out after polling")
}

// pollVideoTask polls the provider's task endpoint until completed or failed.
func (s *Service) pollVideoTask(ctx context.Context, baseURL, apiKey, queryPath, taskID string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	if strings.TrimSpace(queryPath) == "" {
		queryPath = "/videos/{taskId}"
	}
	pollURL := resolveProviderURL(baseURL, strings.ReplaceAll(queryPath, "{taskId}", taskID))

	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(videoPollInitialDelay()):
	}

	for i := 0; i < videoPollMaxAttempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(videoPollInterval()):
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
