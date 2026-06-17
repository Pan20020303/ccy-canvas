package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
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

func TestApplyImageParameterAliasesForApifoxRelay(t *testing.T) {
	schema := providerParameterSchema{
		AllowedParameters: []string{"model", "prompt", "n", "aspect_ratio", "output_resolution"},
		ParameterAliases: map[string]string{
			"aspect_ratio": "aspect_ratio",
			"resolution":   "output_resolution",
		},
	}
	allowed := allowedParamSet(schema.AllowedParameters)
	body := map[string]interface{}{
		"model":  "gpt-image-2",
		"prompt": "duck",
		"n":      1,
	}

	applyImageParameterAliases(body, allowed, schema, GenerateRequest{
		Size:       "16:9",
		Resolution: "4K",
	})
	pruneUnsupportedParameters(body, allowed)

	if got := body["aspect_ratio"]; got != "16:9" {
		t.Fatalf("aspect_ratio = %v, want 16:9", got)
	}
	if got := body["output_resolution"]; got != "4K" {
		t.Fatalf("output_resolution = %v, want 4K", got)
	}
	if _, ok := body["size"]; ok {
		t.Fatalf("size should be pruned for Apifox relay body: %#v", body)
	}
}

func TestApplyProviderModelRoutesByOutputResolution(t *testing.T) {
	body := map[string]interface{}{
		"model":             "gemini-3.0-pro-image",
		"output_resolution": "4K",
	}
	applyProviderModelRoutes(body, providerParameterSchema{
		ModelRoutes: []providerModelRoute{
			{Match: map[string]interface{}{"output_resolution": "4K"}, Model: "gemini-3.0-pro-image 4K"},
		},
	})

	if got := body["model"]; got != "gemini-3.0-pro-image 4K" {
		t.Fatalf("model = %v, want gemini-3.0-pro-image 4K", got)
	}
}

func requireNodeForTSProviderRunner(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for TS provider runner tests")
	}
}

const sampleTSProviderCode = `
type Req = { prompt: string; model: string };
export const vendor = {
  id: "sample-ts-image",
  serviceType: "image",
  vendor: "SampleVendor",
  name: "Sample TS Image",
  apiSpec: "custom",
  protocol: "openai_compatible",
  baseURL: "https://provider.example/v1",
  submitEndpoint: "/images/generations",
  icon: { key: "OpenAI", url: "data:image/png;base64,AAAA" },
  models: [{ model: "sample-image-1" }],
  defaultModel: "sample-image-1",
  parameterSchema: { quality_options: ["standard", "hd"] },
};

export async function imageRequest(input: Req, ctx: { apiKey: string; baseURL: string }) {
  if (ctx.apiKey !== "secret-key") throw new Error("api key was not injected");
  if (ctx.baseURL !== "https://provider.example/v1") throw new Error("base URL was not injected");
  return { url: "https://cdn.example/generated.png" };
}
`

func TestPreviewProviderPluginParsesTSMetadataAndIcons(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))

	preview, err := service.PreviewProviderPlugin(context.Background(), sampleTSProviderCode, "image")
	if err != nil {
		t.Fatalf("PreviewProviderPlugin returned error: %v", err)
	}
	if preview.Name != "Sample TS Image" {
		t.Fatalf("Name = %q, want Sample TS Image", preview.Name)
	}
	if preview.ServiceType != "image" {
		t.Fatalf("ServiceType = %q, want image", preview.ServiceType)
	}
	if got := preview.ModelList; len(got) != 1 || got[0] != "sample-image-1" {
		t.Fatalf("ModelList = %#v, want sample-image-1", got)
	}
	if preview.Icon.Key != "openai" {
		t.Fatalf("Icon.Key = %q, want openai", preview.Icon.Key)
	}
	if preview.Icon.URL == "" {
		t.Fatal("Icon.URL should be preserved")
	}
	if !strings.Contains(string(preview.ParameterSchema), "quality_options") {
		t.Fatalf("ParameterSchema = %s, want quality_options", preview.ParameterSchema)
	}
}

