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
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	imageGenerationTimeoutSeconds = 600
	videoGenerationTimeoutSeconds = 900
	providerTLSHandshakeTimeout   = 60 * time.Second
	providerRequestMaxAttempts    = 3
)

var (
	imageTaskPollInitialDelay = 10 * time.Second
	imageTaskPollInterval     = 5 * time.Second
	// Manju/NewAPI image tasks (gpt-image-2 etc.) finish in ~2-5 min. Poll
	// long enough to cover that: 10s + 120*5s ≈ 610s, aligned with the
	// image generation budget. Too few attempts would time out before the
	// gateway finishes and make the user re-submit.
	imageTaskPollMaxAttempts = 120
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
	UpdateGenerationLogResult(ctx context.Context, logID, status, resultURL, errMsg string, durationMs int32, cacheHit bool) error
	MarkGenerationLogPersisting(ctx context.Context, logID string, staged StagedAsset, durationMs int32) error
	MarkGenerationLogAssetReady(ctx context.Context, logID, cosURL string, durationMs int32) error
	MarkGenerationLogAssetFailed(ctx context.Context, logID, status, errMsg string) error

	// Reaper (F3): find active rows older than the cutoff, and mark a single
	// still-active row as timed-out. MarkGenerationTimedOut returns false
	// when the guarded UPDATE matched no row (task already finished).
	ListStaleActiveGenerations(ctx context.Context, olderThan time.Time) ([]domain.StaleGeneration, error)
	MarkGenerationTimedOut(ctx context.Context, logID, errMsg string) (bool, error)
	// MarkGenerationLogFailed guard-transitions a still-active row to 'error'
	// and returns true only when this call performed the transition (false if
	// the row was already terminal). Lets a refund fire exactly once even when
	// the worker's FinalizeFailure and the reaper race on the same task.
	MarkGenerationLogFailed(ctx context.Context, logID, errMsg string, durationMs int32) (bool, error)
	CreateAdminAlert(ctx context.Context, alert domain.AdminAlert) error
	ListAdminAlerts(ctx context.Context, status string, limit, offset int32) ([]domain.AdminAlert, error)
	CountUnreadAdminAlerts(ctx context.Context) (int32, error)
	MarkAdminAlertRead(ctx context.Context, id string) error
	MarkAllAdminAlertsRead(ctx context.Context) error
}

type Cache interface {
	Get(ctx context.Context, key string, dst any) bool
	Set(ctx context.Context, key string, value any, ttl time.Duration)
	Delete(ctx context.Context, keys ...string)
	DeletePattern(ctx context.Context, pattern string)
}

type AssetPersistPayload struct {
	LogID       string
	UserID      string
	NodeID      string
	ServiceType string
	StagingPath string
	StagingURL  string
	COSKey      string
	ContentType string
	EnqueuedAt  int64
}

type AssetPersistEnqueuer interface {
	EnqueueAssetPersist(ctx context.Context, p AssetPersistPayload) (string, error)
}

// Service provides model catalog use cases.
type Service struct {
	repo          Repository
	encryptionKey []byte
	cache         Cache
	// eventBus is optional — when set, the detached task goroutine
	// publishes TaskEvent on completion so SSE-subscribed clients get
	// realtime updates instead of waiting for the 8s recovery poller.
	eventBus *TaskEventBus
	// newAPI is optional. When .Configured() is true, dispatchToVendor
	// routes text (and later image/video) through the NewAPI gateway
	// instead of the per-ProviderConfig direct path. Empty NEWAPI_BASE_URL
	// at boot leaves this nil and behavior is unchanged (legacy path).
	// See docs/dev/2026-06-newapi-runbook.md.
	newAPI *NewAPIClient
	// credits is optional. When set, each generation reserves credits at
	// submit and refunds them on terminal failure. nil → no charging (the
	// legacy behavior). Wired in main from the credits bounded context.
	credits    creditcharger
	assetQueue AssetPersistEnqueuer
}

// creditcharger mirrors credits/application.Charger as a local interface so
// this package stays free of a credits import. main wires the concrete one.
type creditcharger interface {
	Reserve(ctx context.Context, userID string, amount int32, reason string) error
	Refund(ctx context.Context, userID string, amount int32, reason string) error
}

// ErrInsufficientCredits is re-exported so the HTTP handler can detect it
// without importing the credits package.
var ErrInsufficientCredits = errors.New("insufficient credits")

// WithCredits attaches the per-generation credit charger. Returns the
// service for chaining.
func (s *Service) WithCredits(c creditcharger) *Service {
	s.credits = c
	return s
}

// defaultCreditCost is charged when a provider config doesn't specify a
// per-model or config-level credit_cost in its parameter_schema.
const defaultCreditCost int32 = 1

func clampCreditCost(v int32) int32 {
	if v < 0 {
		return 0
	}
	return v
}

// resolveCreditCost reads the per-call price from a provider config's
// parameter_schema: a per-model override (models.<model>.credit_cost) wins,
// then the config-level credit_cost, then the global default.
func resolveCreditCost(schemaRaw []byte, model string) int32 {
	if len(schemaRaw) == 0 {
		return defaultCreditCost
	}
	var schema providerParameterSchema
	if err := json.Unmarshal(schemaRaw, &schema); err != nil {
		return defaultCreditCost
	}
	if len(schema.Models) > 0 {
		if m, ok := schema.Models[model]; ok && m.CreditCost != nil {
			return clampCreditCost(*m.CreditCost)
		}
		lowerModel := strings.ToLower(strings.TrimSpace(model))
		for key, modelSchema := range schema.Models {
			if strings.ToLower(strings.TrimSpace(key)) == lowerModel && modelSchema.CreditCost != nil {
				return clampCreditCost(*modelSchema.CreditCost)
			}
		}
	}
	if schema.CreditCost != nil {
		return clampCreditCost(*schema.CreditCost)
	}
	return defaultCreditCost
}

// ResolveGenerationCost determines how many credits this request will cost
// by selecting the same provider config the generation will use and reading
// its configured price. Returns 0 when no provider can be resolved (the
// generation will then fail on its own without having charged anything).
func (s *Service) ResolveGenerationCost(req GenerateRequest) int32 {
	candidates, err := s.buildCandidates(req)
	if err != nil || len(candidates) == 0 {
		return 0
	}
	return resolveCreditCost(candidates[0].cfg.ParameterSchema, req.Model)
}

// ReserveCredits deducts amount at submit. Returns ErrInsufficientCredits
// when the balance can't cover it. No-op when charging isn't wired.
func (s *Service) ReserveCredits(ctx context.Context, userID string, amount int32, reason string) error {
	if s.credits == nil || amount <= 0 || userID == "" {
		return nil
	}
	return s.credits.Reserve(ctx, userID, amount, reason)
}

// RefundCredits returns amount after a terminal failure. Best-effort.
func (s *Service) RefundCredits(ctx context.Context, userID string, amount int32, reason string) {
	if s.credits == nil || amount <= 0 || userID == "" {
		return
	}
	if err := s.credits.Refund(ctx, userID, amount, reason); err != nil {
		log.Printf("[credits] refund failed for user %s amount %d: %v", userID, amount, err)
	}
}

