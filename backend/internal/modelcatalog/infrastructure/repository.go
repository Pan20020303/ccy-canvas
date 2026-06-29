// Package infrastructure provides the PostgreSQL-backed repository for the model catalog.
package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/database/sqlc"
)

// Repository implements modelcatalog/application.Repository using sqlc-generated queries.
type Repository struct {
	q *sqlc.Queries
}

// NewRepository creates a new model catalog Repository.
func NewRepository(q *sqlc.Queries) *Repository {
	return &Repository{q: q}
}

// --- conversion helpers ---

func pgUUID(u uuid.UUID) pgtype.UUID {
	return pgtype.UUID{Bytes: u, Valid: true}
}

func parsePgUUID(s string) (pgtype.UUID, error) {
	u, err := uuid.Parse(s)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return pgUUID(u), nil
}

func uuidStr(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	return uuid.UUID(u.Bytes).String()
}

func classifyErrorCode(msg string) string {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "permission_error") || strings.Contains(lower, "forbidden") || strings.Contains(lower, "http 403"):
		return "permission_error"
	case strings.Contains(lower, "rate_limit") || strings.Contains(lower, "http 429") || strings.Contains(lower, "concurrency"):
		return "rate_limit_error"
	case strings.Contains(lower, "service_unavailable") || strings.Contains(lower, "overloaded") || strings.Contains(lower, "http 502") || strings.Contains(lower, "http 503"):
		return "service_unavailable_error"
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded"):
		return "timeout_error"
	default:
		return "upstream_error"
	}
}

func toProvider(p sqlc.RelayProvider) *domain.RelayProvider {
	var lastSync *time.Time
	if p.LastSyncAt.Valid {
		t := p.LastSyncAt.Time
		lastSync = &t
	}
	return &domain.RelayProvider{
		ID:              uuidStr(p.ID),
		Name:            p.Name,
		ProviderType:    p.ProviderType,
		BaseURL:         p.BaseUrl,
		EncryptedAPIKey: p.EncryptedApiKey,
		Status:          p.Status,
		LastSyncAt:      lastSync,
		CreatedAt:       p.CreatedAt.Time,
		UpdatedAt:       p.UpdatedAt.Time,
	}
}

// timestampPtr converts a pgtype.Timestamptz to *time.Time so the domain
// layer can distinguish "never happened" (nil) from "happened in the past"
// (non-nil but stale) — important for the cooldown / failure tracking.
func timestampPtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

func toProviderConfig(p sqlc.ProviderConfig) domain.ProviderConfig {
	return domain.ProviderConfig{
		ID:              uuidStr(p.ID),
		ServiceType:     p.ServiceType,
		Vendor:          p.Vendor,
		Name:            p.Name,
		APISpec:         p.ApiSpec,
		Protocol:        p.Protocol,
		BaseURL:         p.BaseUrl,
		EncryptedAPIKey: p.EncryptedApiKey,
		SubmitEndpoint:  p.SubmitEndpoint,
		QueryEndpoint:   p.QueryEndpoint,
		ModelList:       p.ModelList,
		DefaultModel:    p.DefaultModel,
		Priority:        p.Priority,
		IsDefault:       p.IsDefault,
		Status:          p.Status,
		Capabilities:    p.Capabilities,
		ParameterSchema: rawJSON(p.ParameterSchema),
		AdapterRuntime:  p.AdapterRuntime,
		AdapterCode:     p.AdapterCode,
		AdapterChecksum: p.AdapterChecksum,
		IconKey:         p.IconKey,
		IconURL:         p.IconUrl,
		CreatedAt:       p.CreatedAt.Time,
		UpdatedAt:       p.UpdatedAt.Time,
		// Channel health (migration 011).
		FailureCount:         p.FailureCount,
		LastFailureAt:        timestampPtr(p.LastFailureAt),
		LastErrorMsg:         p.LastErrorMsg,
		LastErrorCode:        p.LastErrorCode,
		LastSuccessAt:        timestampPtr(p.LastSuccessAt),
		CooldownUntil:        timestampPtr(p.CooldownUntil),
		ConsecutiveCooldowns: p.ConsecutiveCooldowns,
	}
}