const toonflowStyleTSProviderCode = `
type ImageModel = { name: string; modelName: string; type: "image"; mode: string[] };
type VideoModel = { name: string; modelName: string; type: "video"; mode: string[] };
const vendor = {
  id: "toonflow-like",
  version: "3.2",
  author: "Toonflow",
  name: "Toonflow Like Provider",
  icon: "openai",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true },
  ],
  inputValues: { apiKey: "", baseUrl: "https://toonflow.example/v1" },
  models: [
    { name: "Image Display", modelName: "image-model-real", type: "image", mode: ["text", "singleImage"] },
    { name: "Video Display", modelName: "video-model-real", type: "video", mode: ["text"] },
  ],
};

const imageRequest = async (config: any, model: ImageModel): Promise<string> => {
  if (vendor.inputValues.apiKey !== "secret-key") throw new Error("missing injected api key");
  if (vendor.inputValues.baseUrl !== "https://toonflow.example/v1") throw new Error("missing injected base url");
  if (model.modelName !== "image-model-real") throw new Error("wrong selected model: " + model.modelName);
  if (!config.referenceList || config.referenceList[0].type !== "image") throw new Error("referenceList was not built");
  if (config.aspectRatio !== "9:16") throw new Error("aspect ratio was not normalized");
  return "https://cdn.example/toonflow-style.png";
};

const videoRequest = async (_config: any, _model: VideoModel): Promise<string> => {
  return "https://cdn.example/toonflow-style.mp4";
};

exports.vendor = vendor;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
export {};
`

func TestPreviewProviderPluginFiltersToonflowStyleModelsByServiceType(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))

	preview, err := service.PreviewProviderPlugin(context.Background(), toonflowStyleTSProviderCode, "image")
	if err != nil {
		t.Fatalf("PreviewProviderPlugin returned error: %v", err)
	}
	if preview.ServiceType != "image" {
		t.Fatalf("ServiceType = %q, want image", preview.ServiceType)
	}
	if got := preview.ModelList; len(got) != 1 || got[0] != "image-model-real" {
		t.Fatalf("ModelList = %#v, want only image-model-real", got)
	}
	if preview.DefaultModel != "image-model-real" {
		t.Fatalf("DefaultModel = %q, want image-model-real", preview.DefaultModel)
	}
	if !strings.Contains(string(preview.ParameterSchema), "vendor_all_models") {
		t.Fatalf("ParameterSchema = %s, want Toonflow vendor metadata", preview.ParameterSchema)
	}
}

func TestDispatchToVendorSupportsToonflowStyleTSProvider(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))
	pc := &domain.ProviderConfig{
		ID:              "provider-toonflow-style",
		ServiceType:     "image",
		Vendor:          "Toonflow",
		Name:            "Toonflow Like Provider",
		BaseURL:         "https://toonflow.example/v1",
		ModelList:       []string{"image-model-real"},
		ParameterSchema: json.RawMessage(`{"vendor_models":[{"name":"Image Display","modelName":"image-model-real","type":"image","mode":["text","singleImage"]}]}`),
		AdapterRuntime:  "ts",
		AdapterCode:     toonflowStyleTSProviderCode,
	}

	result, err := service.dispatchToVendor(context.Background(), candidateChannel{
		cfg:     pc,
		baseURL: "https://toonflow.example/v1",
		apiKey:  "secret-key",
	}, GenerateRequest{
		ServiceType:      "image",
		Model:            "image-model-real",
		Prompt:           "make an image",
		Size:             "9:16",
		Resolution:       "2K",
		ReferenceImages:  []string{"data:image/png;base64,AAAA"},
		GenerationLogID:  "log-1",
		ProviderConfigID: "provider-toonflow-style",
	})
	if err != nil {
		t.Fatalf("dispatchToVendor returned error: %v", err)
	}
	if result.Type != "url" || result.Content != "https://cdn.example/toonflow-style.png" {
		t.Fatalf("result = %#v, want generated URL", result)
	}
}

