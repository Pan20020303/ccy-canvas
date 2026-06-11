package application

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

// verifyCachedAsset asserts that a cached `/uploads/generated/...` URL
// points to a real file on disk whose bytes match `want`. Also cleans
// the file up so the test doesn't leave artifacts on the filesystem.
func verifyCachedAsset(t *testing.T, localURL string, want []byte) {
	t.Helper()
	diskPath := filepath.Join("..", "..", "..", "..", strings.TrimPrefix(localURL, "/"))
	// service runs from the test's package dir; the asset cache writes
	// relative to the backend module's working dir (cwd at runtime).
	// We try a couple plausible roots so the test works regardless of
	// where `go test` is invoked from.
	candidates := []string{
		strings.TrimPrefix(localURL, "/"),
		diskPath,
		filepath.Join(".", strings.TrimPrefix(localURL, "/")),
	}
	var bytes []byte
	var err error
	for _, p := range candidates {
		bytes, err = os.ReadFile(p)
		if err == nil {
			defer os.Remove(p)
			break
		}
	}
	if err != nil {
		t.Fatalf("cached asset file not found via any of %v: %v", candidates, err)
	}
	if string(bytes) != string(want) {
		t.Errorf("cached asset bytes = %q, want %q", bytes, want)
	}
}

type fakeRepository struct {
	provider        *domain.RelayProvider
	models          []domain.ModelDefinition
	existingModels  map[string]bool
	lastSyncID      string
	statusUpdates   map[string]string
	listUserID      string
	listRole        string
	providerConfigs []domain.ProviderConfig
}

func (r *fakeRepository) GetRelayProvider(context.Context) (*domain.RelayProvider, error) {
	return r.provider, nil
}

func TestImageGenerationTimeoutIsSixHundredSeconds(t *testing.T) {
	if got := imageGenerationTimeout(); got != 600*time.Second {
		t.Fatalf("imageGenerationTimeout() = %s, want %s", got, 600*time.Second)
	}
}

func TestNewProviderHTTPClientUsesLongerTLSHandshakeTimeout(t *testing.T) {
	client := newProviderHTTPClient(imageGenerationTimeout())
	if client.Timeout != 600*time.Second {
		t.Fatalf("client.Timeout = %s, want %s", client.Timeout, 600*time.Second)
	}

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("client.Transport type = %T, want *http.Transport", client.Transport)
	}
	if transport.TLSHandshakeTimeout != providerTLSHandshakeTimeout {
		t.Fatalf("transport.TLSHandshakeTimeout = %s, want %s", transport.TLSHandshakeTimeout, providerTLSHandshakeTimeout)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type timeoutNetError string

func (e timeoutNetError) Error() string   { return string(e) }
func (e timeoutNetError) Timeout() bool   { return true }
func (e timeoutNetError) Temporary() bool { return true }

func TestDoProviderRequestWithRetryRetriesTransientNetworkError(t *testing.T) {
	attempts := 0
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempts++
			if attempts == 1 {
				return nil, timeoutNetError("net/http: TLS handshake timeout")
			}
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != `{"ok":true}` {
				t.Fatalf("request body = %q", body)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"data":[]}`)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/v1/images/edits", nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := doProviderRequestWithRetry(context.Background(), client, req, []byte(`{"ok":true}`))
	if err != nil {
		t.Fatalf("doProviderRequestWithRetry returned error: %v", err)
	}
	defer resp.Body.Close()
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}

func TestLocalPathToDataURLFindsUploadsFromNestedWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	uploadsDir := filepath.Join(root, "uploads", "2026-06")
	if err := os.MkdirAll(uploadsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		t.Fatal(err)
	}
	pngBytes := pngBuf.Bytes()
	if err := os.WriteFile(filepath.Join(uploadsDir, "ref.png"), pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "backend")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)

	got, err := localPathToDataURL("/uploads/2026-06/ref.png")
	if err != nil {
		t.Fatalf("localPathToDataURL returned error: %v", err)
	}
	if !strings.HasPrefix(got, "data:image/jpeg;base64,") {
		t.Fatalf("localPathToDataURL = %q, want jpeg data URL", got)
	}
}

func TestVideoGenerationTimeoutIsNineHundredSeconds(t *testing.T) {
	if got := videoGenerationTimeout(); got != 900*time.Second {
		t.Fatalf("videoGenerationTimeout() = %s, want %s", got, 900*time.Second)
	}
}

func TestVideoPollMaxAttemptsMatchesTimeoutBudget(t *testing.T) {
	if got := videoPollMaxAttempts(); got != 149 {
		t.Fatalf("videoPollMaxAttempts() = %d, want 149", got)
	}
}

func TestFetchRemoteReferenceBytes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("fake-image-bytes"))
	}))
	defer server.Close()

	got, err := fetchRemoteReferenceBytes(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("fetchRemoteReferenceBytes returned error: %v", err)
	}
	if string(got) != "fake-image-bytes" {
		t.Fatalf("fetchRemoteReferenceBytes bytes = %q, want fake-image-bytes", string(got))
	}
}

func TestFetchRemoteReferenceBytesReturnsStatusDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "blocked", http.StatusForbidden)
	}))
	defer server.Close()

	_, err := fetchRemoteReferenceBytes(context.Background(), server.URL)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("error = %q, want status code context", err.Error())
	}
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
	return r.providerConfigs, nil
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

// Channel-health methods — minimal no-op implementations so the fake satisfies
// the Repository interface. Tests that exercise channel-health rotation will
// need to either swap in a richer fake or set the fields directly.
func (r *fakeRepository) MarkChannelSuccess(context.Context, string) error { return nil }
func (r *fakeRepository) IncrementChannelFailure(context.Context, string, string) (int32, int32, error) {
	return 0, 0, nil
}
func (r *fakeRepository) SetChannelCooldown(context.Context, string, time.Time) error { return nil }
func (r *fakeRepository) ResetChannelHealth(context.Context, string) error            { return nil }
func (r *fakeRepository) InsertGenerationAttempt(context.Context, domain.GenerationAttempt) error {
	return nil
}
func (r *fakeRepository) ListGenerationAttemptsByLog(context.Context, string) ([]domain.GenerationAttempt, error) {
	return nil, nil
}
func (r *fakeRepository) UpdateGenerationLogResult(context.Context, string, string, string, string, int32) error {
	return nil
}
func (r *fakeRepository) MarkChannelTimeout(context.Context, string) error { return nil }

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

func TestGenerateImageTextOnlyUsesOpenAIImageShape(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Fatalf("path = %q, want /images/generations", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-api-key" {
			t.Fatalf("Authorization header = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["size"] != "1536x1024" {
			t.Fatalf("size = %v, want 1536x1024", body["size"])
		}
		if body["quality"] != "high" {
			t.Fatalf("quality = %v, want high", body["quality"])
		}
		if _, ok := body["resolution"]; ok {
			t.Fatalf("resolution should not be sent to OpenAI image endpoint")
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"ZmFrZQ=="}]}`))
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-1",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "gpt-image-2",
		Prompt:      "draw a scooter",
		Size:        "16:9",
		Quality:     "high",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	// Asset cache now persists `data:` URIs to disk (so generation_logs
	// doesn't store multi-MB base64 blobs). Verify the new shape: a
	// local /uploads/generated/... path with the right extension and a
	// file on disk that decodes back to the upstream payload.
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
	verifyCachedAsset(t, result.Content, []byte("fake"))
}