func toAdminAlert(row sqlc.AdminAlert) domain.AdminAlert {
	alert := domain.AdminAlert{
		ID:           uuidStr(row.ID),
		ServiceType:  row.ServiceType,
		Model:        row.Model,
		ErrorCode:    row.ErrorCode,
		ErrorMessage: row.ErrorMessage,
		Source:       row.Source,
		Severity:     row.Severity,
		Status:       row.Status,
		ProviderName: row.ProviderName,
	}
	if row.ProviderConfigID.Valid {
		alert.ProviderConfigID = uuidStr(row.ProviderConfigID)
	}
	if row.GenerationLogID.Valid {
		alert.GenerationLogID = uuidStr(row.GenerationLogID)
	}
	if row.CreatedAt.Valid {
		alert.CreatedAt = row.CreatedAt.Time
	}
	if row.LastSeenAt.Valid {
		alert.LastSeenAt = row.LastSeenAt.Time
	}
	return alert
}

func toAppProviderConfig(p sqlc.ListEnabledProviderConfigsRow) domain.AppProviderConfig {
	return domain.AppProviderConfig{
		ID:              uuidStr(p.ID),
		ServiceType:     p.ServiceType,
		Vendor:          p.Vendor,
		Name:            p.Name,
		ModelList:       p.ModelList,
		DefaultModel:    p.DefaultModel,
		Priority:        p.Priority,
		ParameterSchema: rawJSON(p.ParameterSchema),
		IconKey:         p.IconKey,
		IconURL:         p.IconUrl,
	}
}

func rawJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

func toModelDefinition(m sqlc.ModelDefinition) domain.ModelDefinition {
	return domain.ModelDefinition{
		ID:                uuidStr(m.ID),
		ProviderID:        uuidStr(m.ProviderID),
		ExternalModelName: m.ExternalModelName,
		DisplayName:       m.DisplayName,
		Capability:        domain.Capability(m.Capability),
		Status:            domain.ModelStatus(m.Status),
		ParameterSchema:   rawJSON(m.ParameterSchema),
		DefaultParameters: rawJSON(m.DefaultParameters),
		PricingRule:       rawJSON(m.PricingRule),
		CostSnapshot:      rawJSON(m.CostSnapshot),
		SortOrder:         m.SortOrder,
		CreatedAt:         m.CreatedAt.Time,
		UpdatedAt:         m.UpdatedAt.Time,
	}
}

func toModelFromRow(m sqlc.ListEnabledModelDefinitionsRow) domain.ModelDefinition {
	return domain.ModelDefinition{
		ID:                uuidStr(m.ID),
		ProviderID:        uuidStr(m.ProviderID),
		ExternalModelName: m.ExternalModelName,
		DisplayName:       m.DisplayName,
		Capability:        domain.Capability(m.Capability),
		Status:            domain.ModelStatus(m.Status),
		ParameterSchema:   rawJSON(m.ParameterSchema),
		DefaultParameters: rawJSON(m.DefaultParameters),
		PricingRule:       rawJSON(m.PricingRule),
		SortOrder:         m.SortOrder,
	}
}

// --- RelayProvider ---

func (r *Repository) GetRelayProvider(ctx context.Context) (*domain.RelayProvider, error) {
	p, err := r.q.GetRelayProvider(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return toProvider(p), nil
}

func (r *Repository) CreateRelayProvider(ctx context.Context, name, providerType, baseURL, encryptedKey string) (*domain.RelayProvider, error) {
	p, err := r.q.CreateRelayProvider(ctx, sqlc.CreateRelayProviderParams{
		Name:            name,
		ProviderType:    providerType,
		BaseUrl:         baseURL,
		EncryptedApiKey: encryptedKey,
	})
	if err != nil {
		return nil, err
	}
	return toProvider(p), nil
}

func (r *Repository) UpdateRelayProvider(ctx context.Context, id, baseURL, encryptedKey string) (*domain.RelayProvider, error) {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return nil, err
	}
	p, err := r.q.UpdateRelayProvider(ctx, sqlc.UpdateRelayProviderParams{
		ID:              pgID,
		BaseUrl:         baseURL,
		EncryptedApiKey: encryptedKey,
	})
	if err != nil {
		return nil, err
	}
	return toProvider(p), nil
}