func TestDispatchToVendorUsesTSProviderRunner(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))
	pc := &domain.ProviderConfig{
		ID:             "provider-ts",
		ServiceType:    "image",
		Vendor:         "SampleVendor",
		Name:           "Sample TS Image",
		BaseURL:        "https://provider.example/v1",
		AdapterRuntime: "ts",
		AdapterCode:    sampleTSProviderCode,
	}

	result, err := service.dispatchToVendor(context.Background(), candidateChannel{
		cfg:     pc,
		baseURL: "https://provider.example/v1",
		apiKey:  "secret-key",
	}, GenerateRequest{
		ServiceType: "image",
		Model:       "sample-image-1",
		Prompt:      "make an image",
	})
	if err != nil {
		t.Fatalf("dispatchToVendor returned error: %v", err)
	}
	if result.Type != "url" || result.Content != "https://cdn.example/generated.png" {
		t.Fatalf("result = %#v, want generated URL", result)
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
	if !transport.DisableKeepAlives {
		t.Fatal("transport.DisableKeepAlives = false, want true to avoid stale provider connections")
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

func TestDoProviderRequestWithRetryRetriesEOF(t *testing.T) {
	attempts := 0
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempts++
			if attempts == 1 {
				return nil, &url.Error{Op: "Post", URL: req.URL.String(), Err: io.EOF}
			}
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != `{"prompt":"retry me"}` {
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
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/v1/images/generations", nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := doProviderRequestWithRetry(context.Background(), client, req, []byte(`{"prompt":"retry me"}`))
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
func (r *fakeRepository) UpdateGenerationLogResult(context.Context, string, string, string, string, int32, bool) error {
	return nil
}
func (r *fakeRepository) ListStaleActiveGenerations(context.Context, time.Time) ([]domain.StaleGeneration, error) {
	return nil, nil
}
func (r *fakeRepository) MarkGenerationTimedOut(context.Context, string, string) (bool, error) {
	return false, nil
}
func (r *fakeRepository) MarkChannelTimeout(context.Context, string) error { return nil }

func (r *fakeRepository) CreateAdminAlert(context.Context, domain.AdminAlert) error { return nil }
func (r *fakeRepository) ListAdminAlerts(context.Context, string, int32, int32) ([]domain.AdminAlert, error) {
	return nil, nil
}
func (r *fakeRepository) CountUnreadAdminAlerts(context.Context) (int32, error) { return 0, nil }
func (r *fakeRepository) MarkAdminAlertRead(context.Context, string) error      { return nil }
func (r *fakeRepository) MarkAllAdminAlertsRead(context.Context) error          { return nil }

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

func TestGenerateImageTextOnlyNormalizesConfiguredQualityOptions(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	var seenQualities []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		seenQualities = append(seenQualities, fmt.Sprint(body["quality"]))
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/custom-quality.png"}]}`))
	}))
	defer server.Close()

	schema := json.RawMessage(`{
		"allowed_parameters": ["model", "prompt", "n", "size", "quality"],
		"quality_options": ["standard/1k", "hd/2k", "4k/ultra/high"],
		"defaults": {"quality": "hd/2k"}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-custom-quality",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"custom-image-model"},
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	for _, quality := range []string{"auto", "high"} {
		if _, err := service.Generate(context.Background(), GenerateRequest{
			ServiceType: "image",
			Model:       "custom-image-model",
			Prompt:      "draw quality variants",
			Quality:     quality,
		}); err != nil {
			t.Fatalf("Generate quality %q returned error: %v", quality, err)
		}
	}

	if len(seenQualities) != 2 {
		t.Fatalf("seen qualities = %#v, want two requests", seenQualities)
	}
	if seenQualities[0] != "hd/2k" {
		t.Fatalf("auto quality = %q, want hd/2k", seenQualities[0])
	}
	if seenQualities[1] != "4k/ultra/high" {
		t.Fatalf("high quality = %q, want 4k/ultra/high", seenQualities[1])
	}
}

func TestGenerateImageViaChatCompletionsUsesMultimodalContent(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["model"] != "Nano Banana 2 4K" {
			t.Fatalf("model = %v, want routed Nano Banana 2 4K", body["model"])
		}
		if body["output_resolution"] != "4K" {
			t.Fatalf("output_resolution = %v, want 4K", body["output_resolution"])
		}
		messages, ok := body["messages"].([]any)
		if !ok || len(messages) != 1 {
			t.Fatalf("messages = %#v, want one message", body["messages"])
		}
		msg := messages[0].(map[string]any)
		content := msg["content"].([]any)
		if len(content) != 3 {
			t.Fatalf("content length = %d, want text + 2 image refs", len(content))
		}
		firstRef := content[1].(map[string]any)["image_url"].(map[string]any)["url"]
		if firstRef != "https://example.com/a.png" {
			t.Fatalf("first ref = %v", firstRef)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"![Generated Image](https://manjuapi.com/generated/example.png)"}}]}`))
	}))
	defer server.Close()

	schema := json.RawMessage(`{
		"request_format":"chat_completions_image",
		"allowed_parameters":["model","messages","stream","output_resolution"],
		"parameter_aliases":{"resolution":"output_resolution"},
		"defaults":{"stream":false,"output_resolution":"1K"},
		"model_routes":[{"match":{"output_resolution":"4K"},"model":"Nano Banana 2 4K"}]
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-manju",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"Nano Banana 2", "Nano Banana 2 4K"},
			SubmitEndpoint:  "/v1/chat/completions",
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType:     "image",
		Model:           "Nano Banana 2",
		Prompt:          "combine these references",
		Resolution:      "4K",
		ReferenceImages: []string{"https://example.com/a.png", "https://example.com/b.png"},
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://manjuapi.com/generated/example.png" {
		t.Fatalf("result.Content = %q", result.Content)
	}
}

func TestGenerateImageReferenceFormatUsesChatCompletionsOnlyForRefs(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if _, ok := body["prompt"]; ok {
			t.Fatalf("prompt should not be sent to chat image endpoint")
		}
		messages := body["messages"].([]any)
		content := messages[0].(map[string]any)["content"].([]any)
		if content[1].(map[string]any)["type"] != "image_url" {
			t.Fatalf("second content part = %#v, want image_url", content[1])
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"https://example.com/generated.png"}}]}`))
	}))
	defer server.Close()

	schema := json.RawMessage(`{
		"reference_request_format":"chat_completions_image",
		"allowed_parameters":["model","prompt","n","aspect_ratio","output_resolution"],
		"parameter_aliases":{"aspect_ratio":"aspect_ratio","resolution":"output_resolution"},
		"defaults":{"aspect_ratio":"1:1","output_resolution":"1K"}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-manju-openai",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType:     "image",
		Model:           "gpt-image-2",
		Prompt:          "redesign this image",
		Size:            "16:9",
		Resolution:      "2K",
		ReferenceImages: []string{"https://example.com/reference.png"},
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/generated.png" {
		t.Fatalf("result.Content = %q", result.Content)
	}
}

func TestGenerateImageChatCompletionsParsesDataURLResponse(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":""}}],"data":[{"url":"https://example.com/generated-from-data.png"}]}`))
	}))
	defer server.Close()

	schema := json.RawMessage(`{
		"reference_request_format":"chat_completions_image",
		"allowed_parameters":["model","prompt","n","aspect_ratio","output_resolution"],
		"defaults":{"aspect_ratio":"1:1","output_resolution":"1K"}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-chat-data-url",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType:     "image",
		Model:           "gpt-image-2",
		Prompt:          "redesign this image",
		ReferenceImages: []string{"https://example.com/reference.png"},
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/generated-from-data.png" {
		t.Fatalf("result.Content = %q", result.Content)
	}
}

func TestGenerateImageChatCompletionsParsesDataB64Response(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":""}}],"data":[{"b64_json":"ZmFrZQ=="}]}`))
	}))
	defer server.Close()

	schema := json.RawMessage(`{
		"request_format":"chat_completions_image",
		"allowed_parameters":["model","messages","stream"],
		"defaults":{"stream":false}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-chat-data-b64",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"Nano Banana 2"},
			SubmitEndpoint:  "/v1/chat/completions",
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "Nano Banana 2",
		Prompt:      "draw a scooter",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
}

func TestGenerateImageChatCompletionsPollsTaskURL(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	oldInitialDelay := imageTaskPollInitialDelay
	oldInterval := imageTaskPollInterval
	oldMaxAttempts := imageTaskPollMaxAttempts
	imageTaskPollInitialDelay = time.Millisecond
	imageTaskPollInterval = time.Millisecond
	imageTaskPollMaxAttempts = 3
	defer func() {
		imageTaskPollInitialDelay = oldInitialDelay
		imageTaskPollInterval = oldInterval
		imageTaskPollMaxAttempts = oldMaxAttempts
	}()

	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"task_id":"gemini-img-test","status":"running","progress":0,"poll_url":"%s/api/tasks/gemini-img-test"}`,
				serverURL,
			)))
		case "/api/tasks/gemini-img-test":
			_, _ = w.Write([]byte(`{"task_id":"gemini-img-test","status":"succeeded","progress":100,"image_url":"https://example.com/generated-from-poll.png"}`))
		default:
			t.Fatalf("unexpected path = %q", r.URL.Path)
		}
	}))
	serverURL = server.URL
	defer server.Close()

	schema := json.RawMessage(`{
		"request_format":"chat_completions_image",
		"allowed_parameters":["model","messages","stream"],
		"defaults":{"stream":false}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-chat-task",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"GPT Image 2"},
			SubmitEndpoint:  "/v1/chat/completions",
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "GPT Image 2",
		Prompt:      "redesign this image",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/generated-from-poll.png" {
		t.Fatalf("result.Content = %q", result.Content)
	}
}

func TestGenerateImageChatCompletionsStopsOnTopLevelTaskFailure(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	oldInitialDelay := imageTaskPollInitialDelay
	oldInterval := imageTaskPollInterval
	oldMaxAttempts := imageTaskPollMaxAttempts
	imageTaskPollInitialDelay = time.Millisecond
	imageTaskPollInterval = time.Millisecond
	imageTaskPollMaxAttempts = 3
	defer func() {
		imageTaskPollInitialDelay = oldInitialDelay
		imageTaskPollInterval = oldInterval
		imageTaskPollMaxAttempts = oldMaxAttempts
	}()

	var pollHits atomic.Int32
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"task_id":"gemini-img-failed","status":"running","progress":0,"poll_url":"%s/api/tasks/gemini-img-failed"}`,
				serverURL,
			)))
		case "/api/tasks/gemini-img-failed":
			pollHits.Add(1)
			_, _ = w.Write([]byte(`{"task_id":"gemini-img-failed","status":"failed","progress":0,"error":"provider rejected request"}`))
		default:
			t.Fatalf("unexpected path = %q", r.URL.Path)
		}
	}))
	serverURL = server.URL
	defer server.Close()

	schema := json.RawMessage(`{
		"request_format":"chat_completions_image",
		"allowed_parameters":["model","messages","stream"],
		"defaults":{"stream":false}
	}`)
	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-chat-task-failure",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"GPT Image 2"},
			SubmitEndpoint:  "/v1/chat/completions",
			ParameterSchema: schema,
		}},
	}
	service := NewService(repo, key)

	_, err = service.Generate(context.Background(), GenerateRequest{
		ServiceType: "image",
		Model:       "GPT Image 2",
		Prompt:      "redesign this image",
	})
	if err == nil {
		t.Fatal("Generate returned nil error, want failed task error")
	}
	if pollHits.Load() != 1 {
		t.Fatalf("pollHits = %d, want 1", pollHits.Load())
	}
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