func TestGenerateDoesNotFallbackToSecondProvider(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	var firstHits atomic.Int32
	var secondHits atomic.Int32

	firstServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstHits.Add(1)
		if r.URL.Path != "/images/generations" {
			t.Fatalf("first provider path = %q, want /images/generations", r.URL.Path)
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"message":"first provider failed"}}`))
	}))
	defer firstServer.Close()

	secondServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondHits.Add(1)
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/should-not-be-used.png"}]}`))
	}))
	defer secondServer.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{
			{
				ID:              "provider-1",
				ServiceType:     "image",
				Status:          "enabled",
				BaseURL:         firstServer.URL,
				EncryptedAPIKey: encryptedKey,
				ModelList:       []string{"gpt-image-2"},
			},
			{
				ID:              "provider-2",
				ServiceType:     "image",
				Status:          "enabled",
				BaseURL:         secondServer.URL,
				EncryptedAPIKey: encryptedKey,
				ModelList:       []string{"gpt-image-2"},
			},
		},
	}
	service := NewService(repo, key)

	_, err = service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "gpt-image-2",
		Prompt:      "draw a scooter",
	})
	if err == nil {
		t.Fatal("Generate returned nil error, want first provider failure")
	}
	if got := firstHits.Load(); got != 1 {
		t.Fatalf("first provider hits = %d, want 1", got)
	}
	if got := secondHits.Load(); got != 0 {
		t.Fatalf("second provider hits = %d, want 0", got)
	}
}