func (r *Repository) SetRelayProviderLastSync(ctx context.Context, id string) error {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return err
	}
	return r.q.SetRelayProviderLastSync(ctx, pgID)
}

// --- ModelDefinition ---

func (r *Repository) ListModelDefinitions(ctx context.Context) ([]domain.ModelDefinition, error) {
	rows, err := r.q.ListModelDefinitions(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]domain.ModelDefinition, 0, len(rows))
	for _, row := range rows {
		result = append(result, toModelDefinition(row))
	}
	return result, nil
}

func (r *Repository) ListEnabledModelDefinitions(ctx context.Context, userID, role string) ([]domain.ModelDefinition, error) {
	pgUserID, err := parsePgUUID(userID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListEnabledModelDefinitions(ctx, sqlc.ListEnabledModelDefinitionsParams{
		UserID: pgUserID,
		Role:   pgtype.Text{String: role, Valid: role != ""},
	})
	if err != nil {
		return nil, err
	}
	result := make([]domain.ModelDefinition, 0, len(rows))
	for _, row := range rows {
		result = append(result, toModelFromRow(row))
	}
	return result, nil
}

func (r *Repository) GetModelDefinitionByID(ctx context.Context, id string) (*domain.ModelDefinition, error) {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return nil, err
	}
	m, err := r.q.GetModelDefinitionByID(ctx, pgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	def := toModelDefinition(m)
	return &def, nil
}

func (r *Repository) InsertModelDefinitionIfNotExists(ctx context.Context, providerID, externalName, displayName, capability string) (*domain.ModelDefinition, error) {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return nil, err
	}
	m, err := r.q.InsertModelDefinitionIfNotExists(ctx, sqlc.InsertModelDefinitionIfNotExistsParams{
		ProviderID:        pgID,
		ExternalModelName: externalName,
		DisplayName:       displayName,
		Capability:        capability,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Already exists — ON CONFLICT DO NOTHING returned no rows.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	def := toModelDefinition(m)
	return &def, nil
}

func (r *Repository) UpdateModelDefinition(ctx context.Context, id, displayName, capability string,
	paramSchema, defaultParams, pricingRule json.RawMessage, sortOrder int32) (*domain.ModelDefinition, error) {

	pgID, err := parsePgUUID(id)
	if err != nil {
		return nil, err
	}
	m, err := r.q.UpdateModelDefinition(ctx, sqlc.UpdateModelDefinitionParams{
		ID:                pgID,
		DisplayName:       displayName,
		Capability:        capability,
		ParameterSchema:   []byte(paramSchema),
		DefaultParameters: []byte(defaultParams),
		PricingRule:       []byte(pricingRule),
		SortOrder:         sortOrder,
	})
	if err != nil {
		return nil, err
	}
	def := toModelDefinition(m)
	return &def, nil
}

func (r *Repository) SetModelStatus(ctx context.Context, id, status string) (*domain.ModelDefinition, error) {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return nil, err
	}
	m, err := r.q.SetModelStatus(ctx, sqlc.SetModelStatusParams{
		ID:     pgID,
		Status: status,
	})
	if err != nil {
		return nil, err
	}
	def := toModelDefinition(m)
	return &def, nil
}

// --- ProviderConfig ---

func (r *Repository) ListProviderConfigs(ctx context.Context) ([]domain.ProviderConfig, error) {
	rows, err := r.q.ListProviderConfigs(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]domain.ProviderConfig, 0, len(rows))
	for _, row := range rows {
		result = append(result, toProviderConfig(row))
	}
	return result, nil
}

