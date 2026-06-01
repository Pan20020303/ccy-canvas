package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

type fakeRepository struct {
	provider       *domain.RelayProvider
	models         []domain.ModelDefinition
	existingModels map[string]bool
	lastSyncID     string
	statusUpdates  map[string]string
	listUserID     string
	listRole       string
}

func (r *fakeRepository) GetRelayProvider(context.Context) (*domain.RelayProvider, error) {
	return r.provider, nil
}

func (r *fakeRepository) CreateRelayProvider(context.Context, string, string, string, string) (*domain.RelayProvider, error) {
	panic("not used")
}

func (r *fakeRepository) UpdateRelayProvider(context.Context, string, string, string) (*domain.RelayProvider, error) {
	panic("not used")
}

func (r *fakeRepository) SetRelayProviderLastSync(_ context.Context, id string) error {
	r.lastSyncID = id
	return nil
}

func (r *fakeRepository) ListModelDefinitions(context.Context) ([]domain.ModelDefinition, error) {
	panic("not used")
}

func (r *fakeRepository) ListEnabledModelDefinitions(_ context.Context, userID, role string) ([]domain.ModelDefinition, error) {
	r.listUserID = userID
	r.listRole = role
	return r.models, nil
}

func (r *fakeRepository) GetModelDefinitionByID(_ context.Context, id string) (*domain.ModelDefinition, error) {
	for _, model := range r.models {
		if model.ID == id {
			copy := model
			return &copy, nil
		}
	}
	return nil, nil
}

func (r *fakeRepository) InsertModelDefinitionIfNotExists(_ context.Context, _ string, externalName, _ string, _ string) (*domain.ModelDefinition, error) {
	if r.existingModels[externalName] {
		return nil, nil
	}
	r.existingModels[externalName] = true
	return &domain.ModelDefinition{ExternalModelName: externalName}, nil
}

func (r *fakeRepository) UpdateModelDefinition(context.Context, string, string, string, json.RawMessage, json.RawMessage, json.RawMessage, int32) (*domain.ModelDefinition, error) {
	panic("not used")
}

func (r *fakeRepository) SetModelStatus(_ context.Context, id, status string) (*domain.ModelDefinition, error) {
	if r.statusUpdates == nil {
		r.statusUpdates = map[string]string{}
	}
	r.statusUpdates[id] = status
	return &domain.ModelDefinition{ID: id, Status: domain.ModelStatus(status)}, nil
}

func (r *fakeRepository) ListProviderConfigs(context.Context) ([]domain.ProviderConfig, error) {
	return nil, nil
}

func (r *fakeRepository) GetProviderConfigByID(context.Context, string) (*domain.ProviderConfig, error) {
	return nil, nil
}

func (r *fakeRepository) CreateProviderConfig(context.Context, domain.ProviderConfig) (*domain.ProviderConfig, error) {
	panic("not used")
}

func (r *fakeRepository) UpdateProviderConfig(context.Context, domain.ProviderConfig) (*domain.ProviderConfig, error) {
	panic("not used")
}

func (r *fakeRepository) DeleteProviderConfig(context.Context, string) error {
	panic("not used")
}

func (r *fakeRepository) ListEnabledProviderConfigs(context.Context) ([]domain.AppProviderConfig, error) {
	return nil, nil
}

func TestSyncModelsCountsOnlyNewDrafts(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-api-key" {
			t.Fatalf("Authorization header = %q", got)
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"already-there"},{"id":"new-model"}]}`))
	}))
	defer server.Close()

	repo := &fakeRepository{
		provider: &domain.RelayProvider{
			ID:              "provider-1",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
		},
		existingModels: map[string]bool{"already-there": true},
	}
	service := NewService(repo, key)

	inserted, err := service.SyncModels(context.Background())
	if err != nil {
		t.Fatalf("SyncModels returned error: %v", err)
	}

	if inserted != 1 {
		t.Fatalf("inserted = %d, want 1", inserted)
	}
	if repo.lastSyncID != "provider-1" {
		t.Fatalf("lastSyncID = %q, want provider-1", repo.lastSyncID)
	}
}

func TestTestProviderConnectionWithDraftConfigUsesProvidedValues(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer draft-key" {
			t.Fatalf("Authorization header = %q", got)
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	service := NewService(&fakeRepository{}, key)
	if err := service.TestProviderConnectionWithConfig(context.Background(), server.URL, "draft-key"); err != nil {
		t.Fatalf("TestProviderConnectionWithConfig returned error: %v", err)
	}
}

func TestTestProviderConnectionWithDraftConfigCanReuseStoredKey(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "stored-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer stored-key" {
			t.Fatalf("Authorization header = %q", got)
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	service := NewService(&fakeRepository{
		provider: &domain.RelayProvider{BaseURL: "https://old.example.com", EncryptedAPIKey: encryptedKey},
	}, key)
	if err := service.TestProviderConnectionWithConfig(context.Background(), server.URL, ""); err != nil {
		t.Fatalf("TestProviderConnectionWithConfig returned error: %v", err)
	}
}

func TestListUserModelsOnlyReturnsEnabledModelsWithPricing(t *testing.T) {
	repo := &fakeRepository{
		models: []domain.ModelDefinition{
			{
				ID:                "priced",
				ExternalModelName: "gpt-image-2",
				DisplayName:       "GPT Image",
				Capability:        domain.CapabilityImage,
				Status:            domain.StatusEnabled,
				ParameterSchema:   json.RawMessage(`{"type":"object"}`),
				DefaultParameters: json.RawMessage(`{"size":"1024x1024"}`),
				PricingRule:       json.RawMessage(`{"unit":"image","credits":10}`),
			},
			{
				ID:                "unpriced",
				ExternalModelName: "draft-price",
				DisplayName:       "Draft Price",
				Capability:        domain.CapabilityImage,
				Status:            domain.StatusEnabled,
				ParameterSchema:   json.RawMessage(`{"type":"object"}`),
				DefaultParameters: json.RawMessage(`{}`),
				PricingRule:       json.RawMessage(`{}`),
			},
		},
	}
	service := NewService(repo, []byte("01234567890123456789012345678901"))

	models, err := service.ListUserModels(context.Background(), "user-1", "member")
	if err != nil {
		t.Fatalf("ListUserModels returned error: %v", err)
	}

	if len(models) != 1 {
		t.Fatalf("len(models) = %d, want 1", len(models))
	}
	if models[0].ID != "priced" {
		t.Fatalf("models[0].ID = %q, want priced", models[0].ID)
	}
	if repo.listUserID != "user-1" || repo.listRole != "member" {
		t.Fatalf("query context = (%q, %q), want (user-1, member)", repo.listUserID, repo.listRole)
	}
}

func TestEnableModelRequiresPricingRule(t *testing.T) {
	repo := &fakeRepository{
		models: []domain.ModelDefinition{
			{
				ID:              "unpriced",
				ParameterSchema: json.RawMessage(`{"type":"object"}`),
				PricingRule:     json.RawMessage(`{}`),
			},
		},
	}
	service := NewService(repo, []byte("01234567890123456789012345678901"))

	_, err := service.EnableModel(context.Background(), "unpriced")
	if err == nil {
		t.Fatal("expected error")
	}
	if repo.statusUpdates["unpriced"] != "" {
		t.Fatalf("status update = %q, want none", repo.statusUpdates["unpriced"])
	}
}
