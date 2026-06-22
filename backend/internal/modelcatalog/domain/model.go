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
	ID              string
	ServiceType     string // text / image / video / audio
	Vendor          string // OpenAI / Runway / Luma / 自定义
	Name            string
	APISpec         string // openai / custom
	Protocol        string // openai_compatible / newapi / native
	BaseURL         string
	EncryptedAPIKey string
	SubmitEndpoint  string
	QueryEndpoint   string
	ModelList       []string
	DefaultModel    string
	Priority        int32
	IsDefault       bool
	Status          string // enabled / disabled
	Capabilities    []string
	ParameterSchema json.RawMessage
	CreatedAt       time.Time
	UpdatedAt       time.Time
	// Channel health (migration 011). FailureCount + LastFailureAt are
	// updated on every error; CooldownUntil is set when the failure budget
	// is exhausted (default 3), with the duration growing exponentially each
	// time the channel re-enters cooldown (capped at MaxCooldown).
	FailureCount         int32
	LastFailureAt        *time.Time
	LastErrorMsg         string
	LastErrorCode        string
	LastSuccessAt        *time.Time
	CooldownUntil        *time.Time
	ConsecutiveCooldowns int32
}

// InCooldown reports whether the provider is currently sidelined. A nil
// CooldownUntil means it has never been cooled, or was explicitly reset.
func (pc ProviderConfig) InCooldown(now time.Time) bool {
	return pc.CooldownUntil != nil && pc.CooldownUntil.After(now)
}

// GenerationAttempt is one upstream HTTP call attempt. Multiple per
// generation_log when cross-vendor fallback fires.
type GenerationAttempt struct {
	ID               string
	GenerationLogID  string
	ProviderConfigID string // empty when not associated with a configured provider
	Vendor           string
	AttemptNumber    int32
	HTTPStatus       int32 // 0 = no HTTP response (network failure)
	ErrorMsg         string
	DurationMs       int32
	CreatedAt        time.Time
}

type AdminAlert struct {
	ID               string
	ProviderConfigID string
	GenerationLogID  string
	ServiceType      string
	Model            string
	ErrorCode        string
	ErrorMessage     string
	Source           string
	Severity         string
	Status           string
	ProviderName     string
	CreatedAt        time.Time
	LastSeenAt       time.Time
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
	ID              string
	ServiceType     string
	Vendor          string
	Name            string
	ModelList       []string
	DefaultModel    string
	Priority        int32
	ParameterSchema json.RawMessage
}

// StaleGeneration is a generation_logs row stuck in an active state past
// its runtime budget. Surfaced to the reaper (F3) so abandoned tasks —
// from an OOM-killed worker or a crashed legacy goroutine — get marked
// failed and the UI stops spinning forever.
type StaleGeneration struct {
	ID          string
	UserID      string
	NodeID      string
	ServiceType string
	Status      string
	CreditCost  int32
	CreatedAt   time.Time
}