func (r *Repository) GetProviderConfigByID(ctx context.Context, id string) (*domain.ProviderConfig, error) {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return nil, err
	}
	p, err := r.q.GetProviderConfigByID(ctx, pgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pc := toProviderConfig(p)
	return &pc, nil
}

func (r *Repository) CreateProviderConfig(ctx context.Context, pc domain.ProviderConfig) (*domain.ProviderConfig, error) {
	row, err := r.q.CreateProviderConfig(ctx, sqlc.CreateProviderConfigParams{
		ServiceType:     pc.ServiceType,
		Vendor:          pc.Vendor,
		Name:            pc.Name,
		ApiSpec:         pc.APISpec,
		Protocol:        pc.Protocol,
		BaseUrl:         pc.BaseURL,
		EncryptedApiKey: pc.EncryptedAPIKey,
		SubmitEndpoint:  pc.SubmitEndpoint,
		QueryEndpoint:   pc.QueryEndpoint,
		ModelList:       pc.ModelList,
		DefaultModel:    pc.DefaultModel,
		Priority:        pc.Priority,
		IsDefault:       pc.IsDefault,
		Status:          pc.Status,
		Capabilities:    pc.Capabilities,
		ParameterSchema: []byte(rawJSON(pc.ParameterSchema)),
		AdapterRuntime:  pc.AdapterRuntime,
		AdapterCode:     pc.AdapterCode,
		AdapterChecksum: pc.AdapterChecksum,
		IconKey:         pc.IconKey,
		IconUrl:         pc.IconURL,
	})
	if err != nil {
		return nil, err
	}
	result := toProviderConfig(row)
	return &result, nil
}

func (r *Repository) UpdateProviderConfig(ctx context.Context, pc domain.ProviderConfig) (*domain.ProviderConfig, error) {
	pgID, err := parsePgUUID(pc.ID)
	if err != nil {
		return nil, err
	}
	row, err := r.q.UpdateProviderConfig(ctx, sqlc.UpdateProviderConfigParams{
		ID:              pgID,
		ServiceType:     pc.ServiceType,
		Vendor:          pc.Vendor,
		Name:            pc.Name,
		ApiSpec:         pc.APISpec,
		Protocol:        pc.Protocol,
		BaseUrl:         pc.BaseURL,
		EncryptedApiKey: pc.EncryptedAPIKey,
		SubmitEndpoint:  pc.SubmitEndpoint,
		QueryEndpoint:   pc.QueryEndpoint,
		ModelList:       pc.ModelList,
		DefaultModel:    pc.DefaultModel,
		Priority:        pc.Priority,
		IsDefault:       pc.IsDefault,
		Status:          pc.Status,
		Capabilities:    pc.Capabilities,
		ParameterSchema: []byte(rawJSON(pc.ParameterSchema)),
		AdapterRuntime:  pc.AdapterRuntime,
		AdapterCode:     pc.AdapterCode,
		AdapterChecksum: pc.AdapterChecksum,
		IconKey:         pc.IconKey,
		IconUrl:         pc.IconURL,
	})
	if err != nil {
		return nil, err
	}
	result := toProviderConfig(row)
	return &result, nil
}

func (r *Repository) DeleteProviderConfig(ctx context.Context, id string) error {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return err
	}
	return r.q.DeleteProviderConfig(ctx, pgID)
}

func (r *Repository) ListEnabledProviderConfigs(ctx context.Context) ([]domain.AppProviderConfig, error) {
	rows, err := r.q.ListEnabledProviderConfigs(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]domain.AppProviderConfig, 0, len(rows))
	for _, row := range rows {
		result = append(result, toAppProviderConfig(row))
	}
	return result, nil
}

// ─── Channel health (migration 011) ─────────────────────────────────────────

func (r *Repository) MarkChannelSuccess(ctx context.Context, providerID string) error {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return err
	}
	return r.q.MarkChannelSuccess(ctx, pgID)
}