// NewService creates a new model catalog Service.
func NewService(repo Repository, encryptionKey []byte) *Service {
	return &Service{repo: repo, encryptionKey: encryptionKey}
}

const (
	providerConfigsCacheKey = "model_configs:list:global"
	appProviderConfigsKey   = "model_configs:app:list"
)

func providerConfigCacheKey(id string) string {
	return "model_config:" + id
}

func channelHealthCacheKey(id string) string {
	return "channel_health:" + id
}

const unreadAlertsCacheKey = "alerts:unread_count:global"

func generationTaskCacheKey(requestID string) string {
	return "generation_task:" + requestID
}

func normalizeProviderConfig(pc *domain.ProviderConfig) {
	pc.BaseURL = normalizeGatewayBaseURL(pc.BaseURL, pc.APISpec)
	pc.AdapterRuntime = strings.ToLower(strings.TrimSpace(pc.AdapterRuntime))
	if pc.AdapterRuntime == "" {
		pc.AdapterRuntime = "go"
	}
	if pc.AdapterRuntime != "ts" {
		pc.AdapterRuntime = "go"
		pc.AdapterCode = ""
		pc.AdapterChecksum = ""
	} else {
		pc.AdapterCode = strings.TrimSpace(pc.AdapterCode)
		if pc.AdapterCode != "" {
			sum := sha256.Sum256([]byte(pc.AdapterCode))
			pc.AdapterChecksum = hex.EncodeToString(sum[:])
		}
	}
	pc.IconKey = sanitizeProviderIconKey(pc.IconKey)
	pc.IconURL = sanitizeProviderIconURL(pc.IconURL)
	if pc.Protocol == "" {
		switch strings.ToLower(pc.APISpec) {
		case "ark":
			pc.Protocol = "native"
		case "newapi":
			pc.Protocol = "newapi"
		default:
			pc.Protocol = "openai_compatible"
		}
	}
	if len(pc.Capabilities) == 0 && pc.ServiceType != "" {
		pc.Capabilities = []string{pc.ServiceType}
	}
	if pc.ModelList == nil {
		pc.ModelList = []string{}
	}
}