func TestGenerateUsesRequestedProviderConfigID(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	firstServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected first provider hit: %s", r.URL.Path)
	}))
	defer firstServer.Close()

	secondServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Fatalf("second provider path = %q, want /images/generations", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/selected-provider.png"}]}`))
	}))
	defer secondServer.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{
			{
				ID:              "plain-provider",
				ServiceType:     "image",
				Status:          "enabled",
				BaseURL:         firstServer.URL,
				EncryptedAPIKey: encryptedKey,
				ModelList:       []string{"same-model"},
				APISpec:         "openai",
			},
			{
				ID:              "selected-provider",
				ServiceType:     "image",
				Status:          "enabled",
				BaseURL:         secondServer.URL,
				EncryptedAPIKey: encryptedKey,
				ModelList:       []string{"same-model"},
				APISpec:         "openai",
			},
		},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType:      "image",
		ProviderConfigID: "selected-provider",
		Model:            "same-model",
		Prompt:           "draw",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result.Content != "https://example.com/selected-provider.png" {
		t.Fatalf("result.Content = %q", result.Content)
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
		if _, ok := body["output_format"]; ok {
			t.Fatalf("output_format should not be sent to Volcengine image endpoint")
		}
		if _, ok := body["response_format"]; ok {
			t.Fatalf("response_format should not be sent to Volcengine image endpoint")
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
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "16:9", "low"); got != "2560x1440" {
		t.Fatalf("seedream 5 16:9 low size = %q, want 2560x1440", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "3:2", "low"); got != "2384x1568" {
		t.Fatalf("seedream 5 3:2 low size = %q, want 2384x1568", got)
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