func (r *Repository) IncrementChannelFailure(ctx context.Context, providerID, errMsg string) (int32, int32, error) {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return 0, 0, err
	}
	row, err := r.q.IncrementChannelFailure(ctx, pgID, errMsg, classifyErrorCode(errMsg))
	if err != nil {
		return 0, 0, err
	}
	return row.FailureCount, row.ConsecutiveCooldowns, nil
}

func (r *Repository) SetChannelCooldown(ctx context.Context, providerID string, until time.Time) error {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return err
	}
	return r.q.SetChannelCooldown(ctx, pgID, pgtype.Timestamptz{Time: until, Valid: true})
}

func (r *Repository) ResetChannelHealth(ctx context.Context, providerID string) error {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return err
	}
	return r.q.ResetChannelHealth(ctx, pgID)
}

func (r *Repository) MarkChannelTimeout(ctx context.Context, providerID string) error {
	pgID, err := parsePgUUID(providerID)
	if err != nil {
		return err
	}
	return r.q.MarkChannelTimeout(ctx, pgID)
}

func (r *Repository) UpdateGenerationLogResult(ctx context.Context, logID, status, resultURL, errMsg string, durationMs int32, cacheHit bool) error {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return err
	}
	return r.q.UpdateGenerationLogResult(ctx, sqlc.UpdateGenerationLogResultParams{
		ID:         pgID,
		Status:     status,
		ResultUrl:  resultURL,
		ErrorMsg:   errMsg,
		DurationMs: durationMs,
		CacheHit:   cacheHit,
	})
}

func (r *Repository) MarkGenerationLogPersisting(ctx context.Context, logID string, staged application.StagedAsset, durationMs int32) error {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return err
	}
	return r.q.MarkGenerationLogPersisting(ctx, sqlc.MarkGenerationLogPersistingParams{
		ID:          pgID,
		StagingPath: staged.LocalPath,
		StagingUrl:  staged.StagingURL,
		CosKey:      staged.COSKey,
		ContentType: staged.ContentType,
		DurationMs:  durationMs,
	})
}

func (r *Repository) MarkGenerationLogAssetReady(ctx context.Context, logID, cosURL string, durationMs int32) error {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return err
	}
	return r.q.MarkGenerationLogAssetReady(ctx, sqlc.MarkGenerationLogAssetReadyParams{
		ID:         pgID,
		CosUrl:     cosURL,
		DurationMs: durationMs,
	})
}

func (r *Repository) MarkGenerationLogAssetFailed(ctx context.Context, logID, status, errMsg string) error {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return err
	}
	return r.q.MarkGenerationLogAssetFailed(ctx, pgID, status, errMsg)
}

func (r *Repository) ListStaleActiveGenerations(ctx context.Context, olderThan time.Time) ([]domain.StaleGeneration, error) {
	rows, err := r.q.ListStaleActiveGenerations(ctx, olderThan)
	if err != nil {
		return nil, err
	}
	out := make([]domain.StaleGeneration, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.StaleGeneration{
			ID:          uuidStr(row.ID),
			UserID:      uuidStr(row.UserID),
			NodeID:      row.NodeID,
			ServiceType: row.ServiceType,
			Status:      row.Status,
			CreditCost:  row.CreditCost,
			CreatedAt:   row.CreatedAt.Time,
		})
	}
	return out, nil
}

