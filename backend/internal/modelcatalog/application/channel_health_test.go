package application

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

// Run the classifier against the well-known relay vocabulary so a future
// edit to the categorization rules doesn't silently regress.
func TestClassifyError(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		msg      string
		expected ErrorCategory
	}{
		// Transport-level: no HTTP status, message hints at a network blip.
		{"eof network", 0, "Post https://x: EOF", CategoryTransient},
		{"connection reset", 0, "connection reset by peer", CategoryTransient},
		{"unknown transport", 0, "something else", CategoryTransient},

		// Timeouts get their own bucket so they don't count toward the
		// cooldown failure budget (Stage 4 of the timeout treatment plan).
		{"transport i/o timeout", 0, "context deadline exceeded: i/o timeout", CategoryTimeout},
		{"transport deadline exceeded", 0, "context deadline exceeded", CategoryTimeout},
		{"upstream 408", 408, "Request Timeout", CategoryTimeout},
		{"client side timed out", 0, "Client.Timeout: request timed out", CategoryTimeout},

		// Channel-dead: auth / not found / rate limited — give up on this
		// channel for cooldown and move on.
		{"401 unauthorized", 401, "Bearer token invalid", CategoryChannelDead},
		{"403 forbidden", 403, "Image generation is not enabled", CategoryChannelDead},
		{"404 model missing", 404, "model_not_found", CategoryChannelDead},
		{"429 rate limited", 429, "rate limit exceeded", CategoryChannelDead},

		// Client fault — don't poison the channel, return error to user.
		{"400 bad prompt", 400, "prompt too long", CategoryClientFault},
		{"422 unprocessable", 422, "validation failed", CategoryClientFault},

		// 5xx: transient EXCEPT when the message tells us the model isn't
		// available at this relay (channel-dead, even though the status is 5xx).
		{"503 generic", 503, "service temporarily unavailable", CategoryTransient},
		{"500 generic", 500, "internal error", CategoryTransient},
		{"503 model_not_found", 503, "no available channel for model sora-v3-fast", CategoryChannelDead},
		{"503 no available endpoint", 503, "No available endpoint", CategoryChannelDead},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyError(tc.status, tc.msg); got != tc.expected {
				t.Errorf("ClassifyError(%d, %q) = %v, want %v", tc.status, tc.msg, got, tc.expected)
			}
		})
	}
}

// computeCooldown should follow the formula
//
//	initial × backoffFactor^consecutiveCooldowns, capped at maxCooldown.
//
// Verify against the user-approved defaults (initial=5min, factor=2, max=60min).
func TestComputeCooldownExponentialBackoff(t *testing.T) {
	// Save / restore the global so we don't leak test state.
	original := channelHealthConfig
	defer func() { channelHealthConfig = original }()
	channelHealthConfig = channelHealthCfg{
		failureThreshold:      3,
		initialCooldown:       5 * time.Minute,
		maxCooldown:           60 * time.Minute,
		cooldownBackoffFactor: 2,
	}

	cases := []struct {
		consecutive int32
		wantMinutes int
	}{
		{0, 5},   // first cooldown — initial only
		{1, 10},  // doubled
		{2, 20},  // doubled again
		{3, 40},  // doubled again
		{4, 60},  // would be 80 but capped at 60
		{10, 60}, // far past the cap, still 60
	}
	for _, tc := range cases {
		got := computeCooldown(tc.consecutive)
		want := time.Duration(tc.wantMinutes) * time.Minute
		if got != want {
			t.Errorf("computeCooldown(%d) = %v, want %v", tc.consecutive, got, want)
		}
	}
}

