// Package infrastructure provides the PostgreSQL-backed repository for the model catalog.
package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

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

func toProviderConfig(p sqlc.ProviderConfig) domain.ProviderConfig {
	return domain.ProviderConfig{
		ID:             uuidStr(p.ID),
		ServiceType:    p.ServiceType,
		Vendor:         p.Vendor,
		Name:           p.Name,
		APISpec:        p.ApiSpec,
		BaseURL:        p.BaseUrl,
		EncryptedAPIKey: p.EncryptedApiKey,
		SubmitEndpoint: p.SubmitEndpoint,
		QueryEndpoint:  p.QueryEndpoint,
		ModelList:      p.ModelList,
		DefaultModel:   p.DefaultModel,
		Priority:       p.Priority,
		IsDefault:      p.IsDefault,
		Status:         p.Status,
		CreatedAt:      p.CreatedAt.Time,
		UpdatedAt:      p.UpdatedAt.Time,
	}
}

func toAppProviderConfig(p sqlc.ListEnabledProviderConfigsRow) domain.AppProviderConfig {
	return domain.AppProviderConfig{
		ID:           uuidStr(p.ID),
		ServiceType:  p.ServiceType,
		Vendor:       p.Vendor,
		Name:         p.Name,
		ModelList:    p.ModelList,
		DefaultModel: p.DefaultModel,
		Priority:     p.Priority,
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
		BaseUrl:         pc.BaseURL,
		EncryptedApiKey: pc.EncryptedAPIKey,
		SubmitEndpoint:  pc.SubmitEndpoint,
		QueryEndpoint:   pc.QueryEndpoint,
		ModelList:       pc.ModelList,
		DefaultModel:    pc.DefaultModel,
		Priority:        pc.Priority,
		IsDefault:       pc.IsDefault,
		Status:          pc.Status,
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
		BaseUrl:         pc.BaseURL,
		EncryptedApiKey: pc.EncryptedAPIKey,
		SubmitEndpoint:  pc.SubmitEndpoint,
		QueryEndpoint:   pc.QueryEndpoint,
		ModelList:       pc.ModelList,
		DefaultModel:    pc.DefaultModel,
		Priority:        pc.Priority,
		IsDefault:       pc.IsDefault,
		Status:          pc.Status,
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
