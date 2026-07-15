// Package interfaces provides the HTTP API handlers for the model catalog bounded context.
package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
)

// TaskEnqueuer is the producer-side hook into the Asynq task queue. The
// handler uses it (when non-nil) to enqueue durable generation tasks
// instead of running them inline in a detached goroutine.
//
// Defined here as a narrow interface so this package doesn't import the
// tasks package directly — keeps the model catalog free of Redis deps.
// main.go wires the concrete *tasks.Queue.
type TaskEnqueuer interface {
	Enabled() bool
	Enqueue(ctx context.Context, p TaskGenerationPayload) (asynqTaskID string, err error)
}

type Cache interface {
	Get(ctx context.Context, key string, dst any) bool
	Set(ctx context.Context, key string, value any, ttl time.Duration)
	Delete(ctx context.Context, keys ...string)
	DeletePattern(ctx context.Context, pattern string)
}

// TaskGenerationPayload mirrors tasks.GenerationPayload structurally.
// Lives here as the public contract between handler and tasks package.
type TaskGenerationPayload struct {
	LogID       string
	RequestID   string
	UserID      string
	ServiceType string
	Model       string
	NodeID      string
}

// Handler wires model catalog operations to the huma API.
type Handler struct {
	svc *application.Service
	q   *sqlc.Queries
	// generateLimiter bounds concurrent generation requests so we don't blow past
	// upstream provider rate limits or saturate goroutines / DB connections.
	// Default cap (8) is conservative; tune in NewHandler if needed.
	generateLimiter chan struct{}
	// tasks is optional. When non-nil and .Enabled() is true, generation
	// requests are persisted + enqueued instead of running inline. Empty
	// REDIS_ADDR at boot leaves this nil and behavior is unchanged.
	tasks TaskEnqueuer
	cache Cache
}

// NewHandler creates a new model catalog Handler.
func NewHandler(svc *application.Service, q *sqlc.Queries) *Handler {
	return &Handler{svc: svc, q: q, generateLimiter: make(chan struct{}, 8)}
}

// WithTasks wires the Asynq queue producer into the handler. Returns the
// handler for chaining.
func (h *Handler) WithTasks(t TaskEnqueuer) *Handler {
	h.tasks = t
	return h
}

func (h *Handler) WithCache(cache Cache) *Handler {
	h.cache = cache
	return h
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

// formatPgUUID returns the canonical 36-char hex form of a pgtype.UUID, or
// an empty string when the value is null. Kept inline so the handler isn't
// forced to import the skills package just for one helper.
func formatPgUUID(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	const hex = "0123456789abcdef"
	buf := make([]byte, 36)
	pos := 0
	for i, b := range u.Bytes {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[pos] = '-'
			pos++
		}
		buf[pos] = hex[b>>4]
		buf[pos+1] = hex[b&0x0f]
		pos += 2
	}
	return string(buf)
}