// httpStatusFromError sniffs a status code out of relay-formatted errors so
// the per-image fallback loop can categorize correctly.
func TestHttpStatusFromError(t *testing.T) {
	cases := []struct {
		input string
		want  int
	}{
		{"Provider HTTP 403: image generation not enabled", 403},
		{"LLM HTTP 503: gateway", 503},
		{"HTTP 429 too many requests", 429},
		{"some random network error", 0},
		{"", 0},
	}
	for _, tc := range cases {
		err := stubError(tc.input)
		if got := httpStatusFromError(err); got != tc.want {
			t.Errorf("httpStatusFromError(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
	// nil input should be a clean 0, not a panic.
	if got := httpStatusFromError(nil); got != 0 {
		t.Errorf("httpStatusFromError(nil) = %d, want 0", got)
	}
}

// stubError lets us pass a plain string through the err-as-input path
// without constructing a fmt-formatted error every time.
type stubError string

func (s stubError) Error() string { return string(s) }

// healthFakeRepo is a focused fake just for the channel-health policy test.
// We don't need the full fakeRepository from service_test.go (which
// drags in a lot of unrelated machinery) — only the channel-health
// methods are exercised here.
type healthFakeRepo struct {
	failureCalls int
	timeoutCalls int
	cooldownSet  bool
}

func (r *healthFakeRepo) MarkChannelSuccess(_ context.Context, _ string) error { return nil }
func (r *healthFakeRepo) IncrementChannelFailure(_ context.Context, _, _ string) (int32, int32, error) {
	r.failureCalls++
	return int32(r.failureCalls), 0, nil
}
func (r *healthFakeRepo) SetChannelCooldown(_ context.Context, _ string, _ time.Time) error {
	r.cooldownSet = true
	return nil
}
func (r *healthFakeRepo) ResetChannelHealth(_ context.Context, _ string) error { return nil }
func (r *healthFakeRepo) MarkChannelTimeout(_ context.Context, _ string) error {
	r.timeoutCalls++
	return nil
}

// Unused by the test but required by the Repository interface — keep
// minimal panicking stubs so the file compiles without the full fake.
func (r *healthFakeRepo) GetRelayProvider(_ context.Context) (*domain.RelayProvider, error) {
	panic("nope")
}
func (r *healthFakeRepo) CreateRelayProvider(_ context.Context, _, _, _, _ string) (*domain.RelayProvider, error) {
	panic("nope")
}
func (r *healthFakeRepo) UpdateRelayProvider(_ context.Context, _, _, _ string) (*domain.RelayProvider, error) {
	panic("nope")
}
func (r *healthFakeRepo) SetRelayProviderLastSync(_ context.Context, _ string) error { panic("nope") }
func (r *healthFakeRepo) ListModelDefinitions(_ context.Context) ([]domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) ListEnabledModelDefinitions(_ context.Context, _, _ string) ([]domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) GetModelDefinitionByID(_ context.Context, _ string) (*domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) InsertModelDefinitionIfNotExists(_ context.Context, _, _, _, _ string) (*domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) UpdateModelDefinition(_ context.Context, _, _, _ string, _, _, _ json.RawMessage, _ int32) (*domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) SetModelStatus(_ context.Context, _, _ string) (*domain.ModelDefinition, error) {
	panic("nope")
}
func (r *healthFakeRepo) ListProviderConfigs(_ context.Context) ([]domain.ProviderConfig, error) {
	panic("nope")
}
func (r *healthFakeRepo) GetProviderConfigByID(_ context.Context, _ string) (*domain.ProviderConfig, error) {
	panic("nope")
}
func (r *healthFakeRepo) CreateProviderConfig(_ context.Context, _ domain.ProviderConfig) (*domain.ProviderConfig, error) {
	panic("nope")
}
func (r *healthFakeRepo) UpdateProviderConfig(_ context.Context, _ domain.ProviderConfig) (*domain.ProviderConfig, error) {
	panic("nope")
}
func (r *healthFakeRepo) DeleteProviderConfig(_ context.Context, _ string) error { panic("nope") }
func (r *healthFakeRepo) ListEnabledProviderConfigs(_ context.Context) ([]domain.AppProviderConfig, error) {
	panic("nope")
}
func (r *healthFakeRepo) InsertGenerationAttempt(_ context.Context, _ domain.GenerationAttempt) error {
	panic("nope")
}
func (r *healthFakeRepo) ListGenerationAttemptsByLog(_ context.Context, _ string) ([]domain.GenerationAttempt, error) {
	panic("nope")
}
func (r *healthFakeRepo) UpdateGenerationLogResult(_ context.Context, _, _, _, _ string, _ int32) error {
	panic("nope")
}

// Timeouts should only update the timeout counter. Failures still get
// recorded, but the service must not auto-lock or schedule cooldown.
func TestMarkChannelHealthDoesNotAutoCooldown(t *testing.T) {
	original := channelHealthConfig
	defer func() { channelHealthConfig = original }()
	channelHealthConfig = channelHealthCfg{
		failureThreshold:      3,
		initialCooldown:       5 * time.Minute,
		maxCooldown:           60 * time.Minute,
		cooldownBackoffFactor: 2,
	}

	repo := &healthFakeRepo{}
	svc := &Service{repo: repo}
	for i := 0; i < 10; i++ {
		svc.MarkChannelTimeout(context.Background(), "channel-1")
	}
	if repo.timeoutCalls != 10 {
		t.Errorf("MarkChannelTimeout: got %d timeout calls, want 10", repo.timeoutCalls)
	}
	if repo.failureCalls != 0 {
		t.Errorf("MarkChannelTimeout must not bump failure counter; got %d", repo.failureCalls)
	}
	if repo.cooldownSet {
		t.Error("MarkChannelTimeout must never schedule cooldown")
	}

	// Sanity: a real channel-dead error is still recorded, but should no
	// longer auto-schedule a cooldown.
	svc.MarkChannelFailure(context.Background(), "channel-1", CategoryChannelDead, "401")
	if repo.failureCalls != 1 {
		t.Errorf("MarkChannelFailure should increment failure count once; got %d", repo.failureCalls)
	}
	if repo.cooldownSet {
		t.Error("MarkChannelFailure must not auto-schedule cooldown")
	}
}