func (r *Repository) MarkGenerationTimedOut(ctx context.Context, logID, errMsg string) (bool, error) {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return false, err
	}
	n, err := r.q.MarkGenerationLogTimedOut(ctx, pgID, errMsg)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (r *Repository) InsertGenerationAttempt(ctx context.Context, attempt domain.GenerationAttempt) error {
	var logID pgtype.UUID
	if attempt.GenerationLogID != "" {
		if id, err := parsePgUUID(attempt.GenerationLogID); err == nil {
			logID = id
		}
	}
	var provID pgtype.UUID
	if attempt.ProviderConfigID != "" {
		if id, err := parsePgUUID(attempt.ProviderConfigID); err == nil {
			provID = id
		}
	}
	var httpStatus pgtype.Int4
	if attempt.HTTPStatus > 0 {
		httpStatus = pgtype.Int4{Int32: attempt.HTTPStatus, Valid: true}
	}
	var duration pgtype.Int4
	if attempt.DurationMs > 0 {
		duration = pgtype.Int4{Int32: attempt.DurationMs, Valid: true}
	}
	_, err := r.q.InsertGenerationAttempt(ctx, sqlc.InsertGenerationAttemptParams{
		GenerationLogID:  logID,
		ProviderConfigID: provID,
		Vendor:           attempt.Vendor,
		AttemptNumber:    attempt.AttemptNumber,
		HttpStatus:       httpStatus,
		ErrorMsg:         attempt.ErrorMsg,
		DurationMs:       duration,
	})
	return err
}

func (r *Repository) ListGenerationAttemptsByLog(ctx context.Context, logID string) ([]domain.GenerationAttempt, error) {
	pgID, err := parsePgUUID(logID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListGenerationAttemptsByLog(ctx, pgID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.GenerationAttempt, 0, len(rows))
	for _, row := range rows {
		item := domain.GenerationAttempt{
			ID:              uuidStr(row.ID),
			GenerationLogID: uuidStr(row.GenerationLogID),
			Vendor:          row.Vendor,
			AttemptNumber:   row.AttemptNumber,
			ErrorMsg:        row.ErrorMsg,
			CreatedAt:       row.CreatedAt.Time,
		}
		if row.ProviderConfigID.Valid {
			item.ProviderConfigID = uuidStr(row.ProviderConfigID)
		}
		if row.HttpStatus.Valid {
			item.HTTPStatus = row.HttpStatus.Int32
		}
		if row.DurationMs.Valid {
			item.DurationMs = row.DurationMs.Int32
		}
		out = append(out, item)
	}
	return out, nil
}

func (r *Repository) CreateAdminAlert(ctx context.Context, alert domain.AdminAlert) error {
	var providerID pgtype.UUID
	if alert.ProviderConfigID != "" {
		if id, err := parsePgUUID(alert.ProviderConfigID); err == nil {
			providerID = id
		}
	}
	var logID pgtype.UUID
	if alert.GenerationLogID != "" {
		if id, err := parsePgUUID(alert.GenerationLogID); err == nil {
			logID = id
		}
	}
	_, err := r.q.UpsertAdminAlert(ctx, sqlc.UpsertAdminAlertParams{
		ProviderConfigID: providerID,
		GenerationLogID:  logID,
		ServiceType:      alert.ServiceType,
		Model:            alert.Model,
		ErrorCode:        alert.ErrorCode,
		ErrorMessage:     alert.ErrorMessage,
		Source:           alert.Source,
		Severity:         alert.Severity,
	})
	return err
}

func (r *Repository) ListAdminAlerts(ctx context.Context, status string, limit, offset int32) ([]domain.AdminAlert, error) {
	rows, err := r.q.ListAdminAlerts(ctx, sqlc.ListAdminAlertsParams{
		Status: status,
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		return nil, err
	}
	out := make([]domain.AdminAlert, 0, len(rows))
	for _, row := range rows {
		out = append(out, toAdminAlert(row))
	}
	return out, nil
}

func (r *Repository) CountUnreadAdminAlerts(ctx context.Context) (int32, error) {
	return r.q.CountUnreadAdminAlerts(ctx)
}

func (r *Repository) MarkAdminAlertRead(ctx context.Context, id string) error {
	pgID, err := parsePgUUID(id)
	if err != nil {
		return err
	}
	return r.q.MarkAdminAlertRead(ctx, pgID)
}

func (r *Repository) MarkAllAdminAlertsRead(ctx context.Context) error {
	return r.q.MarkAllAdminAlertsRead(ctx)
}
