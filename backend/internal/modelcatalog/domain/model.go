// Package domain contains the model catalog bounded context domain types.
package domain

import (
	"encoding/json"
	"time"
)

// Capability represents the generation capability of a model.
type Capability string

const (
	CapabilityText  Capability = "text"
	CapabilityImage Capability = "image"
	CapabilityVideo Capability = "video"
	CapabilityAudio Capability = "audio"
)

// ModelStatus represents the lifecycle state of a model definition.
type ModelStatus string

const (
	StatusDraft    ModelStatus = "draft"
	StatusEnabled  ModelStatus = "enabled"
	StatusDisabled ModelStatus = "disabled"
)

// RelayProvider holds the configuration for a single relay/aggregation platform.
// In the first version only one provider is supported.
type RelayProvider struct {
	ID              string
	Name            string
	ProviderType    string
	BaseURL         string
	EncryptedAPIKey string // AES-GCM encrypted; never returned to frontend
	Status          string
	LastSyncAt      *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// ProviderStatus is the demasked view of a relay provider returned to the admin UI.
type ProviderStatus struct {
	HasProvider bool
	BaseURL     string
	APIKeySet   bool
	APIKeyHint  string // e.g. "****1a2b", empty when not set
	Status      string
	LastSyncAt  *time.Time
}

// ModelDefinition represents a model available through the relay provider.
type ModelDefinition struct {
	ID                string
	ProviderID        string
	ExternalModelName string
	DisplayName       string
	Capability        Capability
	Status            ModelStatus
	ParameterSchema   json.RawMessage
	DefaultParameters json.RawMessage
	PricingRule       json.RawMessage
	CostSnapshot      json.RawMessage
	SortOrder         int32
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// HasPricing returns true when the model has a non-empty pricing rule.
func (m ModelDefinition) HasPricing() bool {
	raw := []byte(m.PricingRule)
	return len(raw) > 0 && string(raw) != "{}"
}

// UserModel is the trimmed view of a model returned to the user app.
// It never includes pricing internals or cost snapshots.
type UserModel struct {
	ID                string
	ExternalModelName string
	DisplayName       string
	Capability        Capability
	ParameterSchema   json.RawMessage
	DefaultParameters json.RawMessage
}

// ProviderConfig represents a multi-vendor model configuration entry.
// Each record maps to one row in the admin model config table.
type ProviderConfig struct {
	ID             string
	ServiceType    string // text / image / video / audio
	Vendor         string // OpenAI / Runway / Luma / 自定义
	Name           string
	APISpec        string // openai / custom
	BaseURL        string
	EncryptedAPIKey string
	SubmitEndpoint string
	QueryEndpoint  string
	ModelList      []string
	DefaultModel   string
	Priority       int32
	IsDefault      bool
	Status         string // enabled / disabled
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// APIKeyHint returns a masked hint for the API key (e.g. "****abcd").
func (pc ProviderConfig) APIKeyHint() string {
	if pc.EncryptedAPIKey == "" {
		return ""
	}
	if len(pc.EncryptedAPIKey) >= 4 {
		return "****" + pc.EncryptedAPIKey[len(pc.EncryptedAPIKey)-4:]
	}
	return "****"
}

// AppProviderConfig is the trimmed view returned to regular users.
type AppProviderConfig struct {
	ID          string
	ServiceType string
	Vendor      string
	Name        string
	ModelList   []string
	DefaultModel string
	Priority    int32
}