// isProjectVisitor reports whether userID is a read-only VISITOR on the project.
// Owner (creator) and non-members are NOT visitors. Best-effort: any parse/lookup
// error returns false (fail-open — saveCanvas remains the hard write gate).
func isProjectVisitor(ctx context.Context, q *sqlc.Queries, projectID, userID string) bool {
	pid, perr := uuid.Parse(projectID)
	uid, uerr := uuid.Parse(userID)
	if perr != nil || uerr != nil {
		return false
	}
	pgProj := pgtype.UUID{Bytes: pid, Valid: true}
	oc, err := q.GetProjectOwnerCollab(ctx, pgProj)
	if err != nil {
		return false
	}
	if formatPgUUID(oc.OwnerID) == userID {
		return false // owner = creator, always allowed
	}
	role, rerr := q.GetProjectMemberRole(ctx, pgProj, pgtype.UUID{Bytes: uid, Valid: true})
	if rerr != nil {
		return false
	}
	return role == "visitor"
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
		case apperror.CodeNotFound:
			return huma.Error404NotFound(appErr.Message)
		case apperror.CodeInvalidInput, apperror.CodeInvitationInvalid, apperror.CodeEmailAlreadyExists:
			return huma.Error400BadRequest(appErr.Message)
		default:
			// 500s in admin/operator paths: surface the underlying cause so
			// the user sees the real reason (missing migration, DB constraint,
			// etc.) instead of a generic wrap. The risk of leaking internals
			// is acceptable for these routes — they are admin-only.
			msg := appErr.Message
			if appErr.Err != nil {
				msg = appErr.Message + ": " + appErr.Err.Error()
			}
			return huma.Error500InternalServerError(msg)
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
		OperationID:   "preview-provider-config-ts-import",
		Method:        http.MethodPost,
		Path:          "/api/admin/provider-configs/import-ts/preview",
		Summary:       "Preview a TypeScript provider adapter import",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.previewProviderConfigTSImport)

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

	huma.Register(api, huma.Operation{
		OperationID:   "reset-channel-health",
		Method:        http.MethodPost,
		Path:          "/api/admin/provider-configs/{id}/reset-health",
		Summary:       "Clear failure counters and cooldown so the channel re-enters rotation",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.resetChannelHealth)

	huma.Register(api, huma.Operation{
		OperationID:   "test-channel-connectivity",
		Method:        http.MethodPost,
		Path:          "/api/admin/provider-configs/{id}/test",
		Summary:       "Probe the upstream provider to verify connectivity",
		Tags:          []string{"Admin", "ProviderConfig"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.testChannelConnectivity)

	huma.Register(api, huma.Operation{
		OperationID: "list-admin-alerts",
		Method:      http.MethodGet,
		Path:        "/api/admin/alerts",
		Summary:     "List admin alerts",
		Tags:        []string{"Admin", "Alerts"},
		Security:    adminSecurity,
	}, h.listAdminAlerts)

	huma.Register(api, huma.Operation{
		OperationID: "count-unread-admin-alerts",
		Method:      http.MethodGet,
		Path:        "/api/admin/alerts/unread-count",
		Summary:     "Count unread admin alerts",
		Tags:        []string{"Admin", "Alerts"},
		Security:    adminSecurity,
	}, h.countUnreadAdminAlerts)

	huma.Register(api, huma.Operation{
		OperationID:   "mark-admin-alert-read",
		Method:        http.MethodPost,
		Path:          "/api/admin/alerts/{id}/read",
		Summary:       "Mark an admin alert as read",
		Tags:          []string{"Admin", "Alerts"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.markAdminAlertRead)

	huma.Register(api, huma.Operation{
		OperationID:   "mark-all-admin-alerts-read",
		Method:        http.MethodPost,
		Path:          "/api/admin/alerts/read-all",
		Summary:       "Mark all admin alerts as read",
		Tags:          []string{"Admin", "Alerts"},
		Security:      adminSecurity,
		DefaultStatus: http.StatusOK,
	}, h.markAllAdminAlertsRead)

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

	// --- User App: Task lookup (recovery polling) ---
	huma.Register(api, huma.Operation{
		OperationID: "get-task-by-id",
		Method:      http.MethodGet,
		Path:        "/api/app/tasks/{id}",
		Summary:     "Get a generation task by ID (scoped to current user)",
		Tags:        []string{"App", "Generation"},
		Security:    userSecurity,
	}, h.getTaskByID)

	huma.Register(api, huma.Operation{
		OperationID: "batch-tasks-by-node-ids",
		Method:      http.MethodPost,
		Path:        "/api/app/tasks/batch",
		Summary:     "Get the most recent task per node id (current user only)",
		Tags:        []string{"App", "Generation"},
		Security:    userSecurity,
	}, h.batchTasksByNodeIDs)

	huma.Register(api, huma.Operation{
		OperationID: "list-active-tasks",
		Method:      http.MethodGet,
		Path:        "/api/app/tasks/active",
		Summary:     "List the current user's in-flight generation tasks (for reconnect hydration)",
		Tags:        []string{"App", "Generation"},
		Security:    userSecurity,
	}, h.listActiveTasks)
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
	ID              string          `json:"id"`
	ServiceType     string          `json:"service_type"`
	Vendor          string          `json:"vendor"`
	Name            string          `json:"name"`
	APISpec         string          `json:"api_spec"`
	Protocol        string          `json:"protocol"`
	BaseURL         string          `json:"base_url"`
	APIKeySet       bool            `json:"api_key_set"`
	APIKeyHint      string          `json:"api_key_hint"`
	SubmitEndpoint  string          `json:"submit_endpoint"`
	QueryEndpoint   string          `json:"query_endpoint"`
	ModelList       []string        `json:"model_list"`
	DefaultModel    string          `json:"default_model"`
	Priority        int32           `json:"priority"`
	IsDefault       bool            `json:"is_default"`
	Status          string          `json:"status"`
	Capabilities    []string        `json:"capabilities"`
	ParameterSchema json.RawMessage `json:"parameter_schema"`
	// CreditCost is the effective per-call price in credits (configured
	// value, or the default of 1 when unset). Admin-editable.
	CreditCost      int32  `json:"credit_cost"`
	AdapterRuntime  string `json:"adapter_runtime"`
	AdapterCode     string `json:"adapter_code,omitempty"`
	AdapterChecksum string `json:"adapter_checksum,omitempty"`
	IconKey         string `json:"icon_key,omitempty"`
	IconURL         string `json:"icon_url,omitempty"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
	// Channel-health snapshot. Empty timestamps + zero counters = healthy.
	FailureCount         int32  `json:"failure_count"`
	LastFailureAt        string `json:"last_failure_at,omitempty"`
	LastErrorMsg         string `json:"last_error_msg,omitempty"`
	LastErrorCode        string `json:"last_error_code,omitempty"`
	LastSuccessAt        string `json:"last_success_at,omitempty"`
	CooldownUntil        string `json:"cooldown_until,omitempty"`
	ConsecutiveCooldowns int32  `json:"consecutive_cooldowns"`
}

type AppProviderConfigItem struct {
	ID              string          `json:"id"`
	ServiceType     string          `json:"service_type"`
	Vendor          string          `json:"vendor"`
	Name            string          `json:"name"`
	ModelList       []string        `json:"model_list"`
	DefaultModel    string          `json:"default_model"`
	Priority        int32           `json:"priority"`
	ParameterSchema json.RawMessage `json:"parameter_schema"`
	IconKey         string          `json:"icon_key,omitempty"`
	IconURL         string          `json:"icon_url,omitempty"`
}

// effectiveCreditCostFromSchema returns the configured per-call credit cost
// from a provider config's parameter_schema, or the default of 1 when unset.
func effectiveCreditCostFromSchema(schema json.RawMessage) int32 {
	if len(schema) > 0 {
		var m struct {
			CreditCost *int32 `json:"credit_cost"`
		}
		if json.Unmarshal(schema, &m) == nil && m.CreditCost != nil {
			if *m.CreditCost < 0 {
				return 0
			}
			return *m.CreditCost
		}
	}
	return 1 // default cost, matches application.defaultCreditCost
}

// mergeCreditCostIntoSchema sets credit_cost inside a parameter_schema JSON
// object. nil cost leaves the schema unchanged. Used so the admin can edit
// the price via a dedicated field without hand-editing the schema.
func mergeCreditCostIntoSchema(schema json.RawMessage, cost *int32) json.RawMessage {
	if cost == nil {
		return schema
	}
	m := map[string]any{}
	if len(schema) > 0 {
		_ = json.Unmarshal(schema, &m)
	}
	v := *cost
	if v < 0 {
		v = 0
	}
	m["credit_cost"] = v
	out, err := json.Marshal(m)
	if err != nil {
		return schema
	}
	return out
}

func toProviderConfigItem(pc domain.ProviderConfig) ProviderConfigItem {
	fmtTime := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.Format(time.RFC3339)
	}
	return ProviderConfigItem{
		ID:                   pc.ID,
		ServiceType:          pc.ServiceType,
		Vendor:               pc.Vendor,
		Name:                 pc.Name,
		APISpec:              pc.APISpec,
		Protocol:             pc.Protocol,
		BaseURL:              pc.BaseURL,
		APIKeySet:            pc.EncryptedAPIKey != "",
		APIKeyHint:           pc.APIKeyHint(),
		SubmitEndpoint:       pc.SubmitEndpoint,
		QueryEndpoint:        pc.QueryEndpoint,
		ModelList:            pc.ModelList,
		DefaultModel:         pc.DefaultModel,
		Priority:             pc.Priority,
		IsDefault:            pc.IsDefault,
		Status:               pc.Status,
		Capabilities:         pc.Capabilities,
		ParameterSchema:      pc.ParameterSchema,
		CreditCost:           effectiveCreditCostFromSchema(pc.ParameterSchema),
		AdapterRuntime:       pc.AdapterRuntime,
		AdapterCode:          pc.AdapterCode,
		AdapterChecksum:      pc.AdapterChecksum,
		IconKey:              pc.IconKey,
		IconURL:              pc.IconURL,
		CreatedAt:            pc.CreatedAt.Format(time.RFC3339),
		UpdatedAt:            pc.UpdatedAt.Format(time.RFC3339),
		FailureCount:         pc.FailureCount,
		LastFailureAt:        fmtTime(pc.LastFailureAt),
		LastErrorMsg:         pc.LastErrorMsg,
		LastErrorCode:        pc.LastErrorCode,
		LastSuccessAt:        fmtTime(pc.LastSuccessAt),
		CooldownUntil:        fmtTime(pc.CooldownUntil),
		ConsecutiveCooldowns: pc.ConsecutiveCooldowns,
	}
}

func toAppProviderConfigItem(pc domain.AppProviderConfig) AppProviderConfigItem {
	return AppProviderConfigItem{
		ID:              pc.ID,
		ServiceType:     pc.ServiceType,
		Vendor:          pc.Vendor,
		Name:            pc.Name,
		ModelList:       pc.ModelList,
		DefaultModel:    pc.DefaultModel,
		Priority:        pc.Priority,
		ParameterSchema: pc.ParameterSchema,
		IconKey:         pc.IconKey,
		IconURL:         pc.IconURL,
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

type previewProviderConfigTSImportInput struct {
	Body struct {
		Code        string `json:"code" minLength:"1" doc:"TypeScript provider adapter source"`
		ServiceType string `json:"service_type,omitempty" enum:"text,image,video,audio" doc:"Service type to import from a mixed provider"`
	}
}

type previewProviderConfigTSImportOutput struct {
	Body struct {
		Data      application.ProviderPluginPreview `json:"data"`
		RequestID string                            `json:"request_id"`
	}
}

func (h *Handler) previewProviderConfigTSImport(ctx context.Context, input *previewProviderConfigTSImportInput) (*previewProviderConfigTSImportOutput, error) {
	preview, err := h.svc.PreviewProviderPlugin(ctx, input.Body.Code, input.Body.ServiceType)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &previewProviderConfigTSImportOutput{}
	out.Body.Data = *preview
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createProviderConfigInput struct {
	Body struct {
		ServiceType     string          `json:"service_type" enum:"text,image,video,audio" doc:"Service type"`
		Vendor          string          `json:"vendor" doc:"Vendor name"`
		Name            string          `json:"name" minLength:"1" maxLength:"128" doc:"Display name"`
		APISpec         string          `json:"api_spec,omitempty" doc:"API spec (openai or custom)"`
		Protocol        string          `json:"protocol,omitempty" doc:"Gateway protocol"`
		BaseURL         string          `json:"base_url" doc:"Base URL"`
		APIKey          string          `json:"api_key,omitempty" doc:"API key (encrypted at rest)"`
		SubmitEndpoint  string          `json:"submit_endpoint,omitempty" doc:"Video submit endpoint"`
		QueryEndpoint   string          `json:"query_endpoint,omitempty" doc:"Video query endpoint"`
		ModelList       []string        `json:"model_list,omitempty" doc:"Available models"`
		DefaultModel    string          `json:"default_model,omitempty" doc:"Default model"`
		Priority        int32           `json:"priority,omitempty" doc:"Priority (lower = higher)"`
		IsDefault       bool            `json:"is_default,omitempty" doc:"Set as default"`
		Status          string          `json:"status,omitempty" enum:"enabled,disabled" doc:"Initial status"`
		Capabilities    []string        `json:"capabilities,omitempty" doc:"Declared channel capabilities"`
		ParameterSchema json.RawMessage `json:"parameter_schema,omitempty" doc:"Supported request parameters and UI options"`
		CreditCost      *int32          `json:"credit_cost,omitempty" doc:"Per-call price in credits (omit to keep current / default 1)"`
		AdapterRuntime  string          `json:"adapter_runtime,omitempty" enum:"go,ts" doc:"Adapter runtime"`
		AdapterCode     string          `json:"adapter_code,omitempty" doc:"TypeScript adapter code"`
		IconKey         string          `json:"icon_key,omitempty" doc:"Brand icon key"`
		IconURL         string          `json:"icon_url,omitempty" doc:"Icon image URL or data URL"`
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
		ServiceType:     input.Body.ServiceType,
		Vendor:          input.Body.Vendor,
		Name:            input.Body.Name,
		APISpec:         input.Body.APISpec,
		Protocol:        input.Body.Protocol,
		BaseURL:         input.Body.BaseURL,
		SubmitEndpoint:  input.Body.SubmitEndpoint,
		QueryEndpoint:   input.Body.QueryEndpoint,
		ModelList:       input.Body.ModelList,
		DefaultModel:    input.Body.DefaultModel,
		Priority:        input.Body.Priority,
		IsDefault:       input.Body.IsDefault,
		Status:          input.Body.Status,
		Capabilities:    input.Body.Capabilities,
		ParameterSchema: mergeCreditCostIntoSchema(input.Body.ParameterSchema, input.Body.CreditCost),
		AdapterRuntime:  input.Body.AdapterRuntime,
		AdapterCode:     input.Body.AdapterCode,
		IconKey:         input.Body.IconKey,
		IconURL:         input.Body.IconURL,
	}
	if pc.ModelList == nil {
		pc.ModelList = []string{}
	}
	if pc.Status == "" {
		pc.Status = "enabled"
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
		ServiceType     string          `json:"service_type" enum:"text,image,video,audio"`
		Vendor          string          `json:"vendor"`
		Name            string          `json:"name" minLength:"1" maxLength:"128"`
		APISpec         string          `json:"api_spec,omitempty"`
		Protocol        string          `json:"protocol,omitempty"`
		BaseURL         string          `json:"base_url"`
		APIKey          string          `json:"api_key,omitempty" doc:"Leave empty to keep existing key"`
		SubmitEndpoint  string          `json:"submit_endpoint,omitempty"`
		QueryEndpoint   string          `json:"query_endpoint,omitempty"`
		ModelList       []string        `json:"model_list,omitempty"`
		DefaultModel    string          `json:"default_model,omitempty"`
		Priority        int32           `json:"priority,omitempty"`
		IsDefault       bool            `json:"is_default,omitempty"`
		Status          string          `json:"status,omitempty" enum:"enabled,disabled"`
		Capabilities    []string        `json:"capabilities,omitempty"`
		ParameterSchema json.RawMessage `json:"parameter_schema,omitempty"`
		CreditCost      *int32          `json:"credit_cost,omitempty" doc:"Per-call price in credits (omit to keep current)"`
		AdapterRuntime  string          `json:"adapter_runtime,omitempty" enum:"go,ts"`
		AdapterCode     string          `json:"adapter_code,omitempty"`
		IconKey         string          `json:"icon_key,omitempty"`
		IconURL         string          `json:"icon_url,omitempty"`
	}
}

func (h *Handler) updateProviderConfig(ctx context.Context, input *updateProviderConfigInput) (*providerConfigOutput, error) {
	// Defensive: if the request omits parameter_schema, keep the existing one
	// so an edit through the drawer (which may not resend it) can't wipe
	// request_format etc. Then merge the credit_cost edit into it.
	schema := input.Body.ParameterSchema
	if len(schema) == 0 {
		if existing, gerr := h.svc.GetProviderConfigByID(ctx, input.ID); gerr == nil && existing != nil {
			schema = existing.ParameterSchema
		}
	}
	pc := domain.ProviderConfig{
		ID:              input.ID,
		ServiceType:     input.Body.ServiceType,
		Vendor:          input.Body.Vendor,
		Name:            input.Body.Name,
		APISpec:         input.Body.APISpec,
		Protocol:        input.Body.Protocol,
		BaseURL:         input.Body.BaseURL,
		SubmitEndpoint:  input.Body.SubmitEndpoint,
		QueryEndpoint:   input.Body.QueryEndpoint,
		ModelList:       input.Body.ModelList,
		DefaultModel:    input.Body.DefaultModel,
		Priority:        input.Body.Priority,
		IsDefault:       input.Body.IsDefault,
		Status:          input.Body.Status,
		Capabilities:    input.Body.Capabilities,
		ParameterSchema: mergeCreditCostIntoSchema(schema, input.Body.CreditCost),
		AdapterRuntime:  input.Body.AdapterRuntime,
		AdapterCode:     input.Body.AdapterCode,
		IconKey:         input.Body.IconKey,
		IconURL:         input.Body.IconURL,
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

// resetChannelHealth wipes the per-channel failure counters and cooldown so
// the next request re-includes this provider, regardless of its prior
// state. Returns the refreshed config so the admin UI can update in place.
func (h *Handler) resetChannelHealth(ctx context.Context, input *toggleProviderConfigInput) (*providerConfigOutput, error) {
	if err := h.svc.ResetChannelHealth(ctx, input.ID); err != nil {
		return nil, toHTTPError(err)
	}
	result, err := h.svc.GetProviderConfigByID(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &providerConfigOutput{}
	out.Body.Data = toProviderConfigItem(*result)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type testChannelOutput struct {
	Body struct {
		OK         bool   `json:"ok"`
		HttpStatus int    `json:"http_status"`
		LatencyMs  int    `json:"latency_ms"`
		ErrorMsg   string `json:"error_msg,omitempty"`
		RequestID  string `json:"request_id"`
	}
}

type AdminAlertItem struct {
	ID               string `json:"id"`
	ProviderConfigID string `json:"provider_config_id,omitempty"`
	GenerationLogID  string `json:"generation_log_id,omitempty"`
	ProviderName     string `json:"provider_name,omitempty"`
	ServiceType      string `json:"service_type"`
	Model            string `json:"model"`
	ErrorCode        string `json:"error_code"`
	ErrorMessage     string `json:"error_message"`
	Source           string `json:"source"`
	Severity         string `json:"severity"`
	Status           string `json:"status"`
	CreatedAt        string `json:"created_at"`
	LastSeenAt       string `json:"last_seen_at"`
}

type listAdminAlertsInput struct {
	Status string `query:"status" doc:"Optional alert status filter"`
	Limit  int32  `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Offset int32  `query:"offset" minimum:"0" default:"0"`
}

type listAdminAlertsOutput struct {
	Body struct {
		Data      []AdminAlertItem `json:"data"`
		RequestID string           `json:"request_id"`
	}
}

type unreadAlertsOutput struct {
	Body struct {
		Count     int32  `json:"count"`
		RequestID string `json:"request_id"`
	}
}

type alertIDInput struct {
	ID string `path:"id" doc:"Alert UUID"`
}

type alertActionOutput struct {
	Body struct {
		OK        bool   `json:"ok"`
		RequestID string `json:"request_id"`
	}
}

func toAdminAlertItem(alert domain.AdminAlert) AdminAlertItem {
	item := AdminAlertItem{
		ID:               alert.ID,
		ProviderConfigID: alert.ProviderConfigID,
		GenerationLogID:  alert.GenerationLogID,
		ProviderName:     alert.ProviderName,
		ServiceType:      alert.ServiceType,
		Model:            alert.Model,
		ErrorCode:        alert.ErrorCode,
		ErrorMessage:     alert.ErrorMessage,
		Source:           alert.Source,
		Severity:         alert.Severity,
		Status:           alert.Status,
	}
	if !alert.CreatedAt.IsZero() {
		item.CreatedAt = alert.CreatedAt.UTC().Format(time.RFC3339)
	}
	if !alert.LastSeenAt.IsZero() {
		item.LastSeenAt = alert.LastSeenAt.UTC().Format(time.RFC3339)
	}
	return item
}

// testChannelConnectivity actively probes the provider with a cheap request
// (HEAD on the base URL, fallback to GET) to confirm credentials work and
// the network path is up. Doesn't consume model quota.
func (h *Handler) testChannelConnectivity(ctx context.Context, input *toggleProviderConfigInput) (*testChannelOutput, error) {
	report, err := h.svc.TestChannelConnectivity(ctx, input.ID)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &testChannelOutput{}
	out.Body.OK = report.OK
	out.Body.HttpStatus = report.HTTPStatus
	out.Body.LatencyMs = report.LatencyMs
	out.Body.ErrorMsg = report.ErrorMsg
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) listAdminAlerts(ctx context.Context, input *listAdminAlertsInput) (*listAdminAlertsOutput, error) {
	alerts, err := h.svc.ListAdminAlerts(ctx, input.Status, input.Limit, input.Offset)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &listAdminAlertsOutput{}
	out.Body.Data = make([]AdminAlertItem, 0, len(alerts))
	for _, alert := range alerts {
		out.Body.Data = append(out.Body.Data, toAdminAlertItem(alert))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) countUnreadAdminAlerts(ctx context.Context, _ *struct{}) (*unreadAlertsOutput, error) {
	count, err := h.svc.CountUnreadAdminAlerts(ctx)
	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &unreadAlertsOutput{}
	out.Body.Count = count
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) markAdminAlertRead(ctx context.Context, input *alertIDInput) (*alertActionOutput, error) {
	if err := h.svc.MarkAdminAlertRead(ctx, input.ID); err != nil {
		return nil, toHTTPError(err)
	}
	out := &alertActionOutput{}
	out.Body.OK = true
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) markAllAdminAlertsRead(ctx context.Context, _ *struct{}) (*alertActionOutput, error) {
	if err := h.svc.MarkAllAdminAlertsRead(ctx); err != nil {
		return nil, toHTTPError(err)
	}
	out := &alertActionOutput{}
	out.Body.OK = true
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
		NodeId           string                      `json:"node_id" doc:"Canvas node id (for log correlation)"`
		ProjectID        string                      `json:"project_id,omitempty" doc:"Owning canvas project id — used to reject read-only (visitor) collaborators"`
		RequestID        string                      `json:"request_id,omitempty" doc:"Client-generated idempotency key (UUID)"`
		ProviderConfigID string                      `json:"provider_config_id,omitempty" doc:"Exact provider config id selected by frontend"`
		ServiceType      string                      `json:"service_type" enum:"text,image,video,audio" doc:"Service type"`
		Model            string                      `json:"model" minLength:"1" doc:"Model name"`
		Prompt           string                      `json:"prompt" minLength:"1" doc:"User prompt"`
		Size             string                      `json:"size,omitempty" doc:"Image ratio (e.g. 1:1, 16:9, auto)"`
		Resolution       string                      `json:"resolution,omitempty" doc:"Video resolution (e.g. 480p, 720p)"`
		Quality          string                      `json:"quality,omitempty" doc:"Image quality (auto, high, medium, low)"`
		Duration         int                         `json:"duration,omitempty" doc:"Video duration in seconds"`
		AspectRatio      string                      `json:"aspect_ratio,omitempty" doc:"Video aspect ratio (16:9, 9:16, etc.)"`
		ReferenceImages  []string                    `json:"reference_images,omitempty" doc:"Reference image URLs"`
		ReferenceVideo   string                      `json:"reference_video,omitempty" doc:"Single reference video URL"`
		ReferenceVideos  []string                    `json:"reference_videos,omitempty" doc:"Multiple reference video URLs"`
		EditOperation    string                      `json:"edit_operation,omitempty" doc:"Image edit operation hint"`
		MaskImage        string                      `json:"mask_image,omitempty" doc:"Image edit mask"`
		OutputCount      int                         `json:"output_count,omitempty" doc:"Number of requested outputs"`
		ExpandDirection  string                      `json:"expand_direction,omitempty" doc:"Expansion direction hint"`
		DeriveFromNodeID string                      `json:"derive_from_node_id,omitempty" doc:"Source node id for derivatives"`
		TrimRange        *application.VideoTrimRange `json:"trim_range,omitempty" doc:"Video trim range in seconds"`
		CropRect         *application.VideoCropRect  `json:"crop_rect,omitempty" doc:"Normalized crop rectangle"`
		TargetTracks     []string                    `json:"target_tracks,omitempty" doc:"Requested output tracks"`
		OutputFormat     string                      `json:"output_format,omitempty" doc:"Requested output format hint"`
		Parameters       map[string]any              `json:"parameters,omitempty" doc:"Provider-specific extra parameters"`
		ReferenceMode    string                      `json:"reference_mode,omitempty" doc:"Reference image mode (auto/start_frame/start_end/image_reference)"`
		AudioSetting     string                      `json:"audio_setting,omitempty" doc:"HappyHorse video-edit audio: auto / origin"`
		Seed             *int                        `json:"seed,omitempty" doc:"Random seed [0, 2147483647] for reproducible generation"`
		EnableSequential *bool                       `json:"enable_sequential,omitempty" doc:"wan2.7 组图 (grid) mode — one request yields up to 12 images"`
		ThinkingMode     *bool                       `json:"thinking_mode,omitempty" doc:"wan2.7 文生图 thinking mode (default true)"`
	}
}

// generateData is the response data block — extends the upstream
// GenerateResult with the persisted task id so the frontend can poll
// for late-completing generations after a client-side timeout.
type generateData struct {
	application.GenerateResult
	TaskID string `json:"task_id,omitempty"`
}

type generateOutput struct {
	Body struct {
		Data      generateData `json:"data"`
		RequestID string       `json:"request_id"`
	}
}

// TaskItem is the read-projection of a generation_logs row, served to the
// frontend by the recovery polling endpoints. We deliberately omit the
// prompt/cost fields — they're not needed for status updates and adding
// them would leak more user data than necessary across the network.
type TaskItem struct {
	ID          string `json:"id"`
	NodeID      string `json:"node_id"`
	ServiceType string `json:"service_type"`
	Model       string `json:"model"`
	Status      string `json:"status"`
	ResultURL   string `json:"result_url"`
	ErrorMsg    string `json:"error_msg"`
	DurationMs  int    `json:"duration_ms"`
	CreatedAt   string `json:"created_at"`
}

type getTaskByIDInput struct {
	ID string `path:"id" doc:"Generation log / task id (UUID)"`
}

type taskOutput struct {
	Body struct {
		Data      TaskItem `json:"data"`
		RequestID string   `json:"request_id"`
	}
}

type batchTasksInput struct {
	Body struct {
		NodeIDs []string `json:"node_ids" doc:"List of canvas node ids to look up"`
	}
}

type batchTasksOutput struct {
	Body struct {
		Data      []TaskItem `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func toTaskItem(row sqlc.GenerationLog) TaskItem {
	createdAt := ""
	if row.CreatedAt.Valid {
		createdAt = row.CreatedAt.Time.UTC().Format(time.RFC3339)
	}
	id := ""
	if row.ID.Valid {
		id = formatPgUUID(row.ID)
	}
	durationMs := 0
	if row.DurationMs != 0 {
		durationMs = int(row.DurationMs)
	}
	return TaskItem{
		ID:          id,
		NodeID:      row.NodeID,
		ServiceType: row.ServiceType,
		Model:       row.Model,
		Status:      row.Status,
		ResultURL:   row.ResultUrl,
		ErrorMsg:    row.ErrorMsg,
		DurationMs:  durationMs,
		CreatedAt:   createdAt,
	}
}

func taskCacheKey(userID, id string) string {
	// Scope the cache entry to the owning user. The cache is read before the
	// per-user DB ownership filter, so an un-scoped key would let any
	// authenticated caller read another user's task by guessing its id (IDOR).
	return "generation_task:" + userID + ":" + id
}

func isActiveTaskStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "queued", "pending", "running", "retrying", "persisting":
		return true
	default:
		return false
	}
}

func (h *Handler) getTaskByID(ctx context.Context, input *getTaskByIDInput) (*taskOutput, error) {
	if h.q == nil {
		return nil, huma.Error500InternalServerError("Database unavailable")
	}
	var userID pgtype.UUID
	var userIDStr string
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		userIDStr = claims.UserID
		_ = userID.Scan(claims.UserID)
	}
	if !userID.Valid {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	if h.cache != nil {
		var cached TaskItem
		if h.cache.Get(ctx, taskCacheKey(userIDStr, input.ID), &cached) {
			if !isActiveTaskStatus(cached.Status) {
				out := &taskOutput{}
				out.Body.Data = cached
				out.Body.RequestID = httpx.RequestIDFrom(ctx)
				return out, nil
			}
		}
	}
	var taskID pgtype.UUID
	if err := taskID.Scan(input.ID); err != nil {
		return nil, huma.Error400BadRequest("Invalid task id")
	}
	row, err := h.q.GetGenerationLogByIDForUser(ctx, sqlc.GetGenerationLogByIDForUserParams{
		ID:     taskID,
		UserID: userID,
	})
	if err != nil {
		return nil, huma.Error404NotFound("Task not found")
	}
	out := &taskOutput{}
	out.Body.Data = toTaskItem(row)
	if h.cache != nil {
		if isActiveTaskStatus(out.Body.Data.Status) {
			h.cache.Set(ctx, taskCacheKey(userIDStr, input.ID), out.Body.Data, 2*time.Second)
		} else {
			h.cache.Set(ctx, taskCacheKey(userIDStr, input.ID), out.Body.Data, 5*time.Minute)
		}
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// listActiveTasks returns every generation_logs row for the current user
// still in an active state (queued/running/pending/retrying). The frontend
// calls this on load to re-hydrate its in-flight task tracking (F10) so a
// generation survives a localStorage wipe / different browser — tracking no
// longer depends solely on the persisted node snapshot.
func (h *Handler) listActiveTasks(ctx context.Context, _ *struct{}) (*batchTasksOutput, error) {
	out := &batchTasksOutput{}
	out.Body.Data = []TaskItem{}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	if h.q == nil {
		return out, nil
	}
	var userID pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = userID.Scan(claims.UserID)
	}
	if !userID.Valid {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	rows, err := h.q.ListActiveGenerationsForUser(ctx, userID)
	if err != nil {
		return nil, huma.Error500InternalServerError(err.Error())
	}
	out.Body.Data = make([]TaskItem, 0, len(rows))
	for _, row := range rows {
		createdAt := ""
		if row.CreatedAt.Valid {
			createdAt = row.CreatedAt.Time.UTC().Format(time.RFC3339)
		}
		out.Body.Data = append(out.Body.Data, TaskItem{
			ID:          formatPgUUID(row.ID),
			NodeID:      row.NodeID,
			ServiceType: row.ServiceType,
			Model:       row.Model,
			Status:      row.Status,
			ResultURL:   row.ResultUrl,
			ErrorMsg:    row.ErrorMsg,
			CreatedAt:   createdAt,
		})
	}
	return out, nil
}

func (h *Handler) batchTasksByNodeIDs(ctx context.Context, input *batchTasksInput) (*batchTasksOutput, error) {
	out := &batchTasksOutput{}
	out.Body.Data = []TaskItem{}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	if h.q == nil || len(input.Body.NodeIDs) == 0 {
		return out, nil
	}
	var userID pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = userID.Scan(claims.UserID)
	}
	if !userID.Valid {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	// Cap batch size to keep a malicious or buggy client from sweeping the
	// whole table. 200 covers any reasonable canvas in one round trip.
	ids := input.Body.NodeIDs
	if len(ids) > 200 {
		ids = ids[:200]
	}
	rows, err := h.q.GetLatestGenerationLogsForUserNodes(ctx, sqlc.GetLatestGenerationLogsForUserNodesParams{
		UserID:  userID,
		NodeIDs: ids,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError(err.Error())
	}
	out.Body.Data = make([]TaskItem, 0, len(rows))
	for _, row := range rows {
		out.Body.Data = append(out.Body.Data, toTaskItem(row))
	}
	return out, nil
}

func (h *Handler) generate(ctx context.Context, input *generateInput) (*generateOutput, error) {
	// Resolve current user; logging is best-effort and never fails the request.
	var userID pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = userID.Scan(claims.UserID)
	}
	var userIDStr string
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		userIDStr = claims.UserID
	}

	// 协作只读:访问者不能在协作项目里生成(否则白扣积分)。仅当前端带了
	// project_id 时校验;查不到 / 出错则放行(saveCanvas 仍会拦画布写入)。
	if pid := strings.TrimSpace(input.Body.ProjectID); pid != "" && userIDStr != "" {
		if isProjectVisitor(ctx, h.q, pid, userIDStr) {
			return nil, huma.Error403Forbidden("你是访问者(只读)，无法在该协作项目生成")
		}
	}

	// Build the request struct once — used for both Asynq path (encoded
	// into request_payload JSONB) and legacy inline path.
	req := application.GenerateRequest{
		ServiceType:      input.Body.ServiceType,
		ProviderConfigID: input.Body.ProviderConfigID,
		Model:            input.Body.Model,
		Prompt:           input.Body.Prompt,
		Size:             input.Body.Size,
		Resolution:       input.Body.Resolution,
		Quality:          input.Body.Quality,
		// Clamp count/duration at the trust boundary so a crafted body can't make
		// the relay generate/bill far more than the reserved credits cover
		// (output_count/duration cost-amplification). See ClampOutputCount.
		Duration:         application.ClampVideoDuration(input.Body.Duration),
		AspectRatio:      input.Body.AspectRatio,
		ReferenceImages:  input.Body.ReferenceImages,
		ReferenceVideo:   input.Body.ReferenceVideo,
		ReferenceVideos:  input.Body.ReferenceVideos,
		EditOperation:    input.Body.EditOperation,
		MaskImage:        input.Body.MaskImage,
		OutputCount:      application.CapOutputCount(input.Body.OutputCount),
		ExpandDirection:  input.Body.ExpandDirection,
		DeriveFromNodeID: input.Body.DeriveFromNodeID,
		TrimRange:        input.Body.TrimRange,
		CropRect:         input.Body.CropRect,
		TargetTracks:     input.Body.TargetTracks,
		OutputFormat:     input.Body.OutputFormat,
		Parameters:       input.Body.Parameters,
		ReferenceMode:    input.Body.ReferenceMode,
		AudioSetting:     input.Body.AudioSetting,
		Seed:             input.Body.Seed,
		EnableSequential: input.Body.EnableSequential,
		ThinkingMode:     input.Body.ThinkingMode,
		UserID:           userIDStr,
		NodeID:           input.Body.NodeId,
		RequestID:        input.Body.RequestID,
	}

	// ─── Pre-reserve idempotency fast-path (P0-5) ──────────────────
	// If the client sent a request_id we already have a row for, return that
	// task BEFORE reserving credits. The old order (reserve → INSERT → detect
	// conflict → refund) let a double-click reserve twice and depended on a
	// best-effort refund; checking first means the common duplicate never
	// touches the balance at all. The ON CONFLICT insert below stays as the
	// race-proof backstop for truly concurrent duplicates.
	if h.q != nil {
		if cid := strings.TrimSpace(req.RequestID); cid != "" {
			if parsedReqID, perr := uuid.Parse(cid); perr == nil {
				var pgReqID pgtype.UUID
				_ = pgReqID.Scan(parsedReqID.String())
				if existing, derr := h.q.GetGenerationLogByRequestID(ctx, pgReqID); derr == nil {
					out := &generateOutput{}
					out.Body.Data.GenerateResult = application.GenerateResult{Type: "queued", Content: ""}
					out.Body.Data.TaskID = formatPgUUID(existing.ID)
					out.Body.RequestID = httpx.RequestIDFrom(ctx)
					return out, nil
				}
			}
		}
	}

	// ─── Node-level in-flight dedup ────────────────────────────────
	// 「提交后一段时间没返回,就重发一条一样的」→ 双扣。图片/视频走异步队列,前端每次
	// 提交都生成新的随机 request_id(只为去重 apiClient 自身的 HTTP 重试),所以上面的
	// request_id 快路挡不住用户手动重发。这里按内容兜底:同一用户、同一节点、同一模型、
	// 同一提示词若已有在途任务(pending/queued/running/retrying),直接返回它、不再
	// reserve/扣费。只匹配「完全相同的请求」——改了提示词或换了模型即视为新生成,
	// 不误挡 re-roll(重掷)。node_id 为空(无画布上下文)时跳过。
	if h.q != nil && strings.TrimSpace(input.Body.NodeId) != "" {
		if existing, derr := h.q.GetInflightGenerationLogByNode(ctx, sqlc.GetInflightGenerationLogByNodeParams{
			UserID:      userID,
			NodeID:      input.Body.NodeId,
			ServiceType: input.Body.ServiceType,
			Model:       input.Body.Model,
			Prompt:      input.Body.Prompt,
		}); derr == nil {
			out := &generateOutput{}
			out.Body.Data.GenerateResult = application.GenerateResult{Type: "queued", Content: ""}
			out.Body.Data.TaskID = formatPgUUID(existing.ID)
			out.Body.RequestID = httpx.RequestIDFrom(ctx)
			return out, nil
		}
	}

	// ─── Per-generation credit reserve ─────────────────────────────
	// Resolve the per-model price and reserve it up-front so we can hard
	// block (402) before doing any work. A terminal failure later refunds
	// it (service / worker / reaper); a success keeps it. No-op when credit
	// charging isn't wired or the model costs 0.
	cost := h.svc.ResolveGenerationCost(req)
	if cost > 0 {
		reason := "reserve: " + input.Body.ServiceType + " " + input.Body.Model + " node=" + input.Body.NodeId
		if rerr := h.svc.ReserveCredits(ctx, userIDStr, cost, reason); rerr != nil {
			if errors.Is(rerr, application.ErrInsufficientCredits) {
				return nil, huma.Error402PaymentRequired("积分不足，请充值或开通会员后重试")
			}
			return nil, huma.Error500InternalServerError("Failed to reserve credits: " + rerr.Error())
		}
		req.CreditCost = cost
	}

	// ─── Asynq durable path ────────────────────────────────────────
	// When the task queue is wired up (REDIS_ADDR set + tasks worker
	// running), we persist the full request and enqueue. The handler
	// returns 'queued' immediately; the worker picks up and writes
	// the outcome. Survives backend restart.
	if h.tasks != nil && h.tasks.Enabled() && h.q != nil {
		out, eerr := h.enqueueGeneration(ctx, userID, userIDStr, req, input)
		if eerr != nil {
			// Enqueue failed → no worker will run → return the reserve.
			h.svc.RefundCredits(ctx, userIDStr, req.CreditCost, "refund: enqueue failed")
		}
		return out, eerr
	}

	// ─── Legacy inline path ────────────────────────────────────────
	// Concurrency cap: wait for a slot in the limiter; abort if client cancels.
	// Only applied to the inline path — Asynq has its own bounded worker pool.
	select {
	case h.generateLimiter <- struct{}{}:
		defer func() { <-h.generateLimiter }()
	case <-ctx.Done():
		// Never started → return the reserve.
		h.svc.RefundCredits(ctx, userIDStr, req.CreditCost, "refund: canceled before slot")
		return nil, huma.Error408RequestTimeout("Request canceled while waiting for a generation slot")
	}

	// Best-effort: write a 'pending' log row before invoking the provider.
	// The service goroutine will flip this row to success/error when the
	// upstream task finishes (which may be after this handler has already
	// returned to the client).
	//
	// P0-5: when the client sent a request_id, the insert is IDEMPOTENT
	// (ON CONFLICT request_id DO NOTHING) — the inline path previously had no
	// dedup at all, so a double-click ran (and charged) two generations.
	var logID pgtype.UUID
	if h.q != nil {
		var pgReqID pgtype.UUID
		if cid := strings.TrimSpace(req.RequestID); cid != "" {
			if parsedReqID, perr := uuid.Parse(cid); perr == nil {
				_ = pgReqID.Scan(parsedReqID.String())
			}
		}
		if pgReqID.Valid {
			logRow, lerr := h.q.InsertGenerationLogPendingIdempotent(ctx, sqlc.InsertGenerationLogQueuedParams{
				UserID:      userID,
				NodeID:      input.Body.NodeId,
				ServiceType: input.Body.ServiceType,
				Model:       input.Body.Model,
				Prompt:      input.Body.Prompt,
				RequestID:   pgReqID,
			})
			if lerr == nil {
				logID = logRow.ID
			} else if errors.Is(lerr, pgx.ErrNoRows) {
				// Duplicate submit lost the race: reuse the winner's task and
				// return the duplicate's reserve.
				if existing, derr := h.q.GetGenerationLogByRequestID(ctx, pgReqID); derr == nil {
					if req.CreditCost > 0 {
						h.svc.RefundCredits(ctx, userIDStr, req.CreditCost, "refund: idempotent replay (inline duplicate)")
					}
					out := &generateOutput{}
					out.Body.Data.GenerateResult = application.GenerateResult{Type: "queued", Content: ""}
					out.Body.Data.TaskID = formatPgUUID(existing.ID)
					out.Body.RequestID = httpx.RequestIDFrom(ctx)
					return out, nil
				}
			}
		} else if logRow, lerr := h.q.InsertGenerationLog(ctx, sqlc.InsertGenerationLogParams{
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

	var logIDStr string
	if logID.Valid {
		logIDStr = formatPgUUID(logID)
	}
	req.GenerationLogID = logIDStr
	result, err := h.svc.Generate(ctx, req)

	// NOTE: writing the final outcome to generation_logs is now owned by the
	// detached goroutine inside service.Generate (see persistGenerationOutcome).
	// We intentionally do NOT update the log here. If the client times out the
	// handler returns 408 immediately while the upstream task keeps running;
	// the goroutine writes the eventual success/error itself when it finishes,
	// so the log row reflects reality instead of a premature "client gave up".

	if err != nil {
		return nil, toHTTPError(err)
	}
	out := &generateOutput{}
	out.Body.Data.GenerateResult = *result
	if logID.Valid {
		out.Body.Data.TaskID = formatPgUUID(logID)
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// enqueueGeneration is the Asynq path of generate(). Steps:
//
//  1. Generate a server-side request_id UUID (frontend-supplied
//     request_id support comes in P6).
//  2. Marshal the GenerateRequest into JSONB and INSERT a 'queued' row.
//  3. Enqueue an Asynq task carrying the log_id + request_id + a small
//     routing header. The worker re-hydrates the full request from DB.
//  4. Return {task_id: log_id} immediately. The frontend's existing
//     polling/SSE machinery resumes from there — no client changes
//     required for this phase.
//
// On any failure during the enqueue (DB write, Redis push) we surface
// it as a 5xx; we deliberately don't fall back to the inline path here.
// The inline path skipping its DB write would be silent data loss.
func (h *Handler) enqueueGeneration(
	ctx context.Context,
	userID pgtype.UUID,
	userIDStr string,
	req application.GenerateRequest,
	input *generateInput,
) (*generateOutput, error) {
	// 1. request_id — prefer the client-supplied idempotency key (F6) so a
	// retried POST / double-click collapses to one task. Fall back to a
	// server-generated UUID when the client didn't send one (or sent a
	// malformed value) so older clients keep working.
	reqID := uuid.New()
	if cid := strings.TrimSpace(req.RequestID); cid != "" {
		if parsed, perr := uuid.Parse(cid); perr == nil {
			reqID = parsed
		}
	}
	var pgReqID pgtype.UUID
	_ = pgReqID.Scan(reqID.String())

	// 2. Persist queued row with full request payload.
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to encode generation request: " + err.Error())
	}
	row, err := h.q.InsertGenerationLogQueued(ctx, sqlc.InsertGenerationLogQueuedParams{
		UserID:         userID,
		NodeID:         input.Body.NodeId,
		ServiceType:    input.Body.ServiceType,
		Model:          input.Body.Model,
		Prompt:         input.Body.Prompt,
		RequestID:      pgReqID,
		RequestPayload: payload,
	})
	if err != nil {
		// Idempotency replay: if the same request_id raced in, return
		// the existing row instead of a duplicate. (Server-generated
		// UUIDs collide ~never, so this is defense-in-depth for P6.)
		if errors.Is(err, pgx.ErrNoRows) {
			row, err = h.q.GetGenerationLogByRequestID(ctx, pgReqID)
			// Idempotent replay: a task already exists for this request_id and
			// no new work will run, but generate() already reserved credits
			// up-front for this duplicate submit. Refund that reserve so a
			// double-click / client retry is charged exactly once.
			if err == nil && req.CreditCost > 0 {
				h.svc.RefundCredits(ctx, userIDStr, req.CreditCost, "refund: idempotent replay (duplicate request_id)")
			}
		}
		if err != nil {
			return nil, huma.Error500InternalServerError("Failed to persist queued task: " + err.Error())
		}
	}
	logIDStr := formatPgUUID(row.ID)

	// 3. Hand off to Asynq.
	asynqTaskID, err := h.tasks.Enqueue(ctx, TaskGenerationPayload{
		LogID:       logIDStr,
		RequestID:   reqID.String(),
		UserID:      userIDStr,
		ServiceType: input.Body.ServiceType,
		Model:       input.Body.Model,
		NodeID:      input.Body.NodeId,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to enqueue task: " + err.Error())
	}
	// Best-effort: stash the asynq task id on the log row for later
	// cancel lookups. Failure here is non-fatal.
	if asynqTaskID != "" {
		_ = h.q.MarkGenerationLogAsynqTaskID(ctx, row.ID, asynqTaskID)
	}

	// 4. Return queued response. The Data.GenerateResult is empty —
	// frontend's polling/SSE will fill it in once the worker writes
	// the outcome.
	out := &generateOutput{}
	out.Body.Data.GenerateResult = application.GenerateResult{
		Type:    "queued",
		Content: "",
	}
	out.Body.Data.TaskID = logIDStr
	if h.cache != nil {
		h.cache.Set(ctx, taskCacheKey(userIDStr, logIDStr), TaskItem{
			ID:          logIDStr,
			NodeID:      input.Body.NodeId,
			ServiceType: input.Body.ServiceType,
			Model:       input.Body.Model,
			Status:      "queued",
			ResultURL:   "",
			ErrorMsg:    "",
			DurationMs:  0,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		}, 15*time.Minute)
	}
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