func TestGenerateImageEditUsesMultipartImageFields(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/edits" {
			t.Fatalf("path = %q, want /images/edits", r.URL.Path)
		}
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("parse media type: %v", err)
		}
		if mediaType != "multipart/form-data" {
			t.Fatalf("media type = %q", mediaType)
		}
		reader := multipartNewReader(r.Body, params["boundary"])
		form, err := reader.ReadForm(8 << 20)
		if err != nil {
			t.Fatalf("read form: %v", err)
		}
		if got := form.Value["quality"]; len(got) != 1 || got[0] != "medium" {
			t.Fatalf("quality = %v, want [medium]", got)
		}
		if got := form.Value["size"]; len(got) != 1 || got[0] != "1024x1536" {
			t.Fatalf("size = %v, want [1024x1536]", got)
		}
		if files := form.File["image"]; len(files) != 1 {
			t.Fatalf("image files = %d, want 1", len(files))
		}
		if files := form.File["image[]"]; len(files) != 0 {
			t.Fatalf("image[] files = %d, want 0", len(files))
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"ZmFrZQ=="}]}`))
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-1",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType:     "image",
		Model:           "gpt-image-2",
		Prompt:          "adapt this product poster into a realistic hero image",
		Size:            "9:16",
		Quality:         "medium",
		ReferenceImages: []string{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0i0AAAAASUVORK5CYII="},
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
	verifyCachedAsset(t, result.Content, []byte("fake"))
}

func TestGenerateImageUsesConfiguredSubmitAndQueryEndpoints(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/custom/image/tasks":
			_, _ = w.Write([]byte(`{"task_id":"image-task-1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/custom/image/tasks/image-task-1":
			_, _ = w.Write([]byte(`{"status":"completed","data":{"url":"https://example.com/generated.png"}}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-image-custom",
			ServiceType:     "image",
			Vendor:          "Custom",
			APISpec:         "custom",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
			SubmitEndpoint:  "/custom/image/tasks",
			QueryEndpoint:   "/custom/image/tasks/{taskId}",
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "gpt-image-2",
		Prompt:      "render a stylized poster",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/generated.png" {
		t.Fatalf("result.Content = %q, want https://example.com/generated.png", result.Content)
	}
}

func TestGenerateImageVolcengineMapsAspectRatioToSupportedSize(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Fatalf("path = %q, want /images/generations", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["size"] != "4096x2304" {
			t.Fatalf("size = %v, want 4096x2304", body["size"])
		}
		if _, ok := body["quality"]; ok {
			t.Fatalf("quality should not be sent to Volcengine image endpoint")
		}
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/seedream.png"}]}`))
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-volc",
			ServiceType:     "image",
			Vendor:          "Volcengine",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"doubao-seedream-5-0-260128"},
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "doubao-seedream-5-0-260128",
		Prompt:      "draw a premium product hero shot",
		Size:        "16:9",
		Quality:     "high",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/seedream.png" {
		t.Fatalf("result.Content = %q", result.Content)
	}
}

func TestMapAspectRatioToVolcengineSizeDefaultsByModel(t *testing.T) {
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "auto"); got != "2k" {
		t.Fatalf("seedream 5 auto size = %q, want 2k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "high"); got != "4k" {
		t.Fatalf("seedream 5 auto high size = %q, want 4k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-3-0-t2i-250415", "auto", "auto"); got != "1024x1024" {
		t.Fatalf("seedream 3 auto size = %q, want 1024x1024", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "9:16", "medium"); got != "1728x3072" {
		t.Fatalf("seedream 5 9:16 medium size = %q, want 1728x3072", got)
	}
}

func TestGenerateVideoCustomSoraProviderKeepsPromptShape(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body["prompt"] != "animate the idol dance scene" {
				t.Fatalf("prompt = %v, want animate the idol dance scene", body["prompt"])
			}
			if _, ok := body["content"]; ok {
				t.Fatalf("content should not be sent to sora-style providers")
			}
			_, _ = w.Write([]byte(`{"id":"video-task-1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video-task-1":
			_, _ = w.Write([]byte(`{"status":"completed","video_url":"https://example.com/final.mp4"}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-niuma",
			ServiceType:     "video",
			Vendor:          "Niuma",
			APISpec:         "custom",
			Status:          "enabled",
			BaseURL:         server.URL + "/v1",
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"sora-v3-fast"},
			SubmitEndpoint:  "/v1/videos",
			QueryEndpoint:   "/v1/videos/{taskId}",
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "video",
		Model:       "sora-v3-fast",
		Prompt:      "animate the idol dance scene",
		Size:        "9:16",
		Resolution:  "720p",
		Duration:    15,
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/final.mp4" {
		t.Fatalf("result.Content = %q, want https://example.com/final.mp4", result.Content)
	}
}

func TestGenerateVideoArkRejectsTooManyReferenceImagesForSeedance15(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-seedance",
			ServiceType:     "video",
			Vendor:          "Volcengine",
			Status:          "enabled",
			BaseURL:         "https://ark.cn-beijing.volces.com/api/v3",
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"doubao-seedance-1-5-pro-251215"},
		}},
	}
	service := NewService(repo, key)

	_, err = service.Generate(context.Background(), GenerateRequest{
		ServiceType: "video",
		Model:       "doubao-seedance-1-5-pro-251215",
		Prompt:      "make a cinematic character sequence",
		Size:        "9:16",
		Resolution:  "1080p",
		Duration:    12,
		ReferenceImages: []string{
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0i0AAAAASUVORK5CYII=",
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0i0AAAAASUVORK5CYII=",
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0i0AAAAASUVORK5CYII=",
		},
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "最多支持 2 张参考图") {
		t.Fatalf("err = %v, want friendly too-many-reference-images message", err)
	}
}

func multipartNewReader(body io.Reader, boundary string) *multipart.Reader {
	data, err := io.ReadAll(body)
	if err != nil {
		panic(err)
	}
	return multipart.NewReader(bytes.NewReader(data), strings.TrimSpace(boundary))
}
