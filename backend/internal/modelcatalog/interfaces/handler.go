// Package interfaces provides the HTTP API handlers for the model catalog bounded context.
package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
)

// Handler wires model catalog operations to the huma API.
type Handler struct {
	svc *application.Service
	q   *sqlc.Queries
	// generateLimiter bounds concurrent generation requests so we don't blow past
	// upstream provider rate limits or saturate goroutines / DB connections.
	// Default cap (8) is conservative; tune in NewHandler if needed.
	generateLimiter chan struct{}
}

// NewHandler creates a new model catalog Handler.
func NewHandler(svc *application.Service, q *sqlc.Queries) *Handler {
	return &Handler{svc: svc, q: q, generateLimiter: make(chan struct{}, 8)}
}

// --- response types ---

type AdminModelItem struct {
	ID                string          `json:"id" doc:"Model UUID"`
	ProviderID        string          `json:"provider_id"`
	ExternalModelName string          `json:"external_model_name"`
	DisplayName       string          `json:"display_name"`
	Capability        string          `json:"capability" enum:"text,image,video,audio"`
	Status            string          `json:"status" enum:"draft,enabled,disabled"`
	ParameterSchema   json.RawMessage `json:"parameter_schema"`
	DefaultParameters json.RawMessage `json:"default_parameters"`
	PricingRule       json.RawMessage `json:"pricing_rule"`
	HasPricing        bool            `json:"has_pricing"`
	SortOrder         int32           `json:"sort_order"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type UserModelItem struct {
	ID                string          `json:"id"`
	ExternalModelName string          `json:"external_model_name"`
	DisplayName       string          `json:"display_name"`
	Capability        string          `json:"capability" enum:"text,image,video,audio"`
	ParameterSchema   json.RawMessage `json:"parameter_schema"`
	DefaultParameters json.RawMessage `json:"default_parameters"`
}

type ProviderStatusResponse struct {
	HasProvider bool       `json:"has_provider"`
	BaseURL     string     `json:"base_url"`
	APIKeySet   bool       `json:"api_key_set"`
	APIKeyHint  string     `json:"api_key_hint"`
	Status      string     `json:"status"`
	LastSyncAt  *time.Time `json:"last_sync_at"`
}

func toAdminItem(m domain.ModelDefinition) AdminModelItem {
	return AdminModelItem{
		ID:                m.ID,
		ProviderID:        m.ProviderID,
		ExternalModelName: m.ExternalModelName,
		DisplayName:       m.DisplayName,
		Capability:        string(m.Capability),
		Status:            string(m.Status),
		ParameterSchema:   m.ParameterSchema,
		DefaultParameters: m.DefaultParameters,
		PricingRule:       m.PricingRule,
		HasPricing:        m.HasPricing(),
		SortOrder:         m.SortOrder,
		CreatedAt:         m.CreatedAt,
		UpdatedAt:         m.UpdatedAt,
	}
}

func toUserItem(m domain.UserModel) UserModelItem {
	return UserModelItem{
		ID:                m.ID,
		ExternalModelName: m.ExternalModelName,
		DisplayName:       m.DisplayName,
		Capability:        string(m.Capability),
		ParameterSchema:   m.ParameterSchema,
		DefaultParameters: m.DefaultParameters,
	}
}

func toProviderStatus(ps domain.ProviderStatus) ProviderStatusResponse {
	return ProviderStatusResponse{
		HasProvider: ps.HasProvider,
		BaseURL:     ps.BaseURL,
		APIKeySet:   ps.APIKeySet,
		APIKeyHint:  ps.APIKeyHint,
		Status:      ps.Status,
		LastSyncAt:  ps.LastSyncAt,
	}
}

func toHTTPError(err error) error {
	if err == nil {
		return nil
	}
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		switch appErr.Code {
		case apperror.CodeUnauthenticated:
			return huma.Error401Unauthorized(appErr.Message)
		case apperror.CodeForbidden:
			return huma.Error403Forbidden(appErr.Message)
		case apperror.CodeInvalidInput, apperror.CodeInvitationInvalid, apperror.CodeEmailAlreadyExists:
			return huma.Error400BadRequest(appErr.Message)
		default:
			return huma.Error500InternalServerError(appErr.Message)
		}
	}
	return err
}

// adminSecurity requires an authenticated admin session.
var adminSecurity = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}

// userSecurity requires any authenticated session.
var userSecurity = []map[string][]string{{httpapi.SecuritySchemeName: {}}}

// RegisterRoutes registers all model catalog operations on the huma API.
func (h *Handler) RegisterRoutes(api huma.API) {
	// --- Admin: Provider ---
	huma.Register(api, huma.Operation{
		OperationID: "get-relay-provider",
		Method:      http.MethodGet,
		Path:        "/api/admin/relay-provider",
		Summary:     "Get relay provider status",
		Tags:        []string{"Admin", "Models"},
		Security:    adminSecurity,
	}, h.getRelayProvider)

	huma.Register(api, huma.Operation{
		OperationID:   "put-relay-provider",
		Method:        http.MethodPut,
		Path:          "/api/admin/relay-provider",
		Summary:       "Configure relay provider",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.putRelayProvider)

	huma.Register(api, huma.Operation{
		OperationID:   "test-relay-provider",
		Method:        http.MethodPost,
		Path:          "/api/admin/relay-provider/test",
		Summary:       "Test relay provider connectivity",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.testRelayProvider)

	// --- Admin: Models ---
	huma.Register(api, huma.Operation{
		OperationID: "list-admin-models",
		Method:      http.MethodGet,
		Path:        "/api/admin/models",
		Summary:     "List all model definitions",
		Tags:        []string{"Admin", "Models"},
		Security:    adminSecurity,
	}, h.listAdminModels)

	huma.Register(api, huma.Operation{
		OperationID:   "sync-models",
		Method:        http.MethodPost,
		Path:          "/api/admin/models/sync",
		Summary:       "Sync models from relay provider",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.syncModels)

	huma.Register(api, huma.Operation{
		OperationID:   "patch-model",
		Method:        http.MethodPatch,
		Path:          "/api/admin/models/{id}",
		Summary:       "Update model definition",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.patchModel)

	huma.Register(api, huma.Operation{
		OperationID:   "enable-model",
		Method:        http.MethodPost,
		Path:          "/api/admin/models/{id}/enable",
		Summary:       "Enable a model",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.enableModel)

	huma.Register(api, huma.Operation{
		OperationID:   "disable-model",
		Method:        http.MethodPost,
		Path:          "/api/admin/models/{id}/disable",
		Summary:       "Disable a model",
		Tags:          []string{"Admin", "Models"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.disableModel)

	// --- User App: Models ---
	huma.Register(api, huma.Operation{
		OperationID: "list-app-models",
		Method:      http.MethodGet,
		Path:        "/api/app/models",
		Summary:     "List enabled models available to the current user",
		Tags:        []string{"App", "Models"},
		Security:    userSecurity,
	}, h.listAppModels)

	// --- Admin: ProviderConfig (multi-vendor) ---
	huma.Register(api, huma.Operation{
		OperationID: "list-provider-configs",
		Method:      http.MethodGet,
		Path:        "/api/admin/provider-configs",
		Summary:     "List all provider configurations",
		Tags:        []string{"Admin", "ProviderConfig"},
		Security:    adminSecurity,
	}, h.listProviderConfigs)

	huma.Register(api, huma.Operation{
		OperationID:   "create-provider-config",
		Method:        http.MethodPost,
		Path:          "/api/admin/provider-configs",
		Summary:       "Create a new provider configuration",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.createProviderConfig)

	huma.Register(api, huma.Operation{
		OperationID:   "update-provider-config",
		Method:        http.MethodPut,
		Path:          "/api/admin/provider-configs/{id}",
		Summary:       "Update a provider configuration",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.updateProviderConfig)

	huma.Register(api, huma.Operation{
		OperationID:   "delete-provider-config",
		Method:        http.MethodDelete,
		Path:          "/api/admin/provider-configs/{id}",
		Summary:       "Delete a provider configuration",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteProviderConfig)

	huma.Register(api, huma.Operation{
		OperationID:   "toggle-provider-config-status",
		Method:        http.MethodPost,
		Path:          "/api/admin/provider-configs/{id}/toggle",
		Summary:       "Toggle enabled/disabled status",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.toggleProviderConfigStatus)

	// --- User App: ProviderConfig ---
	huma.Register(api, huma.Operation{
		OperationID: "list-app-provider-configs",
		Method:      http.MethodGet,
		Path:        "/api/app/provider-configs",
		Summary:     "List enabled provider configs for the app",
		Tags:        []string{"App", "ProviderConfig"},
		Security:    userSecurity,
	}, h.listAppProviderConfigs)

	// --- User App: Generation ---
	huma.Register(api, huma.Operation{
		OperationID:   "generate",
		Method:        http.MethodPost,
		Path:          "/api/app/generate",
		Summary:       "Run a generation job (image, text, etc.)",
		Tags:          []string{"App", "Generation"},
		Security:      userSecurity,
		DefaultStatus: http.StatusOK,
	}, h.generate)
}

// --- Admin: Provider handlers ---

type getRelayProviderOutput struct {
	Body struct {
		Data      ProviderStatusResponse `json:"data"`
		RequestID string                 `json:"request_id"`
	}
}

func (h *Handler) getRelayProvider(ctx context.Context, _ *struct{}) (*getRelayProviderOutput, error) {
	ps, err := h.svc.GetProviderStatus(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &getRelayProviderOutput{}
	out.Body.Data = toProviderStatus(ps)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type putRelayProviderInput struct {
	Body struct {
		BaseURL string `json:"base_url" doc:"Provider base URL (e.g. https://api.example.com)"`
		APIKey  string `json:"api_key,omitempty" doc:"API key; leave empty to keep the existing key"`
	}
}

type putRelayProviderOutput struct {
	Body struct {
		Data      ProviderStatusResponse `json:"data"`
		RequestID string                 `json:"request_id"`
	}
}

func (h *Handler) putRelayProvider(ctx context.Context, input *putRelayProviderInput) (*putRelayProviderOutput, error) {
	ps, err := h.svc.ConfigureProvider(ctx, input.Body.BaseURL, input.Body.APIKey)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &putRelayProviderOutput{}
	out.Body.Data = toProviderStatus(ps)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type testRelayProviderOutput struct {
	Body struct {
		OK        bool   `json:"ok"`
		RequestID string `json:"request_id"`
	}
}

type testRelayProviderInput struct {
	Body struct {
		BaseURL string `json:"base_url,omitempty" doc:"Optional unsaved provider base URL to test"`
		APIKey  string `json:"api_key,omitempty" doc:"Optional unsaved API key to test"`
	}
}

func (h *Handler) testRelayProvider(ctx context.Context, input *testRelayProviderInput) (*testRelayProviderOutput, error) {
	var err error
	if input.Body.BaseURL != "" || input.Body.APIKey != "" {
		err = h.svc.TestProviderConnectionWithConfig(ctx, input.Body.BaseURL, input.Body.APIKey)
	} else {
		err = h.svc.TestProviderConnection(ctx)
	}
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &testRelayProviderOutput{}
	out.Body.OK = true
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// --- Admin: Model handlers ---

type listAdminModelsOutput struct {
	Body struct {
		Data      []AdminModelItem `json:"data"`
		RequestID string           `json:"request_id"`
	}
}

func (h *Handler) listAdminModels(ctx context.Context, _ *struct{}) (*listAdminModelsOutput, error) {
	models, err := h.svc.ListAdminModels(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	items := make([]AdminModelItem, 0, len(models))
	for _, m := range models {
		items = append(items, toAdminItem(m))
	}
	out := &listAdminModelsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type syncModelsOutput struct {
	Body struct {
		Inserted  int    `json:"inserted" doc:"Number of new models added as draft"`
		RequestID string `json:"request_id"`
	}
}

func (h *Handler) syncModels(ctx context.Context, _ *struct{}) (*syncModelsOutput, error) {
	inserted, err := h.svc.SyncModels(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &syncModelsOutput{}
	out.Body.Inserted = inserted
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type patchModelInput struct {
	ID   string `path:"id" doc:"Model UUID"`
	Body struct {
		DisplayName       string          `json:"display_name,omitempty"`
		Capability        string          `json:"capability,omitempty" enum:"text,image,video,audio"`
		ParameterSchema   json.RawMessage `json:"parameter_schema,omitempty"`
		DefaultParameters json.RawMessage `json:"default_parameters,omitempty"`
		PricingRule       json.RawMessage `json:"pricing_rule,omitempty"`
		SortOrder         *int32          `json:"sort_order,omitempty"`
	}
}

type patchModelOutput struct {
	Body struct {
		Data      AdminModelItem `json:"data"`
		RequestID string         `json:"request_id"`
	}
}

func (h *Handler) patchModel(ctx context.Context, input *patchModelInput) (*patchModelOutput, error) {
	// Fetch existing model to use as defaults for omitted fields.
	existing, err := h.svc.GetModelDefinitionByID(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}

	displayName := input.Body.DisplayName
	if displayName == "" {
		displayName = existing.DisplayName
	}
	capability := input.Body.Capability
	if capability == "" {
		capability = string(existing.Capability)
	}
	paramSchema := input.Body.ParameterSchema
	if len(paramSchema) == 0 {
		paramSchema = existing.ParameterSchema
	}
	defaultParams := input.Body.DefaultParameters
	if len(defaultParams) == 0 {
		defaultParams = existing.DefaultParameters
	}
	pricingRule := input.Body.PricingRule
	if len(pricingRule) == 0 {
		pricingRule = existing.PricingRule
	}
	sortOrder := existing.SortOrder
	if input.Body.SortOrder != nil {
		sortOrder = *input.Body.SortOrder
	}

	model, err := h.svc.UpdateModelDefinition(ctx, input.ID, displayName, capability, paramSchema, defaultParams, pricingRule, sortOrder)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &patchModelOutput{}
	out.Body.Data = toAdminItem(*model)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type modelIDInput struct {
	ID string `path:"id" doc:"Model UUID"`
}

type modelOutput struct {
	Body struct {
		Data      AdminModelItem `json:"data"`
		RequestID string         `json:"request_id"`
	}
}

func (h *Handler) enableModel(ctx context.Context, input *modelIDInput) (*modelOutput, error) {
	model, err := h.svc.EnableModel(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &modelOutput{}
	out.Body.Data = toAdminItem(*model)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) disableModel(ctx context.Context, input *modelIDInput) (*modelOutput, error) {
	model, err := h.svc.DisableModel(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &modelOutput{}
	out.Body.Data = toAdminItem(*model)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// --- User App: Models handler ---

type listAppModelsOutput struct {
	Body struct {
		Data      []UserModelItem `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *Handler) listAppModels(ctx context.Context, _ *struct{}) (*listAppModelsOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	models, err := h.svc.ListUserModels(ctx, claims.UserID, claims.Role)
	if err != nil {
		return nil, toHTTPError(err)
	}
	items := make([]UserModelItem, 0, len(models))
	for _, m := range models {
		items = append(items, toUserItem(m))
	}
	out := &listAppModelsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── ProviderConfig types ───────────────────────────────────────────────────

type ProviderConfigItem struct {
	ID             string   `json:"id"`
	ServiceType    string   `json:"service_type"`
	Vendor         string   `json:"vendor"`
	Name           string   `json:"name"`
	APISpec        string   `json:"api_spec"`
	BaseURL        string   `json:"base_url"`
	APIKeySet      bool     `json:"api_key_set"`
	APIKeyHint     string   `json:"api_key_hint"`
	SubmitEndpoint string   `json:"submit_endpoint"`
	QueryEndpoint  string   `json:"query_endpoint"`
	ModelList      []string `json:"model_list"`
	DefaultModel   string   `json:"default_model"`
	Priority       int32    `json:"priority"`
	IsDefault      bool     `json:"is_default"`
	Status         string   `json:"status"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

type AppProviderConfigItem struct {
	ID           string   `json:"id"`
	ServiceType  string   `json:"service_type"`
	Vendor       string   `json:"vendor"`
	Name         string   `json:"name"`
	ModelList    []string `json:"model_list"`
	DefaultModel string   `json:"default_model"`
	Priority     int32    `json:"priority"`
}

func toProviderConfigItem(pc domain.ProviderConfig) ProviderConfigItem {
	return ProviderConfigItem{
		ID:             pc.ID,
		ServiceType:    pc.ServiceType,
		Vendor:         pc.Vendor,
		Name:           pc.Name,
		APISpec:        pc.APISpec,
		BaseURL:        pc.BaseURL,
		APIKeySet:      pc.EncryptedAPIKey != "",
		APIKeyHint:     pc.APIKeyHint(),
		SubmitEndpoint: pc.SubmitEndpoint,
		QueryEndpoint:  pc.QueryEndpoint,
		ModelList:      pc.ModelList,
		DefaultModel:   pc.DefaultModel,
		Priority:       pc.Priority,
		IsDefault:      pc.IsDefault,
		Status:         pc.Status,
		CreatedAt:      pc.CreatedAt.Format(time.RFC3339),
		UpdatedAt:      pc.UpdatedAt.Format(time.RFC3339),
	}
}

func toAppProviderConfigItem(pc domain.AppProviderConfig) AppProviderConfigItem {
	return AppProviderConfigItem{
		ID:           pc.ID,
		ServiceType:  pc.ServiceType,
		Vendor:       pc.Vendor,
		Name:         pc.Name,
		ModelList:    pc.ModelList,
		DefaultModel: pc.DefaultModel,
		Priority:     pc.Priority,
	}
}

// ─── ProviderConfig handlers ────────────────────────────────────────────────

type listProviderConfigsOutput struct {
	Body struct {
		Data      []ProviderConfigItem `json:"data"`
		RequestID string               `json:"request_id"`
	}
}

func (h *Handler) listProviderConfigs(ctx context.Context, _ *struct{}) (*listProviderConfigsOutput, error) {
	configs, err := h.svc.ListProviderConfigs(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	items := make([]ProviderConfigItem, 0, len(configs))
	for _, c := range configs {
		items = append(items, toProviderConfigItem(c))
	}
	out := &listProviderConfigsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createProviderConfigInput struct {
	Body struct {
		ServiceType    string   `json:"service_type" enum:"text,image,video,audio" doc:"Service type"`
		Vendor         string   `json:"vendor" doc:"Vendor name"`
		Name           string   `json:"name" minLength:"1" maxLength:"128" doc:"Display name"`
		APISpec        string   `json:"api_spec,omitempty" doc:"API spec (openai or custom)"`
		BaseURL        string   `json:"base_url" doc:"Base URL"`
		APIKey         string   `json:"api_key,omitempty" doc:"API key (encrypted at rest)"`
		SubmitEndpoint string   `json:"submit_endpoint,omitempty" doc:"Video submit endpoint"`
		QueryEndpoint  string   `json:"query_endpoint,omitempty" doc:"Video query endpoint"`
		ModelList      []string `json:"model_list,omitempty" doc:"Available models"`
		DefaultModel   string   `json:"default_model,omitempty" doc:"Default model"`
		Priority       int32    `json:"priority,omitempty" doc:"Priority (lower = higher)"`
		IsDefault      bool     `json:"is_default,omitempty" doc:"Set as default"`
	}
}

type providerConfigOutput struct {
	Body struct {
		Data      ProviderConfigItem `json:"data"`
		RequestID string             `json:"request_id"`
	}
}

func (h *Handler) createProviderConfig(ctx context.Context, input *createProviderConfigInput) (*providerConfigOutput, error) {
	pc := domain.ProviderConfig{
		ServiceType:    input.Body.ServiceType,
		Vendor:         input.Body.Vendor,
		Name:           input.Body.Name,
		APISpec:        input.Body.APISpec,
		BaseURL:        input.Body.BaseURL,
		SubmitEndpoint: input.Body.SubmitEndpoint,
		QueryEndpoint:  input.Body.QueryEndpoint,
		ModelList:      input.Body.ModelList,
		DefaultModel:   input.Body.DefaultModel,
		Priority:       input.Body.Priority,
		IsDefault:      input.Body.IsDefault,
	}
	if pc.ModelList == nil {
		pc.ModelList = []string{}
	}
	result, err := h.svc.CreateProviderConfig(ctx, pc, input.Body.APIKey)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &providerConfigOutput{}
	out.Body.Data = toProviderConfigItem(*result)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type updateProviderConfigInput struct {
	ID   string `path:"id" doc:"Provider config UUID"`
	Body struct {
		ServiceType    string   `json:"service_type" enum:"text,image,video,audio"`
		Vendor         string   `json:"vendor"`
		Name           string   `json:"name" minLength:"1" maxLength:"128"`
		APISpec        string   `json:"api_spec,omitempty"`
		BaseURL        string   `json:"base_url"`
		APIKey         string   `json:"api_key,omitempty" doc:"Leave empty to keep existing key"`
		SubmitEndpoint string   `json:"submit_endpoint,omitempty"`
		QueryEndpoint  string   `json:"query_endpoint,omitempty"`
		ModelList      []string `json:"model_list,omitempty"`
		DefaultModel   string   `json:"default_model,omitempty"`
		Priority       int32    `json:"priority,omitempty"`
		IsDefault      bool     `json:"is_default,omitempty"`
		Status         string   `json:"status,omitempty" enum:"enabled,disabled"`
	}
}

func (h *Handler) updateProviderConfig(ctx context.Context, input *updateProviderConfigInput) (*providerConfigOutput, error) {
	pc := domain.ProviderConfig{
		ID:             input.ID,
		ServiceType:    input.Body.ServiceType,
		Vendor:         input.Body.Vendor,
		Name:           input.Body.Name,
		APISpec:        input.Body.APISpec,
		BaseURL:        input.Body.BaseURL,
		SubmitEndpoint: input.Body.SubmitEndpoint,
		QueryEndpoint:  input.Body.QueryEndpoint,
		ModelList:      input.Body.ModelList,
		DefaultModel:   input.Body.DefaultModel,
		Priority:       input.Body.Priority,
		IsDefault:      input.Body.IsDefault,
		Status:         input.Body.Status,
	}
	if pc.ModelList == nil {
		pc.ModelList = []string{}
	}
	if pc.Status == "" {
		pc.Status = "enabled"
	}
	result, err := h.svc.UpdateProviderConfig(ctx, pc, input.Body.APIKey)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &providerConfigOutput{}
	out.Body.Data = toProviderConfigItem(*result)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type deleteProviderConfigInput struct {
	ID string `path:"id" doc:"Provider config UUID"`
}

func (h *Handler) deleteProviderConfig(ctx context.Context, input *deleteProviderConfigInput) (*struct{}, error) {
	if err := h.svc.DeleteProviderConfig(ctx, input.ID); err != nil {
		return nil, toHTTPError(err)
	}
	return nil, nil
}

type toggleProviderConfigInput struct {
	ID string `path:"id" doc:"Provider config UUID"`
}

func (h *Handler) toggleProviderConfigStatus(ctx context.Context, input *toggleProviderConfigInput) (*providerConfigOutput, error) {
	result, err := h.svc.ToggleProviderConfigStatus(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &providerConfigOutput{}
	out.Body.Data = toProviderConfigItem(*result)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type listAppProviderConfigsOutput struct {
	Body struct {
		Data      []AppProviderConfigItem `json:"data"`
		RequestID string                  `json:"request_id"`
	}
}

// ─── Generation handler ─────────────────────────────────────────────────────

type generateInput struct {
	Body struct {
		NodeId          string   `json:"node_id" doc:"Canvas node id (for log correlation)"`
		ServiceType     string   `json:"service_type" enum:"text,image,video,audio" doc:"Service type"`
		Model           string   `json:"model" minLength:"1" doc:"Model name"`
		Prompt          string   `json:"prompt" minLength:"1" doc:"User prompt"`
		Size            string   `json:"size,omitempty" doc:"Image ratio (e.g. 1:1, 16:9, auto)"`
		Resolution      string   `json:"resolution,omitempty" doc:"Video resolution (e.g. 480p, 720p)"`
		Quality         string   `json:"quality,omitempty" doc:"Image quality (auto, high, medium, low)"`
		Duration        int      `json:"duration,omitempty" doc:"Video duration in seconds"`
		AspectRatio     string   `json:"aspect_ratio,omitempty" doc:"Video aspect ratio (16:9, 9:16, etc.)"`
		ReferenceImages []string `json:"reference_images,omitempty" doc:"Reference image URLs"`
		ReferenceVideo  string   `json:"reference_video,omitempty" doc:"Single reference video URL"`
		ReferenceVideos []string `json:"reference_videos,omitempty" doc:"Multiple reference video URLs"`
		ReferenceMode   string   `json:"reference_mode,omitempty" doc:"Reference image mode (auto/start_frame/start_end/image_reference)"`
	}
}

type generateOutput struct {
	Body struct {
		Data      application.GenerateResult `json:"data"`
		RequestID string                     `json:"request_id"`
	}
}

func (h *Handler) generate(ctx context.Context, input *generateInput) (*generateOutput, error) {
	// Concurrency cap: wait for a slot in the limiter; abort if client cancels.
	select {
	case h.generateLimiter <- struct{}{}:
		defer func() { <-h.generateLimiter }()
	case <-ctx.Done():
		return nil, huma.Error408RequestTimeout("Request canceled while waiting for a generation slot")
	}

	// Resolve current user; logging is best-effort and never fails the request.
	var userID pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = userID.Scan(claims.UserID)
	}

	// Best-effort: write a 'pending' log row before invoking the provider.
	startedAt := time.Now()
	var logID pgtype.UUID
	if h.q != nil {
		if logRow, lerr := h.q.InsertGenerationLog(ctx, sqlc.InsertGenerationLogParams{
			UserID:      userID,
			NodeID:      input.Body.NodeId,
			ServiceType: input.Body.ServiceType,
			Model:       input.Body.Model,
			Prompt:      input.Body.Prompt,
			Status:      "pending",
			ResultUrl:   "",
			ErrorMsg:    "",
			DurationMs:  0,
		}); lerr == nil {
			logID = logRow.ID
		}
	}

	result, err := h.svc.Generate(ctx, application.GenerateRequest{
		ServiceType:     input.Body.ServiceType,
		Model:           input.Body.Model,
		Prompt:          input.Body.Prompt,
		Size:            input.Body.Size,
		Resolution:      input.Body.Resolution,
		Quality:         input.Body.Quality,
		Duration:        input.Body.Duration,
		AspectRatio:     input.Body.AspectRatio,
		ReferenceImages: input.Body.ReferenceImages,
		ReferenceVideo:  input.Body.ReferenceVideo,
		ReferenceVideos: input.Body.ReferenceVideos,
		ReferenceMode:   input.Body.ReferenceMode,
	})
	durationMs := int32(time.Since(startedAt).Milliseconds())

	// Best-effort: update the pending row with the final result/error.
	if h.q != nil && logID.Valid {
		status := "success"
		errMsg := ""
		resultURL := ""
		if err != nil {
			status = "error"
			errMsg = err.Error()
		} else if result != nil {
			resultURL = result.Content
		}
		_ = h.q.UpdateGenerationLogResult(ctx, sqlc.UpdateGenerationLogResultParams{
			ID:         logID,
			Status:     status,
			ResultUrl:  resultURL,
			ErrorMsg:   errMsg,
			DurationMs: durationMs,
		})
	}

	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &generateOutput{}
	out.Body.Data = *result
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) listAppProviderConfigs(ctx context.Context, _ *struct{}) (*listAppProviderConfigsOutput, error) {
	configs, err := h.svc.ListAppProviderConfigs(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	items := make([]AppProviderConfigItem, 0, len(configs))
	for _, c := range configs {
		items = append(items, toAppProviderConfigItem(c))
	}
	out := &listAppProviderConfigsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}