func sanitizeProviderIconKey(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.TrimPrefix(v, "brand:")
	v = strings.TrimPrefix(v, "lobe:")
	v = strings.ReplaceAll(v, "_", "-")
	if v == "" {
		return ""
	}
	if regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`).MatchString(v) {
		return v
	}
	return ""
}

func sanitizeProviderIconURL(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	lower := strings.ToLower(v)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "data:image/png;base64,") ||
		strings.HasPrefix(lower, "data:image/jpeg;base64,") ||
		strings.HasPrefix(lower, "data:image/jpg;base64,") ||
		strings.HasPrefix(lower, "data:image/webp;base64,") ||
		strings.HasPrefix(lower, "data:image/svg+xml;base64,") {
		return v
	}
	return ""
}

func normalizeGatewayBaseURL(baseURL, apiSpec string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	if strings.EqualFold(apiSpec, "ark") || strings.Contains(lower, "/v1") || strings.Contains(lower, "/v2") || strings.Contains(lower, "/v3") {
		return trimmed
	}
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return trimmed + "/v1"
	}
	return trimmed
}

func (s *Service) invalidateProviderConfigCache(ctx context.Context, ids ...string) {
	if s.cache == nil {
		return
	}
	s.cache.Delete(ctx, providerConfigsCacheKey, appProviderConfigsKey)
	for _, id := range ids {
		if id != "" {
			s.cache.Delete(ctx, providerConfigCacheKey(id), channelHealthCacheKey(id))
		}
	}
}

func (s *Service) invalidateAlertCache(ctx context.Context) {
	if s.cache != nil {
		s.cache.Delete(ctx, unreadAlertsCacheKey)
	}
}

// WithEventBus wires an event bus into the service so completion
// events can be pushed. Returns the service for chaining.
func (s *Service) WithEventBus(bus *TaskEventBus) *Service {
	s.eventBus = bus
	return s
}

func (s *Service) WithCache(cache Cache) *Service {
	s.cache = cache
	return s
}

// WithNewAPI wires an optional NewAPI gateway client. When the client is
// Configured(), text generation requests are routed through it,
// short-circuiting the legacy per-ProviderConfig dispatch. Returns the
// service for chaining.
func (s *Service) WithNewAPI(client *NewAPIClient) *Service {
	s.newAPI = client
	return s
}

func (s *Service) WithAssetPersistQueue(q AssetPersistEnqueuer) *Service {
	s.assetQueue = q
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
// match.
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
	// healthy). It remains available for admin UI inspection even though
	// generation routing no longer auto-skips or reorders channels.
	CooldownUntil time.Time
}

// ResolveModelEndpoints returns the first enabled provider that declares the
// given model. We do not auto-fallback across vendors or sort by health; if a
// provider is failing, the error is surfaced to the caller and the admin badge
// can alarm on it.
func (s *Service) ResolveModelEndpoints(ctx context.Context, model string) ([]ModelEndpoint, error) {
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list configs", err)
	}

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
		return []ModelEndpoint{{
			ProviderID: c.ID,
			Vendor:     c.Vendor,
			BaseURL:    c.BaseURL,
			APIKey:     key,
		}}, nil
	}

	return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("No enabled provider found for model %q", model))
}

// ListProviderConfigs returns all provider configs for admin.
func (s *Service) ListProviderConfigs(ctx context.Context) ([]domain.ProviderConfig, error) {
	if s.cache != nil {
		var cached []domain.ProviderConfig
		if s.cache.Get(ctx, providerConfigsCacheKey, &cached) {
			return cached, nil
		}
	}
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list provider configs", err)
	}
	if s.cache != nil {
		s.cache.Set(ctx, providerConfigsCacheKey, configs, 45*time.Second)
	}
	return configs, nil
}

// GetProviderConfigByID returns a single config or nil when not found.
// Thin passthrough exposed so the admin handler can refresh a row after
// mutating its health state.
func (s *Service) GetProviderConfigByID(ctx context.Context, id string) (*domain.ProviderConfig, error) {
	if s.cache != nil {
		var cached domain.ProviderConfig
		if s.cache.Get(ctx, providerConfigCacheKey(id), &cached) {
			return &cached, nil
		}
	}
	config, err := s.repo.GetProviderConfigByID(ctx, id)
	if err == nil && config != nil && s.cache != nil {
		s.cache.Set(ctx, providerConfigCacheKey(id), config, 45*time.Second)
	}
	return config, err
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
	normalizeProviderConfig(&pc)
	if pc.AdapterRuntime == "ts" && pc.AdapterCode == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "TS adapter code is required")
	}
	result, err := s.repo.CreateProviderConfig(ctx, pc)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to create provider config", err)
	}
	s.invalidateProviderConfigCache(ctx, result.ID)
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
	if strings.TrimSpace(pc.AdapterRuntime) == "" {
		pc.AdapterRuntime = existing.AdapterRuntime
		pc.AdapterCode = existing.AdapterCode
		pc.AdapterChecksum = existing.AdapterChecksum
	}
	normalizeProviderConfig(&pc)
	if pc.AdapterRuntime == "ts" && pc.AdapterCode == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "TS adapter code is required")
	}
	result, err := s.repo.UpdateProviderConfig(ctx, pc)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update provider config", err)
	}
	s.invalidateProviderConfigCache(ctx, result.ID)
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
	s.invalidateProviderConfigCache(ctx, id)
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
	s.invalidateProviderConfigCache(ctx, result.ID)
	return result, nil
}

// ListAppProviderConfigs returns enabled provider configs for regular users.
func (s *Service) ListAppProviderConfigs(ctx context.Context) ([]domain.AppProviderConfig, error) {
	if s.cache != nil {
		var cached []domain.AppProviderConfig
		if s.cache.Get(ctx, appProviderConfigsKey, &cached) {
			return cached, nil
		}
	}
	configs, err := s.repo.ListEnabledProviderConfigs(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list provider configs", err)
	}
	if s.cache != nil {
		s.cache.Set(ctx, appProviderConfigsKey, configs, 45*time.Second)
	}
	return configs, nil
}

// ─── Generation ─────────────────────────────────────────────────────────────

// GenerateRequest carries the user's generation request.
type VideoTrimRange struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type VideoCropRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type GenerateRequest struct {
	ServiceType      string // image / text / video / audio
	ProviderConfigID string // optional exact provider_config id selected by frontend
	Model            string // e.g. "gpt-image-2"
	Prompt           string
	Size             string // ratio like "1:1", "16:9", "auto"
	Resolution       string // image: "1k"/"2k"/"4k"; video: "480p"/"720p"
	Quality          string // image quality: auto / high / medium / low
	EditOperation    string
	MaskImage        string
	OutputCount      int
	ExpandDirection  string
	DeriveFromNodeID string
	TrimRange        *VideoTrimRange
	CropRect         *VideoCropRect
	TargetTracks     []string
	OutputFormat     string
	Parameters       map[string]any
	Duration         int    // video duration in seconds
	AspectRatio      string // video aspect ratio: "16:9", "9:16", etc.
	ReferenceImages  []string
	ReferenceVideo   string
	ReferenceVideos  []string
	ReferenceMode    string // auto / start_frame / start_end / image_reference / motion_mimic / video_edit
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
	// RequestID is the client-supplied idempotency key (F6). When set, the
	// enqueue path uses it as both the generation_logs.request_id unique key
	// and the Asynq TaskID, so a duplicate submit dedupes to one task.
	RequestID string
	// CreditCost is the number of credits reserved for this generation at
	// submit time (resolved from the provider config's per-model price).
	// Persisted in request_payload so the worker/reaper can refund the exact
	// amount on a terminal failure.
	CreditCost int32
}

// GenerateResult carries the generation result.
type GenerateResult struct {
	Type    string `json:"type"`    // "text" or "url"
	Content string `json:"content"` // text content or image URL
}

// candidateChannel is a provider that matched the request's (service_type,
// model) tuple along with its decrypted API key. Built by buildCandidates
// so Generate can dispatch the request without mutating channel health.
type candidateChannel struct {
	cfg     *domain.ProviderConfig
	baseURL string
	apiKey  string
}

// buildCandidates returns the first enabled provider that could serve req,
// in the existing priority order. We intentionally avoid automatic
// fallback/switching here; a failure is surfaced back to the caller and the
// admin UI can alarm on repeated errors instead of the router silently
// rerouting elsewhere.
func (s *Service) buildCandidates(req GenerateRequest) ([]candidateChannel, error) {
	configs, err := s.repo.ListProviderConfigs(context.Background())
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list configs", err)
	}
	for i := range configs {
		c := configs[i]
		if req.ProviderConfigID != "" && c.ID != req.ProviderConfigID {
			continue
		}
		if c.Status != "enabled" {
			continue
		}
		if req.ServiceType != "" && c.ServiceType != req.ServiceType {
			continue
		}
		if req.ServiceType != "" && !providerSupportsCapability(c, req.ServiceType) {
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
		return []candidateChannel{cand}, nil
	}
	return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("No enabled provider found for model %q", req.Model))
}

func providerSupportsCapability(c domain.ProviderConfig, serviceType string) bool {
	if len(c.Capabilities) == 0 {
		return true
	}
	for _, capability := range c.Capabilities {
		if strings.EqualFold(strings.TrimSpace(capability), serviceType) {
			return true
		}
	}
	return false
}

// dispatchToVendor runs ONE attempt against the supplied channel by
// routing to the existing vendor-specific helper. Centralizes the switch
// so the fallback loop in Generate doesn't have to duplicate it.
func (s *Service) dispatchToVendor(ctx context.Context, c candidateChannel, req GenerateRequest) (*GenerateResult, error) {
	// NewAPI gateway fast path. When configured at boot, text generation
	// bypasses the per-provider direct call and goes through the unified
	// OpenAI-compatible endpoint. Channel-health bookkeeping (in
	// recordChannelOutcome) still runs against the original candidate so
	// the admin UI's per-vendor view stays meaningful during the
	// transition — we'll collapse that to a single NewAPI health probe
	// once image/video are also migrated.
	if s.newAPI != nil && s.newAPI.Configured() && c.cfg.ServiceType == "text" && strings.TrimSpace(c.cfg.BaseURL) == "" {
		return s.generateTextViaNewAPI(ctx, req)
	}
	if isTSProvider(c.cfg) {
		return s.runTSProvider(ctx, c.cfg, c.baseURL, c.apiKey, req)
	}

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

// generateTextViaNewAPI is the NewAPI-routed counterpart to
// generateText. The legacy generateText posts directly to the provider's
// {baseURL}/chat/completions; this one posts to the gateway's
// /chat/completions instead — same schema, single auth token, no vendor
// fan-out logic needed.
func (s *Service) generateTextViaNewAPI(ctx context.Context, req GenerateRequest) (*GenerateResult, error) {
	resp, err := s.newAPI.Chat(ctx, ChatRequest{
		Model: req.Model,
		Messages: []ChatMessage{
			{Role: "user", Content: req.Prompt},
		},
		MaxTokens: 2048,
	})
	if err != nil {
		return nil, err
	}
	return &GenerateResult{
		Type:    "text",
		Content: resp.Choices[0].Message.Content,
	}, nil
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

type generatedAssetPersistenceOutcome struct {
	cacheHit bool
	pending  bool
}

func (s *Service) persistGeneratedAssetForResult(ctx context.Context, req GenerateRequest, result *GenerateResult, startedAt time.Time, c candidateChannel) (generatedAssetPersistenceOutcome, error) {
	out := generatedAssetPersistenceOutcome{cacheHit: true}
	if result == nil || result.Type != "url" || strings.TrimSpace(result.Content) == "" {
		return out, nil
	}

	originalURL := strings.TrimSpace(result.Content)
	staged, err := StageRemoteAssetWithProviderAuth(ctx, originalURL, c.baseURL, c.apiKey)
	if err != nil {
		out.cacheHit = false
		log.Printf("[modelcatalog] WARNING asset staging failed for log %s; keeping temporary upstream URL: %v", req.GenerationLogID, err)
		return out, nil
	}
	if staged.LocalPath == "" {
		if staged.StagingURL == originalURL && isTemporaryGeneratedAssetURL(originalURL) {
			out.cacheHit = false
			log.Printf("[modelcatalog] WARNING generated media for log %s stayed on a temporary upstream URL", req.GenerationLogID)
			return out, nil
		}
		result.Content = staged.StagingURL
		return out, nil
	}
	cachedURL, err := PromoteStagedAssetToStore(ctx, staged)
	if err == nil {
		result.Content = cachedURL
		return out, nil
	}

	out.cacheHit = false
	out.pending = true
	result.Content = staged.StagingURL
	duration := time.Since(startedAt)
	if s.repo != nil && req.GenerationLogID != "" {
		if perr := s.repo.MarkGenerationLogPersisting(ctx, req.GenerationLogID, staged, int32(duration.Milliseconds())); perr != nil {
			return out, fmt.Errorf("asset persistence failed: generated media staged locally but persisting status could not be saved: %w", perr)
		}
		if s.cache != nil {
			s.cache.Delete(ctx, generationTaskCacheKey(req.GenerationLogID))
		}
	}
	s.publishTaskEventWithStatus(req, result, nil, duration, "persisting")
	if s.assetQueue != nil && req.GenerationLogID != "" {
		_, qerr := s.assetQueue.EnqueueAssetPersist(context.Background(), AssetPersistPayload{
			LogID:       req.GenerationLogID,
			UserID:      req.UserID,
			NodeID:      req.NodeID,
			ServiceType: req.ServiceType,
			StagingPath: staged.LocalPath,
			StagingURL:  staged.StagingURL,
			COSKey:      staged.COSKey,
			ContentType: staged.ContentType,
		})
		if qerr != nil {
			log.Printf("[modelcatalog] WARNING asset persist enqueue failed for log %s; staged file retained: %v", req.GenerationLogID, qerr)
		}
	}
	log.Printf("[modelcatalog] asset staged for log %s but COS promotion failed; queued background persist: %v", req.GenerationLogID, err)
	return out, nil
}

func isTemporaryGeneratedAssetURL(rawURL string) bool {
	trimmed := strings.TrimSpace(rawURL)
	return strings.HasPrefix(trimmed, "http://") ||
		strings.HasPrefix(trimmed, "https://") ||
		strings.HasPrefix(trimmed, "data:") ||
		strings.HasPrefix(trimmed, "blob:")
}

func (s *Service) Generate(callerCtx context.Context, req GenerateRequest) (*GenerateResult, error) {
	candidates, err := s.buildCandidates(req)
	if err != nil {
		// No provider → terminal before any work. Guard the transition so the
		// reaper can't also refund this same (still-'pending') row later.
		if s.persistTerminalFailure(req.GenerationLogID, err.Error(), 0) {
			s.RefundCredits(context.Background(), req.UserID, req.CreditCost, "refund: no provider "+req.GenerationLogID)
		}
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

		// Try to cache the upstream URL before surfacing success. If staging
		// fails, keep the provider URL visible and mark cache_hit=false; a
		// generated image/video should not be turned into a failed task just
		// because durable asset archival hit a temporary download problem.
		cacheHit := true
		assetPending := false
		if runErr == nil {
			assetOutcome, cacheErr := s.persistGeneratedAssetForResult(detachedCtx, req, result, startedAt, candidates[0])
			cacheHit = assetOutcome.cacheHit
			assetPending = assetOutcome.pending
			if cacheErr != nil {
				runErr = cacheErr
				result = nil
				log.Printf("[modelcatalog] ERROR asset staging failed for log %s: %v", req.GenerationLogID, cacheErr)
			}
		}

		// Persist the outcome ourselves. The handler used to do this, but
		// now the handler may have already returned to the client by the
		// time we finish — so the goroutine owns the lifecycle write.
		duration := time.Since(startedAt)
		// Gate the SSE push on a durable write (F8) so we never emit an
		// event that disagrees with the persisted source of truth.
		if assetPending {
			doneCh <- genResult{result: result, err: nil}
			return
		}
		// Legacy inline path runs once (no Asynq retry), so any error here is
		// terminal. Route the failure through the guarded transition so the
		// refund fires exactly once (the reaper may also try if our write was
		// lost); the success path keeps the unconditional outcome write.
		if runErr != nil {
			if s.persistTerminalFailure(req.GenerationLogID, runErr.Error(), duration) {
				s.publishTaskEvent(req, nil, runErr, duration)
				s.RefundCredits(context.Background(), req.UserID, req.CreditCost, "refund: generation failed "+req.GenerationLogID)
			}
		} else if perr := s.persistGenerationOutcome(req.GenerationLogID, result, nil, duration, cacheHit); perr == nil {
			s.publishTaskEvent(req, result, nil, duration)
		}

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

// GenerateInline runs the same pipeline as Generate's inner goroutine
// but synchronously, using the passed-in ctx for cancellation. Intended
// for callers that have their own durable execution context — e.g. the
// Asynq worker in /backend/internal/tasks. Returns when:
//   - the upstream call succeeds and persistence completed, OR
//   - the upstream call failed and the failure was persisted, OR
//   - ctx was cancelled (worker shutdown / Asynq cancel)
//
// Unlike Generate, this method does NOT spawn a detached background
// goroutine. The caller (Asynq) is itself the durable execution context;
// any retry-on-error decision is owned by Asynq via its returned error.
//
// Persistence contract (F1+F2): GenerateInline persists + publishes only
// the *terminal success* outcome. It deliberately does NOT persist or
// publish on failure — that decision belongs to the caller, which knows
// whether the failure is permanent or will be retried. A transient
// failure that Asynq will retry must leave the log row as-is ('running')
// and emit no SSE 'error', otherwise the node flashes to error and then
// flips back on a later successful retry. The worker calls FinalizeFailure
// once it decides the failure is terminal (permanent, or retries
// exhausted).
func (s *Service) GenerateInline(ctx context.Context, req GenerateRequest) (*GenerateResult, error) {
	candidates, err := s.buildCandidates(req)
	if err != nil {
		// Operator-config error (no candidate). Permanent — but leave the
		// terminal write to the caller so all failure persistence flows
		// through one path.
		return nil, err
	}
	startedAt := time.Now()
	result, runErr := s.runCandidateLoop(ctx, candidates, req)
	if runErr != nil {
		return result, runErr
	}
	cacheHit := true
	assetOutcome, cacheErr := s.persistGeneratedAssetForResult(ctx, req, result, startedAt, candidates[0])
	cacheHit = assetOutcome.cacheHit
	if cacheErr != nil {
		log.Printf("[modelcatalog] ERROR asset staging failed for log %s: %v", req.GenerationLogID, cacheErr)
		return nil, cacheErr
	}
	if assetOutcome.pending {
		return result, nil
	}
	if false && result != nil && result.Type == "url" && result.Content != "" {
		if cachedURL, cacheErr := PersistRemoteAsset(ctx, result.Content); cacheErr == nil {
			result.Content = cachedURL
		} else {
			// F9: caching failed — we're keeping the provider's signed URL,
			// which will 404 once it expires. Record cache_hit=false and log
			// loudly so this asset rot is queryable + visible to ops.
			cacheHit = false
			log.Printf("[modelcatalog] WARNING asset cache failed for log %s, keeping ephemeral URL (may expire): %v", req.GenerationLogID, cacheErr)
		}
	}
	duration := time.Since(startedAt)
	// Gate the SSE push on a durable write (F8): if the DB write fails after
	// a retry, don't publish 'success' — the recovery poller will reconcile
	// from the real DB state once the reaper/next write settles it, avoiding
	// an event that contradicts the source of truth.
	if perr := s.persistGenerationOutcome(req.GenerationLogID, result, nil, duration, cacheHit); perr == nil {
		s.publishTaskEvent(req, result, nil, duration)
	}
	return result, nil
}

// FinalizeFailure writes a terminal failure to generation_logs and pushes
// the error to the user's SSE subscribers. The Asynq worker calls this
// once it has decided the failure will not be retried — either because the
// error is permanent (bad input, auth) or because the retry budget is
// exhausted. Keeping this out of GenerateInline lets transient failures be
// retried silently without flashing the node to 'error' first.
func (s *Service) FinalizeFailure(req GenerateRequest, err error, duration time.Duration) {
	// Guard-transition the row to 'error'. We publish SSE and refund ONLY when
	// this call actually performed the transition. If the reaper (or any other
	// terminal path) already finalized this row, the guarded UPDATE is a no-op
	// and we skip the refund — closing the worker-vs-reaper double-refund.
	if s.persistTerminalFailure(req.GenerationLogID, err.Error(), duration) {
		s.publishTaskEvent(req, nil, err, duration)
		s.RefundCredits(context.Background(), req.UserID, req.CreditCost, "refund: generation failed "+req.GenerationLogID)
	}
}

// persistTerminalFailure writes a guarded terminal-failure outcome and reports
// whether THIS call transitioned the row from an active state to 'error'. The
// status-guarded UPDATE is a no-op when the row is already terminal, so a
// refund gated on the returned bool fires exactly once even when several
// failure paths (the worker's FinalizeFailure and the reaper) race on the same
// task. Returns true when no persistence is wired (logID=="" / no repo) so
// legacy and unit-test refund behavior is preserved. On a persistent write
// error it returns false: we don't know whether we own the transition, so we
// decline the refund and let the reaper's guarded path own it later — never
// double-refunding.
func (s *Service) persistTerminalFailure(logID, errMsg string, duration time.Duration) bool {
	if logID == "" || s.repo == nil {
		return true
	}
	for attempt := 1; attempt <= 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		transitioned, err := s.repo.MarkGenerationLogFailed(ctx, logID, errMsg, int32(duration.Milliseconds()))
		if s.cache != nil {
			s.cache.Delete(ctx, generationTaskCacheKey(logID))
		}
		cancel()
		if err == nil {
			return transitioned
		}
		log.Printf("[modelcatalog] mark-failed write failed for log %s (attempt %d/2): %v", logID, attempt, err)
	}
	return false
}

func (s *Service) PromoteStagedAssetForLog(ctx context.Context, p AssetPersistPayload) error {
	if p.LogID == "" {
		return fmt.Errorf("missing generation log id")
	}
	staged := StagedAsset{
		LocalPath:   p.StagingPath,
		StagingURL:  p.StagingURL,
		COSKey:      p.COSKey,
		ContentType: p.ContentType,
	}
	cosURL, err := PromoteStagedAssetToStore(ctx, staged)
	if err != nil {
		if s.repo != nil {
			_ = s.repo.MarkGenerationLogAssetFailed(context.Background(), p.LogID, "persisting", err.Error())
		}
		return err
	}
	if s.repo != nil {
		if err := s.repo.MarkGenerationLogAssetReady(ctx, p.LogID, cosURL, 0); err != nil {
			return err
		}
		if s.cache != nil {
			s.cache.Delete(ctx, generationTaskCacheKey(p.LogID))
		}
	}
	s.publishTaskEvent(GenerateRequest{
		GenerationLogID: p.LogID,
		UserID:          p.UserID,
		NodeID:          p.NodeID,
		ServiceType:     p.ServiceType,
	}, &GenerateResult{Type: "url", Content: cosURL}, nil, 0)
	return nil
}

// reaperFloor is the smallest per-type runtime budget; the reaper's DB
// pre-filter uses it so we never scan rows that can't possibly be stale.
const reaperFloor = 5 * time.Minute

// ReapStaleGenerations is the final backstop (F3) for tasks whose executor
// vanished without writing an outcome — an OOM-killed Asynq worker, a
// crashed legacy inline goroutine, or a persist write that failed twice.
// Such rows would otherwise sit 'running' forever and spin the node's UI
// indefinitely. It marks each abandoned row 'error' (guarded so a genuine
// late success is never clobbered) and pushes the terminal error over SSE.
// Returns the number of rows reaped. Safe to call on a timer regardless of
// whether the Asynq queue is enabled.
func (s *Service) ReapStaleGenerations(ctx context.Context) (int, error) {
	if s.repo == nil {
		return 0, nil
	}
	rows, err := s.repo.ListStaleActiveGenerations(ctx, time.Now().Add(-reaperFloor))
	if err != nil {
		return 0, err
	}
	reaped := 0
	for _, row := range rows {
		// Generous budget so a task legitimately mid-retry (Asynq retries
		// up to 5x with backoff) isn't reaped early: 2x the single-attempt
		// runtime cap plus a 30-minute grace.
		budget := 2*maxRuntimeForType(row.ServiceType) + 30*time.Minute
		age := time.Since(row.CreatedAt)
		if age < budget {
			continue
		}
		msg := fmt.Sprintf("task abandoned: stuck in %q for %s with no result (executor lost)", row.Status, age.Round(time.Second))
		updated, merr := s.repo.MarkGenerationTimedOut(ctx, row.ID, msg)
		if merr != nil {
			log.Printf("[modelcatalog] reaper failed to mark log %s: %v", row.ID, merr)
			continue
		}
		if !updated {
			continue // task finished between SELECT and UPDATE — leave it
		}
		reaped++
		if s.cache != nil {
			s.cache.Delete(ctx, generationTaskCacheKey(row.ID))
		}
		// Notify the UI so the node flips from spinning to error.
		s.publishTaskEvent(GenerateRequest{
			GenerationLogID: row.ID,
			UserID:          row.UserID,
			NodeID:          row.NodeID,
			ServiceType:     row.ServiceType,
		}, nil, errors.New(msg), age)
		// Refund the credits reserved for this abandoned task.
		s.RefundCredits(ctx, row.UserID, row.CreditCost, "refund: task reaped "+row.ID)
	}
	if reaped > 0 {
		log.Printf("[modelcatalog] reaper marked %d stale generation(s) as error", reaped)
	}
	return reaped, nil
}

// runCandidateLoop dispatches a single request to the chosen provider.
// We no longer auto-switch channels on failure; the same provider should
// keep handling the model until an operator changes the config.
func (s *Service) runCandidateLoop(ctx context.Context, candidates []candidateChannel, req GenerateRequest) (*GenerateResult, error) {
	if len(candidates) == 0 {
		return nil, apperror.New(apperror.CodeInvalidInput, "No provider candidate available")
	}
	c := candidates[0]
	started := time.Now()
	result, err := s.dispatchToVendor(ctx, c, req)
	duration := int(time.Since(started).Milliseconds())
	s.recordChannelOutcome(ctx, req, c, 1, err, duration)
	return result, err
}

// persistGenerationOutcome writes the final status/result/error to the
// generation_logs row. Uses a fresh background context with a small
// budget so the write succeeds even when the detached ctx has expired
// from its own maxRuntime cap.
//
// F8: a write failure used to be swallowed silently, which left the row
// stuck at 'running' while an SSE 'success' still went out — a split-brain
// between the event and the source of truth. We now retry the write once
// and report the final error to callers, so the SSE publish can be gated
// on a durable write. The stale-task reaper (F3) is the final backstop if
// both attempts fail.
func (s *Service) persistGenerationOutcome(logID string, result *GenerateResult, err error, duration time.Duration, cacheHit bool) error {
	if logID == "" || s.repo == nil {
		return nil
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

	var writeErr error
	for attempt := 1; attempt <= 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		writeErr = s.repo.UpdateGenerationLogResult(ctx, logID, status, resultURL, errMsg, int32(duration.Milliseconds()), cacheHit)
		if s.cache != nil {
			s.cache.Delete(ctx, generationTaskCacheKey(logID))
		}
		cancel()
		if writeErr == nil {
			return nil
		}
		log.Printf("[modelcatalog] persist outcome failed for log %s (attempt %d/2, status=%s): %v", logID, attempt, status, writeErr)
	}
	return writeErr
}

// publishTaskEvent emits a TaskEvent to all SSE subscribers of the user
// who initiated this generation. Skips silently when no event bus is
// wired or no userID was attached (e.g. anonymous-tested generations).
func (s *Service) publishTaskEvent(req GenerateRequest, result *GenerateResult, err error, duration time.Duration) {
	s.publishTaskEventWithStatus(req, result, err, duration, "")
}

func (s *Service) publishTaskEventWithStatus(req GenerateRequest, result *GenerateResult, err error, duration time.Duration, forcedStatus string) {
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
	if forcedStatus != "" {
		status = forcedStatus
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
		code := errorCodeFromMessage(errMsg, httpStatus)
		s.CreateAdminAlert(ctx, domain.AdminAlert{
			ProviderConfigID: c.cfg.ID,
			GenerationLogID:  req.GenerationLogID,
			ServiceType:      c.cfg.ServiceType,
			Model:            req.Model,
			ErrorCode:        code,
			ErrorMessage:     errMsg,
			Source:           alertSourceForError(errMsg),
			Severity:         alertSeverityForErrorCode(code),
		})
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
	schema := providerImageParameterSchema(pc, req.Model)
	if len(req.ReferenceImages) > 0 && ResolveProfile(pc).ID == "custom" && !isChatCompletionsReferenceImageSchema(schema) {
		editPath := strings.ToLower(strings.TrimSpace(resolveImageEditPath(pc)))
		if !strings.Contains(editPath, "edit") {
			return nil, apperror.New(apperror.CodeInvalidInput, "Reference images were provided, but the selected provider is configured for text-to-image only. Configure a chat-image or image-edit endpoint.")
		}
	}
	if isChatCompletionsImageSchema(schema) {
		return s.generateImageViaChatCompletions(ctx, pc, baseURL, apiKey, req, schema)
	}
	if len(req.ReferenceImages) > 0 && isChatCompletionsReferenceImageSchema(schema) {
		return s.generateImageViaChatCompletions(ctx, pc, baseURL, apiKey, req, schema)
	}
	// Image-to-image (ref + prompt) requires the multipart /images/edits endpoint —
	// the standard /images/generations is text-only and silently ignores reference
	// fields, which previously produced visually unrelated outputs.
	if len(req.ReferenceImages) > 0 {
		return s.generateImageEdit(ctx, pc, baseURL, apiKey, req)
	}
	return s.generateImageTextOnly(ctx, pc, baseURL, apiKey, req)
}

func requestedImageCount(req GenerateRequest) int {
	if req.OutputCount > 0 {
		return req.OutputCount
	}
	return 1
}

// generateImageVolcengine talks to Volcengine ark's /images/generations.
// The endpoint URL matches OpenAI but the accepted payload fields are
// different — passing OpenAI-only fields like `quality` / `background` /
// `output_format` makes ark close the connection (manifesting as EOF in Go).
// Reference images go in an `image` field (string or []string), not via a
// separate multipart `/images/edits` endpoint.
func (s *Service) generateImageVolcengine(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	size := mapAspectRatioToVolcengineSize(req.Model, req.Size, req.Quality)
	submitPath := resolveImageGenPath(pc)

	body := map[string]interface{}{
		"model":  req.Model,
		"prompt": req.Prompt,
		"size":   size,
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
	resp, err := doProviderRequestWithRetry(ctx, client, httpReq, bodyJSON)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, providerRequestErrorMessage(err), err)
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
	width, height = ensureVolcengineMinimumImageArea(width, height)

	return fmt.Sprintf("%dx%d", int(width), int(height))
}

func ensureVolcengineMinimumImageArea(width, height float64) (float64, float64) {
	const minPixels = 3686400.0 // Ark rejects smaller custom pixel sizes.
	if width <= 0 || height <= 0 || width*height >= minPixels {
		return width, height
	}
	scale := math.Sqrt(minPixels / (width * height))
	width = roundUpToMultiple(width*scale, 16)
	height = roundUpToMultiple(height*scale, 16)
	for width*height < minPixels {
		if width <= height {
			width += 16
		} else {
			height += 16
		}
	}
	return width, height
}

func roundToMultiple(value, step float64) float64 {
	if step <= 0 {
		return value
	}
	return math.Round(value/step) * step
}

func roundUpToMultiple(value, step float64) float64 {
	if step <= 0 {
		return value
	}
	return math.Ceil((value-1e-6)/step) * step
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
	transport.DisableKeepAlives = true
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

func doProviderRequestWithRetry(ctx context.Context, client *http.Client, req *http.Request, body []byte) (*http.Response, error) {
	var lastErr error
	for attempt := 1; attempt <= providerRequestMaxAttempts; attempt++ {
		clone := req.Clone(ctx)
		clone.Body = io.NopCloser(bytes.NewReader(body))
		clone.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}

		resp, err := client.Do(clone)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt == providerRequestMaxAttempts || !isRetryableProviderNetworkError(err) {
			break
		}
		if closer, ok := client.Transport.(interface{ CloseIdleConnections() }); ok {
			closer.CloseIdleConnections()
		}
		delay := time.Duration(attempt*attempt) * time.Second
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

// isRequestDeadlineTimeout reports whether err is a *request-level* timeout
// — the client gave up while awaiting the upstream response (Go's
// http.Client.Timeout / a context deadline). This is fundamentally
// different from a pre-send connection failure (dial/TLS handshake/reset):
// by the time a request deadline fires we have already sent the request and
// the upstream may have completed it. For a synchronous, non-idempotent,
// paid generation (image/video/audio) that means retrying would
// re-generate and re-charge while the original result is unrecoverable — so
// these timeouts must NOT be retried. Exported so the Asynq worker can make
// the same non-retry decision at its layer.
func IsRequestDeadlineTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "client.timeout exceeded") ||
		strings.Contains(msg, "context deadline exceeded") ||
		strings.Contains(msg, "awaiting headers")
}

func isRetryableProviderNetworkError(err error) bool {
	if err == nil {
		return false
	}
	// Request-level timeout: the upstream may have already done the work
	// (and, for a sync media call, produced an unrecoverable result). Never
	// retry — see isRequestDeadlineTimeout.
	if IsRequestDeadlineTimeout(err) {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) && errors.Is(urlErr.Err, io.EOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "tls handshake timeout") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "eof") ||
		strings.Contains(msg, "server closed") ||
		strings.Contains(msg, "unexpected eof")
}

func providerRequestErrorMessage(err error) string {
	if err == nil {
		return "Provider request failed"
	}
	if isRetryableProviderNetworkError(err) {
		return fmt.Sprintf("Provider request failed after %d attempts: upstream connection was closed or timed out (%v)", providerRequestMaxAttempts, err)
	}
	return fmt.Sprintf("Provider request failed: %v", err)
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

func (s *Service) generateImageViaChatCompletions(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest, schema providerParameterSchema) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	submitPath := resolveImageGenPath(pc)
	if pc != nil && strings.TrimSpace(pc.SubmitEndpoint) != "" {
		submitPath = strings.TrimSpace(pc.SubmitEndpoint)
	}
	if strings.TrimSpace(submitPath) == "" || strings.Contains(strings.ToLower(submitPath), "/images/generations") || isChatCompletionsReferenceImageSchema(schema) {
		submitPath = "/chat/completions"
	}
	allowed := allowParams(allowedParamSet(schema.AllowedParameters), "model", "messages", "stream")
	body := map[string]interface{}{
		"model":  req.Model,
		"stream": false,
	}
	for key, value := range schema.Defaults {
		if value != nil {
			body[key] = value
		}
	}
	applyImageParameterAliases(body, allowed, schema, req)
	mergeAllowedParameters(body, allowed, req.Parameters)
	applyProviderModelRoutes(body, schema)

	content := []map[string]interface{}{
		{"type": "text", "text": req.Prompt},
	}
	for i, raw := range req.ReferenceImages {
		ref := strings.TrimSpace(raw)
		if ref == "" {
			continue
		}
		if !strings.HasPrefix(ref, "http://") && !strings.HasPrefix(ref, "https://") {
			return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("ManjuAPI image reference #%d must be a public http(s) URL", i+1))
		}
		content = append(content, map[string]interface{}{
			"type": "image_url",
			"image_url": map[string]interface{}{
				"url": ref,
			},
		})
	}
	body["messages"] = []map[string]interface{}{
		{"role": "user", "content": content},
	}
	pruneUnsupportedParameters(body, allowed)
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := newProviderHTTPClient(imageGenerationTimeout())
	resp, err := doProviderRequestWithRetry(ctx, client, httpReq, bodyJSON)
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
	// Synchronous result first: if the gateway already put the image in the
	// chat response (content markdown or data[].url), use it directly.
	if result, perr := parseChatImageGenerationResponse(respBody); perr == nil {
		return result, nil
	}
	// Otherwise this is an async task stub (Manju 图生图 returns an empty
	// chat.completion with the task id in `id`/`task_id`). Poll until the
	// image is ready instead of failing fast — the gateway finishes in
	// ~2-5 min, and failing here just makes the user re-submit (duplicate
	// generation + double charge).
	if taskID := extractImageTaskID(respBody); taskID != "" {
		return s.pollImageTask(ctx, baseURL, apiKey, resolveImageQueryPath(pc), taskID, extractImageTaskPollURL(respBody))
	}
	// Neither a usable image nor a task id — surface the raw response.
	return parseChatImageGenerationResponse(respBody)
}

func (s *Service) generateImageTextOnly(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	baseURL = resolveProfileBaseURL(pc, baseURL)
	size := mapAspectRatioToOpenAIImageSize(req.Size)
	submitPath := resolveImageGenPath(pc)
	queryPath := resolveImageQueryPath(pc)

	schema := providerImageParameterSchema(pc, req.Model)
	quality := normalizeProviderImageQuality(req.Quality, schema)
	allowed := allowedParamSet(schema.AllowedParameters)
	body := map[string]interface{}{
		"model":  req.Model,
		"prompt": req.Prompt,
		"n":      requestedImageCount(req),
	}
	for key, value := range schema.Defaults {
		if value != nil {
			body[key] = value
		}
	}
	setAllowedParameter(body, allowed, "size", size)
	setAllowedParameter(body, allowed, "quality", quality)
	if strings.TrimSpace(req.OutputFormat) != "" {
		body["output_format"] = strings.TrimSpace(req.OutputFormat)
	}
	applyImageParameterAliases(body, allowed, schema, req)
	mergeAllowedParameters(body, allowed, req.Parameters)
	applyProviderModelRoutes(body, schema)
	pruneUnsupportedParameters(body, allowed)
	bodyJSON, _ := json.Marshal(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resolveProviderURL(baseURL, submitPath), strings.NewReader(string(bodyJSON)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := newProviderHTTPClient(imageGenerationTimeout())
	resp, err := doProviderRequestWithRetry(ctx, client, httpReq, bodyJSON)
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
		return s.pollImageTask(ctx, baseURL, apiKey, queryPath, taskID, "")
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
	if strings.TrimSpace(req.MaskImage) != "" {
		maskDataURL, err := localPathToDataURL(req.MaskImage)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to load edit mask", err)
		}
		var maskBytes []byte
		if strings.HasPrefix(maskDataURL, "data:") {
			if idx := strings.Index(maskDataURL, "base64,"); idx > 0 {
				decoded, derr := base64.StdEncoding.DecodeString(maskDataURL[idx+len("base64,"):])
				if derr != nil {
					return nil, apperror.Wrap(apperror.CodeInternal, "Failed to decode edit mask", derr)
				}
				maskBytes = decoded
			}
		} else if strings.HasPrefix(maskDataURL, "http://") || strings.HasPrefix(maskDataURL, "https://") {
			maskBytes, err = fetchRemoteReferenceBytes(ctx, maskDataURL)
			if err != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, "Failed to fetch edit mask", err)
			}
		}
		if len(maskBytes) == 0 {
			return nil, apperror.New(apperror.CodeInternal, "Edit mask resolved to empty bytes")
		}
		maskPart, err := mw.CreateFormFile("mask", "mask.png")
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build mask multipart", err)
		}
		if _, err := maskPart.Write(maskBytes); err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to write mask multipart image", err)
		}
	}
	_ = mw.WriteField("model", req.Model)
	_ = mw.WriteField("prompt", req.Prompt)
	_ = mw.WriteField("n", strconv.Itoa(requestedImageCount(req)))
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
	resp, err := doProviderRequestWithRetry(ctx, client, httpReq, body.Bytes())
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
		return s.pollImageTask(ctx, baseURL, apiKey, queryPath, taskID, "")
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

func parseImageDataEntries(respBody []byte) (*GenerateResult, bool, error) {
	var result struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil || len(result.Data) == 0 {
		return nil, false, nil
	}
	if result.Data[0].URL != "" {
		return &GenerateResult{Type: "url", Content: result.Data[0].URL}, true, nil
	}
	if result.Data[0].B64JSON != "" {
		return &GenerateResult{Type: "url", Content: "data:image/png;base64," + result.Data[0].B64JSON}, true, nil
	}
	return nil, true, apperror.New(apperror.CodeInternal, "Provider returned an image entry with neither url nor b64_json")
}

// parseImageGenerationResponse extracts a usable URL or b64_json from an
// OpenAI-style image response. Shared by text-only and edit code paths.
func parseImageGenerationResponse(respBody []byte) (*GenerateResult, error) {
	if taskID := extractImageTaskID(respBody); taskID != "" {
		return nil, apperror.New(apperror.CodeInternal, "Async task path not supported in edit mode yet; got task_id="+taskID)
	}
	if result, ok, err := parseImageDataEntries(respBody); ok {
		return result, err
	}
	return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unexpected provider response: %s", string(respBody[:min(len(respBody), 400)])))
}

var markdownImageURLPattern = regexp.MustCompile(`!\[[^\]]*\]\((https?://[^)\s]+)\)`)
var plainImageURLPattern = regexp.MustCompile(`https?://[^\s)]+`)

func parseChatImageGenerationResponse(respBody []byte) (*GenerateResult, error) {
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &result); err == nil && len(result.Choices) > 0 {
		content := strings.TrimSpace(result.Choices[0].Message.Content)
		if content != "" {
			if match := markdownImageURLPattern.FindStringSubmatch(content); len(match) == 2 {
				return &GenerateResult{Type: "url", Content: match[1]}, nil
			}
			if match := plainImageURLPattern.FindString(content); match != "" {
				return &GenerateResult{Type: "url", Content: strings.TrimRight(match, ".,;")}, nil
			}
		}
	}
	if result, ok, err := parseImageDataEntries(respBody); ok {
		return result, err
	}
	return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Unexpected provider response: %s", string(respBody[:min(len(respBody), 400)])))
}

func extractImageTaskID(respBody []byte) string {
	var taskCheck map[string]interface{}
	if err := json.Unmarshal(respBody, &taskCheck); err != nil {
		return ""
	}
	if id, ok := taskCheck["task_id"].(string); ok && strings.TrimSpace(id) != "" {
		return strings.TrimSpace(id)
	}
	// Manju/NewAPI chat-image async stub: when 图生图 (POST /chat/completions)
	// is still processing, the gateway returns a chat.completion with empty
	// content and the task id embedded in the top-level `id`, e.g.
	// "chatcmpl-gemini-img-XXXX". The task-query endpoint
	// (GET /v1/tasks/{task_id}) expects the bare id, so strip the chatcmpl-
	// prefix. Gated on an "-img-" segment so a normal text chat.completion
	// id ("chatcmpl-abc123") is never mistaken for an image task.
	if id, ok := taskCheck["id"].(string); ok {
		id = strings.TrimSpace(id)
		bare := strings.TrimPrefix(id, "chatcmpl-")
		if strings.Contains(bare, "-img-") || strings.HasPrefix(bare, "img-") {
			return bare
		}
	}
	return ""
}

func extractImageTaskPollURL(respBody []byte) string {
	var taskCheck map[string]interface{}
	if err := json.Unmarshal(respBody, &taskCheck); err != nil {
		return ""
	}
	if pollURL, ok := taskCheck["poll_url"].(string); ok && strings.TrimSpace(pollURL) != "" {
		return strings.TrimSpace(pollURL)
	}
	return ""
}

// pollImageTask polls an async image generation task until it completes or times out.
func (s *Service) pollImageTask(ctx context.Context, baseURL, apiKey, queryPath, taskID, pollURL string) (*GenerateResult, error) {
	client := &http.Client{Timeout: 30 * time.Second}

	// Try multiple URL patterns used by various providers.
	// apimart.ai uses GET /v1/tasks/{task_id}
	pollURLs := make([]string, 0, 4)
	if strings.TrimSpace(pollURL) != "" {
		pollURLs = append(pollURLs, resolveProviderURL(baseURL, strings.TrimSpace(pollURL)))
	}
	if strings.TrimSpace(queryPath) != "" {
		pollURLs = append(pollURLs, resolveProviderURL(baseURL, strings.ReplaceAll(queryPath, "{taskId}", taskID)))
	}
	// Fallback patterns when the response didn't carry a usable poll_url.
	// Manju/NewAPI serves task status at {host}/api/tasks/{id} (note: /api,
	// not the /v1 generation prefix), so derive the host root too.
	hostRoot := baseURL
	if i := strings.Index(hostRoot, "/v1"); i > 0 {
		hostRoot = hostRoot[:i]
	}
	pollURLs = append(pollURLs,
		strings.TrimRight(hostRoot, "/")+"/api/tasks/"+taskID,
		baseURL+"/tasks/"+taskID,
		baseURL+"/images/generations/"+taskID,
		baseURL+"/async/tasks/"+taskID,
	)

	// Wait before first poll per upstream docs, then poll at a fixed interval.
	select {
	case <-ctx.Done():
		return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
	case <-time.After(imageTaskPollInitialDelay):
	}

	for i := 0; i < imageTaskPollMaxAttempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, apperror.New(apperror.CodeInternal, "Generation timed out")
			case <-time.After(imageTaskPollInterval):
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
				if status, _ := generic["status"].(string); status == "failed" || status == "error" {
					return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
				}
				if data, ok := generic["data"].(map[string]interface{}); ok {
					if status, _ := data["status"].(string); status == "failed" || status == "error" {
						return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Generation failed. Raw: %s", string(body[:min(len(body), 500)])))
					}
				}
			}

			break // got a valid response from this URL pattern, wait and retry
		}

		// On last attempt, return the raw response for debugging.
		if i == imageTaskPollMaxAttempts-1 && len(lastBody) > 0 {
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

	// Completion is signalled by the presence of a final image URL — not by
	// a status string (gateways disagree on the exact value, and Manju may
	// even return Chinese statuses). If a usable URL is present the task is
	// done; if not, it's still in progress and the caller keeps polling.
	// Search recursively (depth 5) for nested shapes like result.images[0].url
	// and data[0].url.
	// Order matters: prefer the most specific final-image fields. Manju/NewAPI
	// completed tasks put the image in `result_url` or `final_url` (the latter
	// was previously missing). `detail_url` is a detail *page*, not an image,
	// so it's intentionally excluded.
	for _, key := range []string{"result_url", "final_url", "download_url", "image_url", "url"} {
		url := findStringField(generic, key, 5)
		if url != "" && (strings.HasPrefix(url, "http") || strings.HasPrefix(url, "data:")) {
			return &GenerateResult{Type: "url", Content: url}
		}
	}
	// Manju 图生图 poll response carries the image as markdown inside
	// choices[0].message.content: "![](https://manjuapi.com/generated/x.png)".
	if content := findStringField(generic, "content", 5); content != "" {
		if match := markdownImageURLPattern.FindStringSubmatch(content); len(match) == 2 {
			return &GenerateResult{Type: "url", Content: match[1]}
		}
		if match := plainImageURLPattern.FindString(content); match != "" {
			return &GenerateResult{Type: "url", Content: strings.TrimRight(match, ".,;")}
		}
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

	if err := safehttp.ValidatePublicURL(rawURL); err != nil {
		return nil, fmt.Errorf("refusing to fetch remote reference: %w", err)
	}
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build remote reference request: %w", err)
	}
	req.Header.Set("User-Agent", "ccy-canvas/1.0")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")

	resp, err := safehttp.Client(remoteReferenceFetchTimeout).Do(req)
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
