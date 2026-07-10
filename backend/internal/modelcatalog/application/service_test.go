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

func TestMain(m *testing.M) {
	previousClient := assetCacheHTTPClient
	assetCacheHTTPClient = &http.Client{
		Timeout: 70 * time.Second,
		Transport: testAssetCacheTransport{
			base: http.DefaultTransport,
		},
	}
	code := m.Run()
	assetCacheHTTPClient = previousClient
	os.Exit(code)
}

type testAssetCacheTransport struct {
	base http.RoundTripper
}

func (t testAssetCacheTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	switch req.URL.Host {
	case "example.com", "cdn.example", "manjuapi.com":
		contentType := "image/png"
		body := "fake"
		if strings.HasSuffix(req.URL.Path, ".mp4") {
			contentType = "video/mp4"
			body = "fake video"
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": []string{contentType}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    req,
		}, nil
	default:
		return t.base.RoundTrip(req)
	}
}

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

func TestBuildDashScopeVideoMediaUsesReferenceImagesForHappyHorseR2V(t *testing.T) {
	media, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:           "happyhorse-1.1-r2v",
		ReferenceMode:   "image_reference",
		ReferenceImages: []string{"https://example.com/ref.png"},
	})
	if err != nil {
		t.Fatalf("buildDashScopeVideoMedia returned error: %v", err)
	}
	if len(media) != 1 {
		t.Fatalf("media length = %d, want 1", len(media))
	}
	if got := media[0]["type"]; got != "reference_image" {
		t.Fatalf("media[0].type = %v, want reference_image", got)
	}
}

func TestBuildDashScopeVideoMediaUsesReferenceImagesForHappyHorseR2VMultiImage(t *testing.T) {
	media, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:           "happyhorse-1.0-r2v",
		ReferenceMode:   "image_reference",
		ReferenceImages: []string{"https://example.com/ref-1.png", "https://example.com/ref-2.png"},
	})
	if err != nil {
		t.Fatalf("buildDashScopeVideoMedia returned error: %v", err)
	}
	if len(media) != 2 {
		t.Fatalf("media length = %d, want 2", len(media))
	}
	for i, item := range media {
		if got := item["type"]; got != "reference_image" {
			t.Fatalf("media[%d].type = %v, want reference_image", i, got)
		}
	}
}

func TestBuildDashScopeVideoMediaKeepsFirstFrameForHappyHorseI2V(t *testing.T) {
	media, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:           "happyhorse-1.1-i2v",
		ReferenceMode:   "first_frame",
		ReferenceImages: []string{"https://example.com/first.png"},
	})
	if err != nil {
		t.Fatalf("buildDashScopeVideoMedia returned error: %v", err)
	}
	if len(media) != 1 {
		t.Fatalf("media length = %d, want 1", len(media))
	}
	if got := media[0]["type"]; got != "first_frame" {
		t.Fatalf("media[0].type = %v, want first_frame", got)
	}
}

// video-edit must emit the source video as a type:"video" element (first),
// followed by the reference images as type:"reference_image". A public http URL
// passes through unchanged (PresignGet returns "" for non-COS URLs).
func TestBuildDashScopeVideoMediaEmitsVideoElementForVideoEdit(t *testing.T) {
	media, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:           "happyhorse-1.0-video-edit",
		ReferenceMode:   "video_edit",
		ReferenceVideo:  "https://example.com/source.mp4",
		ReferenceImages: []string{"https://example.com/ref.png"},
	})
	if err != nil {
		t.Fatalf("buildDashScopeVideoMedia returned error: %v", err)
	}
	if len(media) != 2 {
		t.Fatalf("media length = %d, want 2 (1 video + 1 image)", len(media))
	}
	if got := media[0]["type"]; got != "video" {
		t.Fatalf("media[0].type = %v, want video", got)
	}
	if got := media[0]["url"]; got != "https://example.com/source.mp4" {
		t.Fatalf("media[0].url = %v, want the source video url", got)
	}
	if got := media[1]["type"]; got != "reference_image" {
		t.Fatalf("media[1].type = %v, want reference_image", got)
	}
}

// video-edit with only a source video (no reference images) still emits the
// video element — the old images-only guard silently dropped it.
func TestBuildDashScopeVideoMediaVideoEditWithoutReferenceImages(t *testing.T) {
	media, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:          "happyhorse-1.0-video-edit",
		ReferenceMode:  "video_edit",
		ReferenceVideo: "https://example.com/source.mp4",
	})
	if err != nil {
		t.Fatalf("buildDashScopeVideoMedia returned error: %v", err)
	}
	if len(media) != 1 || media[0]["type"] != "video" {
		t.Fatalf("media = %v, want a single type:video element", media)
	}
}

// video-edit without any source video is a hard error (media can't be built).
func TestBuildDashScopeVideoMediaVideoEditRequiresVideo(t *testing.T) {
	_, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:         "happyhorse-1.0-video-edit",
		ReferenceMode: "video_edit",
	})
	if err == nil {
		t.Fatal("expected an error when video-edit has no source video, got nil")
	}
}

// A base64/data-URL video is rejected — the doc mandates a public URL.
func TestBuildDashScopeVideoMediaVideoEditRejectsDataURLVideo(t *testing.T) {
	_, err := buildDashScopeVideoMedia(context.Background(), GenerateRequest{
		Model:          "happyhorse-1.0-video-edit",
		ReferenceMode:  "video_edit",
		ReferenceVideo: "data:video/mp4;base64,AAAA",
	})
	if err == nil {
		t.Fatal("expected an error for a base64 video, got nil")
	}
}

// 首帧(i2v) output aspect auto-follows the first frame; the DashScope docs say
// i2v does NOT accept aspect_ratio, so the parameters builder must OMIT it even
// when a caller passes one (stale genParams, direct API client, etc.).
func TestBuildDashScopeVideoParametersOmitsAspectRatioForI2V(t *testing.T) {
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model:       "happyhorse-1.1-i2v",
		Resolution:  "1080P",
		Duration:    5,
		AspectRatio: "9:16",
	})

	if got := params["resolution"]; got != "1080P" {
		t.Fatalf("resolution = %v, want 1080P", got)
	}
	if got := params["duration"]; got != 5 {
		t.Fatalf("duration = %v, want 5", got)
	}
	if _, ok := params["ratio"]; ok {
		t.Fatalf("ratio must be omitted for i2v, got %v", params["ratio"])
	}
}

// 参考生(r2v) DOES accept ratio, so the builder must forward it.
func TestBuildDashScopeVideoParametersIncludesAspectRatioForR2V(t *testing.T) {
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model:       "happyhorse-1.1-r2v",
		Resolution:  "1080P",
		Duration:    5,
		AspectRatio: "9:16",
	})

	// DashScope's video param key is "ratio" (NOT "aspect_ratio").
	if got := params["ratio"]; got != "9:16" {
		t.Fatalf("ratio = %v, want 9:16 for r2v", got)
	}
	if _, ok := params["aspect_ratio"]; ok {
		t.Fatalf("must use 'ratio' key, not 'aspect_ratio'")
	}
}

// video-edit follows the source video; ratio must be omitted like i2v.
func TestBuildDashScopeVideoParametersOmitsAspectRatioForVideoEdit(t *testing.T) {
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model:       "happyhorse-1.0-video-edit",
		Resolution:  "1080P",
		AspectRatio: "16:9",
	})

	if _, ok := params["ratio"]; ok {
		t.Fatalf("ratio must be omitted for video-edit, got %v", params["ratio"])
	}
}

// video-edit follows the source video; duration must also be omitted, and
// audio_setting must be emitted (default auto).
func TestBuildDashScopeVideoParametersVideoEditAudioAndNoDuration(t *testing.T) {
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model:      "happyhorse-1.0-video-edit",
		Resolution: "1080P",
		Duration:   5,
	})
	if _, ok := params["duration"]; ok {
		t.Fatalf("duration must be omitted for video-edit, got %v", params["duration"])
	}
	if got := params["audio_setting"]; got != "auto" {
		t.Fatalf("audio_setting = %v, want auto (default)", got)
	}

	origin := buildDashScopeVideoParameters(GenerateRequest{
		Model:        "happyhorse-1.0-video-edit",
		AudioSetting: "origin",
	})
	if got := origin["audio_setting"]; got != "origin" {
		t.Fatalf("audio_setting = %v, want origin", got)
	}
}

// audio_setting must NOT leak into non-video-edit modes.
func TestBuildDashScopeVideoParametersNoAudioSettingForR2V(t *testing.T) {
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model:        "happyhorse-1.1-r2v",
		AudioSetting: "origin",
	})
	if _, ok := params["audio_setting"]; ok {
		t.Fatalf("audio_setting must be omitted for r2v, got %v", params["audio_setting"])
	}
}

// seed is forwarded across all modes when provided.
func TestBuildDashScopeVideoParametersIncludesSeed(t *testing.T) {
	seed := 42
	params := buildDashScopeVideoParameters(GenerateRequest{
		Model: "happyhorse-1.1-t2v",
		Seed:  &seed,
	})
	if got := params["seed"]; got != 42 {
		t.Fatalf("seed = %v, want 42", got)
	}
}

func TestValidateDashScopeVideoRequest(t *testing.T) {
	bad := 5000000000
	cases := []struct {
		name    string
		req     GenerateRequest
		wantErr bool
	}{
		{"i2v exactly 1 ok", GenerateRequest{Model: "happyhorse-1.1-i2v", ReferenceImages: []string{"a"}}, false},
		{"i2v two images", GenerateRequest{Model: "happyhorse-1.1-i2v", ReferenceImages: []string{"a", "b"}}, true},
		{"i2v with video", GenerateRequest{Model: "happyhorse-1.1-i2v", ReferenceImages: []string{"a"}, ReferenceVideo: "v"}, true},
		{"r2v 1-9 ok", GenerateRequest{Model: "happyhorse-1.1-r2v", ReferenceImages: []string{"a", "b", "c"}}, false},
		{"r2v ten images", GenerateRequest{Model: "happyhorse-1.1-r2v", ReferenceImages: make([]string, 10)}, true},
		{"r2v with video", GenerateRequest{Model: "happyhorse-1.1-r2v", ReferenceImages: []string{"a"}, ReferenceVideos: []string{"v"}}, true},
		{"video-edit 1 video 5 images ok", GenerateRequest{Model: "happyhorse-1.0-video-edit", ReferenceVideo: "v", ReferenceImages: make([]string, 5)}, false},
		{"video-edit 6 images", GenerateRequest{Model: "happyhorse-1.0-video-edit", ReferenceVideo: "v", ReferenceImages: make([]string, 6)}, true},
		{"video-edit no video", GenerateRequest{Model: "happyhorse-1.0-video-edit", ReferenceImages: make([]string, 2)}, true},
		{"video-edit two videos", GenerateRequest{Model: "happyhorse-1.0-video-edit", ReferenceVideos: []string{"a", "b"}}, true},
		{"t2v with image", GenerateRequest{Model: "happyhorse-1.1-t2v", ReferenceImages: []string{"a"}}, true},
		{"bad resolution", GenerateRequest{Model: "happyhorse-1.1-t2v", Resolution: "4K"}, true},
		{"bad ratio r2v", GenerateRequest{Model: "happyhorse-1.1-r2v", ReferenceImages: []string{"a"}, AspectRatio: "7:3"}, true},
		{"duration out of range", GenerateRequest{Model: "happyhorse-1.1-t2v", Duration: 30}, true},
		{"seed out of range", GenerateRequest{Model: "happyhorse-1.1-t2v", Seed: &bad}, true},
		{"non-happyhorse skipped", GenerateRequest{Model: "some-other-video", ReferenceImages: make([]string, 20)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateDashScopeVideoRequest(tc.req)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestResolveCreditCostUsesPerModelOverrideCaseInsensitive(t *testing.T) {
	schema := []byte(`{
		"credit_cost": 2,
		"models": {
			"gpt-image-2": { "credit_cost": 7 }
		}
	}`)

	if got := resolveCreditCost(schema, "GPT-IMAGE-2"); got != 7 {
		t.Fatalf("resolveCreditCost = %d, want per-model override 7", got)
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

const creatorSuiteStyleTSProviderCode = `
type ImageModel = { name: string; modelName: string; type: "image"; mode: string[] };
type VideoModel = { name: string; modelName: string; type: "video"; mode: string[] };
const vendor = {
  id: "creator-suite-like",
  version: "3.2",
  author: "Creator Suite",
  name: "Creator Suite Like Provider",
  icon: "openai",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true },
  ],
  inputValues: { apiKey: "", baseUrl: "https://creator-suite.example/v1" },
  models: [
    { name: "Image Display", modelName: "image-model-real", type: "image", mode: ["text", "singleImage"] },
    { name: "Video Display", modelName: "video-model-real", type: "video", mode: ["text"] },
  ],
};

const imageRequest = async (config: any, model: ImageModel): Promise<string> => {
  if (vendor.inputValues.apiKey !== "secret-key") throw new Error("missing injected api key");
  if (vendor.inputValues.baseUrl !== "https://creator-suite.example/v1") throw new Error("missing injected base url");
  if (model.modelName !== "image-model-real") throw new Error("wrong selected model: " + model.modelName);
  if (!config.referenceList || config.referenceList[0].type !== "image") throw new Error("referenceList was not built");
  if (config.aspectRatio !== "9:16") throw new Error("aspect ratio was not normalized");
  return "https://cdn.example/creator-suite-style.png";
};

const videoRequest = async (_config: any, _model: VideoModel): Promise<string> => {
  return "https://cdn.example/creator-suite-style.mp4";
};

exports.vendor = vendor;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
export {};
`

func TestPreviewProviderPluginFiltersCreatorSuiteStyleModelsByServiceType(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))

	preview, err := service.PreviewProviderPlugin(context.Background(), creatorSuiteStyleTSProviderCode, "image")
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
		t.Fatalf("ParameterSchema = %s, want mixed vendor metadata", preview.ParameterSchema)
	}
}

func TestDispatchToVendorSupportsCreatorSuiteStyleTSProvider(t *testing.T) {
	requireNodeForTSProviderRunner(t)
	service := NewService(&fakeRepository{}, []byte("01234567890123456789012345678901"))
	pc := &domain.ProviderConfig{
		ID:              "provider-creator-suite-style",
		ServiceType:     "image",
		Vendor:          "CreatorSuite",
		Name:            "Creator Suite Like Provider",
		BaseURL:         "https://creator-suite.example/v1",
		ModelList:       []string{"image-model-real"},
		ParameterSchema: json.RawMessage(`{"vendor_models":[{"name":"Image Display","modelName":"image-model-real","type":"image","mode":["text","singleImage"]}]}`),
		AdapterRuntime:  "ts",
		AdapterCode:     creatorSuiteStyleTSProviderCode,
	}

	result, err := service.dispatchToVendor(context.Background(), candidateChannel{
		cfg:     pc,
		baseURL: "https://creator-suite.example/v1",
		apiKey:  "secret-key",
	}, GenerateRequest{
		ServiceType:      "image",
		Model:            "image-model-real",
		Prompt:           "make an image",
		Size:             "9:16",
		Resolution:       "2K",
		ReferenceImages:  []string{"data:image/png;base64,AAAA"},
		GenerationLogID:  "log-1",
		ProviderConfigID: "provider-creator-suite-style",
	})
	if err != nil {
		t.Fatalf("dispatchToVendor returned error: %v", err)
	}
	if result.Type != "url" || result.Content != "https://cdn.example/creator-suite-style.png" {
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
	provider          *domain.RelayProvider
	models            []domain.ModelDefinition
	existingModels    map[string]bool
	lastSyncID        string
	statusUpdates     map[string]string
	listUserID        string
	listRole          string
	providerConfigs   []domain.ProviderConfig
	lastLogStatus     string
	lastLogResult     string
	lastLogResultURLs string
	lastLogCacheHit   bool

	// MarkGenerationLogFailed controls: whether the guarded transition reports
	// success (markFailedTransitioned), an optional error, and a call counter.
	markFailedTransitioned bool
	markFailedErr          error
	markFailedCalls        int
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

func TestIsRequestDeadlineTimeout(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"context deadline", context.DeadlineExceeded, true},
		{"url wraps deadline", &url.Error{Op: "Post", URL: "x", Err: context.DeadlineExceeded}, true},
		{"client timeout message", timeoutNetError("Post \"x\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"), true},
		{"awaiting headers message", timeoutNetError("net/http: request canceled while awaiting headers"), true},
		{"tls handshake timeout is NOT a request deadline", timeoutNetError("net/http: TLS handshake timeout"), false},
		{"dial i/o timeout is NOT a request deadline", timeoutNetError("dial tcp 1.2.3.4:443: i/o timeout"), false},
		{"eof is not a deadline", io.EOF, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRequestDeadlineTimeout(tc.err); got != tc.want {
				t.Fatalf("IsRequestDeadlineTimeout(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestIsRetryableProviderNetworkErrorExcludesRequestDeadline(t *testing.T) {
	// A request-level timeout (upstream may have already done the work) must
	// not be retried — even though it satisfies net.Error.Timeout().
	deadline := timeoutNetError("Post \"x\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)")
	if isRetryableProviderNetworkError(deadline) {
		t.Fatal("request-deadline timeout should NOT be retryable")
	}
	// Pre-send connection failures stay retryable.
	if !isRetryableProviderNetworkError(timeoutNetError("net/http: TLS handshake timeout")) {
		t.Fatal("TLS handshake timeout should remain retryable")
	}
	if !isRetryableProviderNetworkError(io.EOF) {
		t.Fatal("EOF should remain retryable")
	}
}

func TestDoProviderRequestWithRetryDoesNotRetryRequestDeadline(t *testing.T) {
	attempts := 0
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempts++
			return nil, &url.Error{Op: "Post", URL: req.URL.String(), Err: context.DeadlineExceeded}
		}),
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/v1/images/edits", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := doProviderRequestWithRetry(context.Background(), client, req, []byte(`{"ok":true}`)); err == nil {
		t.Fatal("expected error for request-deadline timeout")
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1 (no retry on request-deadline timeout)", attempts)
	}
}

func TestExtractImageTaskIDDetectsManjuChatStub(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"explicit task_id", `{"task_id":"gemini-img-abc","status":"pending"}`, "gemini-img-abc"},
		{"manju chat stub id", `{"id":"chatcmpl-gemini-img-3640bd623c99","object":"chat.completion","choices":[{"message":{"content":""},"finish_reason":null}]}`, "gemini-img-3640bd623c99"},
		{"plain img prefix", `{"id":"img-12345"}`, "img-12345"},
		{"normal text chat completion is not a task", `{"id":"chatcmpl-abc123","choices":[{"message":{"content":"hi"}}]}`, ""},
		{"no id", `{"choices":[]}`, ""},
		{"garbage", `not json`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractImageTaskID([]byte(tc.body)); got != tc.want {
				t.Fatalf("extractImageTaskID() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTryExtractImageFromPollResponse(t *testing.T) {
	svc := &Service{}
	cases := []struct {
		name string
		body string
		want string // "" means nil (still in progress)
	}{
		{"result_url present", `{"status":"success","result_url":"https://manjuapi.com/generated/x.png"}`, "https://manjuapi.com/generated/x.png"},
		{"final_url only", `{"status":"success","result_url":"","download_url":"","final_url":"https://manjuapi.com/generated/final.png"}`, "https://manjuapi.com/generated/final.png"},
		{"data array url", `{"data":[{"url":"https://manjuapi.com/generated/y.png"}]}`, "https://manjuapi.com/generated/y.png"},
		{"content markdown", `{"choices":[{"message":{"content":"![img](https://manjuapi.com/generated/z.png)"}}]}`, "https://manjuapi.com/generated/z.png"},
		{"still processing, no url", `{"status":"processing","progress":40}`, ""},
		{"chinese status but url present is done", `{"status":"进行中","result_url":"https://manjuapi.com/generated/done.png"}`, "https://manjuapi.com/generated/done.png"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := svc.tryExtractImageFromPollResponse([]byte(tc.body))
			if tc.want == "" {
				if got != nil {
					t.Fatalf("expected nil (in progress), got %+v", got)
				}
				return
			}
			if got == nil || got.Content != tc.want {
				t.Fatalf("got %+v, want url %q", got, tc.want)
			}
		})
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

func TestArkTargetDims(t *testing.T) {
	// {w, h, wantW, wantH} — wantW<0 means "expect an error".
	cases := [][4]int{
		{4000, 4000, 4000, 4000},  // already in range → unchanged
		{6000, 6000, 6000, 6000},  // exactly at the max → unchanged
		{300, 300, 300, 300},      // exactly at the min → unchanged
		{7000, 3500, 6000, 3000},  // oversized → shrink, aspect kept
		{12000, 6000, 6000, 3000}, // very wide → shrink to max
		{200, 200, 300, 300},      // too small → enlarge
		{150, 600, 300, 1200},     // small side scaled up to the min
		{12000, 100, -1, -1},      // extreme ratio → cannot satisfy both bounds
		{0, 500, -1, -1},          // invalid
	}
	for _, c := range cases {
		gotW, gotH, err := arkTargetDims(c[0], c[1])
		if c[2] < 0 {
			if err == nil {
				t.Errorf("arkTargetDims(%d,%d) = %d,%d; want error", c[0], c[1], gotW, gotH)
			}
			continue
		}
		if err != nil {
			t.Errorf("arkTargetDims(%d,%d) error: %v", c[0], c[1], err)
			continue
		}
		if gotW != c[2] || gotH != c[3] {
			t.Errorf("arkTargetDims(%d,%d) = %d,%d; want %d,%d", c[0], c[1], gotW, gotH, c[2], c[3])
		}
		if gotW < arkRefMinDim || gotW > arkRefMaxDim || gotH < arkRefMinDim || gotH > arkRefMaxDim {
			t.Errorf("arkTargetDims(%d,%d) = %d,%d; out of [300,6000]", c[0], c[1], gotW, gotH)
		}
	}
}

func TestArkReferenceMediaURL(t *testing.T) {
	ctx := context.Background()

	// Public http(s) links pass through unchanged (no object store is configured
	// in tests, so PresignGet returns "" and we hand back the raw URL). A private
	// object-store object would instead come back as a signed URL — that path
	// needs real COS creds and is covered by manual/integration testing.
	for _, u := range []string{
		"https://cdn.example.com/2026-07/pic.png",
		"http://example.com/a/b.jpg?x=1",
	} {
		got, err := arkReferenceMediaURL(ctx, u)
		if err != nil {
			t.Fatalf("arkReferenceMediaURL(%q) error: %v", u, err)
		}
		if got != u {
			t.Fatalf("arkReferenceMediaURL(%q) = %q, want passthrough", u, got)
		}
	}

	// base64 data URLs, empty input, and local-only paths have no address the
	// provider can download — must error, so the user gets a clear re-upload hint
	// instead of a cryptic provider-side download failure.
	for _, bad := range []string{
		"data:image/png;base64,QUJD",
		"",
		"/uploads/2026-07/pic.png",
		"relative/path.png",
	} {
		if got, err := arkReferenceMediaURL(ctx, bad); err == nil {
			t.Fatalf("arkReferenceMediaURL(%q) = %q, want error", bad, got)
		}
	}
}

func TestVideoGenerationTimeoutTracksRuntimeCeiling(t *testing.T) {
	want := maxRuntimeForType("video") - videoPollSafetyMargin
	if got := videoGenerationTimeout(); got != want {
		t.Fatalf("videoGenerationTimeout() = %s, want %s", got, want)
	}
	// The poll budget must stay strictly under the hard runtime ceiling so
	// polling ends with its own clean message before the detached context /
	// asynq timeout cancels the request mid-flight.
	if got := videoGenerationTimeout(); got >= maxRuntimeForType("video") {
		t.Fatalf("videoGenerationTimeout() = %s, must be < ceiling %s", got, maxRuntimeForType("video"))
	}
}

func TestVideoPollMaxAttemptsMatchesTimeoutBudget(t *testing.T) {
	want := 1 + int((videoGenerationTimeout()-videoPollInitialDelay())/videoPollInterval())
	if got := videoPollMaxAttempts(); got != want {
		t.Fatalf("videoPollMaxAttempts() = %d, want %d", got, want)
	}
}

func TestFetchRemoteReferenceBytes(t *testing.T) {
	// httptest serves from loopback; allow internal targets like a LAN deploy.
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
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
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
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
func (r *fakeRepository) UpdateGenerationLogResult(_ context.Context, _ string, status, resultURL, _ string, _ int32, cacheHit bool) error {
	r.lastLogStatus = status
	r.lastLogResult = resultURL
	r.lastLogCacheHit = cacheHit
	return nil
}
func (r *fakeRepository) SetGenerationLogResultURLs(_ context.Context, _ string, resultURLsJSON string) error {
	r.lastLogResultURLs = resultURLsJSON
	return nil
}
func (r *fakeRepository) MarkGenerationLogPersisting(context.Context, string, StagedAsset, int32) error {
	return nil
}
func (r *fakeRepository) MarkGenerationLogAssetReady(context.Context, string, string, int32) error {
	return nil
}
func (r *fakeRepository) MarkGenerationLogAssetFailed(context.Context, string, string, string) error {
	return nil
}
func (r *fakeRepository) ListStaleActiveGenerations(context.Context, time.Time) ([]domain.StaleGeneration, error) {
	return nil, nil
}
func (r *fakeRepository) MarkGenerationTimedOut(context.Context, string, string) (bool, error) {
	return false, nil
}
func (r *fakeRepository) MarkGenerationLogFailed(context.Context, string, string, int32) (bool, error) {
	r.markFailedCalls++
	return r.markFailedTransitioned, r.markFailedErr
}
func (r *fakeRepository) MarkChannelTimeout(context.Context, string) error { return nil }

func (r *fakeRepository) CreateAdminAlert(context.Context, domain.AdminAlert) error { return nil }
func (r *fakeRepository) ListAdminAlerts(context.Context, string, int32, int32) ([]domain.AdminAlert, error) {
	return nil, nil
}
func (r *fakeRepository) CountUnreadAdminAlerts(context.Context) (int32, error) { return 0, nil }
func (r *fakeRepository) MarkAdminAlertRead(context.Context, string) error      { return nil }
func (r *fakeRepository) MarkAllAdminAlertsRead(context.Context) error          { return nil }

// fakeCharger is an in-memory creditcharger that counts reserves/refunds so
// tests can assert the billing orchestration without a database.
type fakeCharger struct {
	reserves     int
	refunds      int
	refundAmount int32
}

func (c *fakeCharger) Reserve(context.Context, string, int32, string) error { c.reserves++; return nil }
func (c *fakeCharger) Refund(_ context.Context, _ string, amount int32, _ string) error {
	c.refunds++
	c.refundAmount += amount
	return nil
}

func newCreditTestService(repo Repository, charger creditcharger) *Service {
	return NewService(repo, []byte("01234567890123456789012345678901")).WithCredits(charger)
}

// FinalizeFailure must refund exactly once, and only when it actually
// transitioned the row to terminal — so the worker and the reaper can't both
// refund the same task (the double-refund this fix targets).
func TestFinalizeFailureRefundsOnlyWhenItWinsTheTransition(t *testing.T) {
	req := GenerateRequest{UserID: "u1", CreditCost: 5, GenerationLogID: "log-1"}

	t.Run("transition won -> refund once", func(t *testing.T) {
		charger := &fakeCharger{}
		repo := &fakeRepository{markFailedTransitioned: true}
		svc := newCreditTestService(repo, charger)

		svc.FinalizeFailure(req, fmt.Errorf("boom"), time.Second)

		if repo.markFailedCalls != 1 {
			t.Fatalf("markFailedCalls = %d, want 1", repo.markFailedCalls)
		}
		if charger.refunds != 1 || charger.refundAmount != 5 {
			t.Fatalf("refunds = %d (amount %d), want 1 (amount 5)", charger.refunds, charger.refundAmount)
		}
	})

	t.Run("already terminal -> no refund", func(t *testing.T) {
		charger := &fakeCharger{}
		repo := &fakeRepository{markFailedTransitioned: false}
		svc := newCreditTestService(repo, charger)

		svc.FinalizeFailure(req, fmt.Errorf("boom"), time.Second)

		if charger.refunds != 0 {
			t.Fatalf("refunds = %d, want 0 when the row was already finalized", charger.refunds)
		}
	})
}

// A persistent write failure must NOT refund — the reaper's guarded path owns
// the refund later, so we never double-credit.
func TestFinalizeFailureDoesNotRefundOnWriteError(t *testing.T) {
	charger := &fakeCharger{}
	repo := &fakeRepository{markFailedErr: fmt.Errorf("db down")}
	svc := newCreditTestService(repo, charger)

	svc.FinalizeFailure(GenerateRequest{UserID: "u1", CreditCost: 5, GenerationLogID: "log-1"}, fmt.Errorf("boom"), time.Second)

	if charger.refunds != 0 {
		t.Fatalf("refunds = %d, want 0 when the terminal write never succeeded", charger.refunds)
	}
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

func TestGenerateImageFallsBackToTemporaryURLWhenGeneratedAssetCannotBeStaged(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	temporaryURL := ""
	assetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "signed url expired", http.StatusForbidden)
	}))
	defer assetServer.Close()
	temporaryURL = assetServer.URL + "/expired.png?X-Tos-Expires=86400"

	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"url":%q}]}`, temporaryURL)))
	}))
	defer providerServer.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-asset-cache-required",
			ServiceType:     "image",
			Status:          "enabled",
			BaseURL:         providerServer.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"gpt-image-2"},
		}},
	}
	service := NewService(repo, key)

	result, err := service.Generate(context.Background(), GenerateRequest{
		GenerationLogID: "log-fallback",
		ServiceType:     "image",
		Model:           "gpt-image-2",
		Prompt:          "draw a durable image",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if result == nil || result.Content != temporaryURL {
		t.Fatalf("Generate result = %#v, want temporary upstream URL %q", result, temporaryURL)
	}
	if repo.lastLogStatus != "success" {
		t.Fatalf("lastLogStatus = %q, want success", repo.lastLogStatus)
	}
	if repo.lastLogResult != temporaryURL {
		t.Fatalf("lastLogResult = %q, want %q", repo.lastLogResult, temporaryURL)
	}
	if repo.lastLogCacheHit {
		t.Fatal("lastLogCacheHit = true, want false while asset is not yet cached")
	}
}

func TestGenerateImageStagesProtectedProviderAssetWithBearerToken(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	var serverURL string
	var assetDownloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/images/generations":
			if got := r.Header.Get("Authorization"); got != "Bearer test-api-key" {
				t.Fatalf("generation Authorization header = %q", got)
			}
			_, _ = w.Write([]byte(fmt.Sprintf(`{"data":[{"url":%q}]}`, serverURL+"/protected-result.png")))
		case "/protected-result.png":
			assetDownloads.Add(1)
			if got := r.Header.Get("Authorization"); got != "Bearer test-api-key" {
				http.Error(w, "missing bearer token", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("protected image bytes"))
		default:
			t.Fatalf("unexpected path = %q", r.URL.Path)
		}
	}))
	serverURL = server.URL
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-protected-asset",
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
		Prompt:      "draw a protected image",
	})
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}
	if assetDownloads.Load() != 1 {
		t.Fatalf("asset downloads = %d, want 1", assetDownloads.Load())
	}
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
	verifyCachedAsset(t, result.Content, []byte("protected image bytes"))
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
}

func TestIsQwenThinkingModel(t *testing.T) {
	cases := map[string]bool{
		"qwen3.7-max":            true,
		"qwen3.7-plus":           true,
		"qwen3.7-max-2026-06-08": true,
		"QWEN3.7-PLUS":           true, // 大小写不敏感
		"qwen-max":               false,
		"qwen-plus":              false,
		"qwen3-max":              false, // 仅 gate qwen3.7 系列
		"gpt-4.1-mini":           false,
		"deepseek-v4-pro":        false,
		"":                       false,
	}
	for model, want := range cases {
		if got := isQwenThinkingModel(model); got != want {
			t.Fatalf("isQwenThinkingModel(%q) = %v, want %v", model, got, want)
		}
	}
}

// qwen3.7 混合思考模型的同步文本请求应带 enable_thinking=false;其它模型不带。
func TestGenerateTextQwenThinkingGate(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encryptedKey, err := crypto.Encrypt(key, "test-api-key")
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}

	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer server.Close()

	repo := &fakeRepository{
		providerConfigs: []domain.ProviderConfig{{
			ID:              "provider-qwen-text",
			ServiceType:     "text",
			Vendor:          "Alibaba",
			Status:          "enabled",
			BaseURL:         server.URL,
			EncryptedAPIKey: encryptedKey,
			ModelList:       []string{"qwen3.7-max", "qwen-plus"},
		}},
	}
	service := NewService(repo, key)

	// qwen3.7-max → 带 enable_thinking=false
	if _, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "text", Model: "qwen3.7-max", Prompt: "写一句广告语",
	}); err != nil {
		t.Fatalf("Generate(qwen3.7-max) error: %v", err)
	}
	if v, ok := captured["enable_thinking"]; !ok || v != false {
		t.Fatalf("qwen3.7-max enable_thinking = %v (present=%v), want false", v, ok)
	}

	// qwen-plus(非 3.7)→ 不带 enable_thinking
	captured = nil
	if _, err := service.Generate(context.Background(), GenerateRequest{
		ServiceType: "text", Model: "qwen-plus", Prompt: "写一句广告语",
	}); err != nil {
		t.Fatalf("Generate(qwen-plus) error: %v", err)
	}
	if _, ok := captured["enable_thinking"]; ok {
		t.Fatalf("qwen-plus 不应带 enable_thinking，实际 body=%#v", captured)
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
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
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
}

func TestGenerateImageChatCompletionsStopsOnTopLevelTaskFailure(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
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
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
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
		if body["watermark"] != false {
			t.Fatalf("watermark = %v, want false (站内统一不带水印)", body["watermark"])
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".png") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...png", result.Content)
	}
}

func TestMapAspectRatioToVolcengineSizeDefaultsByModel(t *testing.T) {
	// 无显式分辨率档位 → 回退 quality 推导(旧行为)。
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "", "auto"); got != "2k" {
		t.Fatalf("seedream 5 auto size = %q, want 2k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "", "high"); got != "4k" {
		t.Fatalf("seedream 5 auto high size = %q, want 4k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-3-0-t2i-250415", "auto", "", "auto"); got != "1024x1024" {
		t.Fatalf("seedream 3 auto size = %q, want 1024x1024", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "9:16", "", "medium"); got != "1728x3072" {
		t.Fatalf("seedream 5 9:16 medium size = %q, want 1728x3072", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "16:9", "", "low"); got != "2560x1440" {
		t.Fatalf("seedream 5 16:9 low size = %q, want 2560x1440", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "3:2", "", "low"); got != "2384x1568" {
		t.Fatalf("seedream 5 3:2 low size = %q, want 2384x1568", got)
	}
}

// 参数面板显式选择分辨率档位(1k/2k/4k)时,分辨率优先于 quality 生效。
func TestMapAspectRatioToVolcengineSizeExplicitResolution(t *testing.T) {
	// 1K 一律以关键字下发(即使方形也在 Ark 自定义像素地板之下),忽略比例。
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "1k", "auto"); got != "1k" {
		t.Fatalf("seedream 5 1k auto = %q, want 1k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "16:9", "1k", "auto"); got != "1k" {
		t.Fatalf("seedream 5 1k 16:9 = %q, want 1k (below custom-pixel floor)", got)
	}
	// 2K/1:1/auto → 关键字;2K + 具体比例 → 精确像素(不足地板自动放大)。
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "1:1", "2k", "auto"); got != "2k" {
		t.Fatalf("seedream 5 2k 1:1 = %q, want 2k", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "16:9", "2k", "auto"); got != "2560x1440" {
		t.Fatalf("seedream 5 2k 16:9 = %q, want 2560x1440", got)
	}
	// 4K + 比例 → 精确像素(远超地板,直接按比例)。
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "9:16", "4k", "auto"); got != "2304x4096" {
		t.Fatalf("seedream 5 4k 9:16 = %q, want 2304x4096", got)
	}
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "4k", "auto"); got != "4k" {
		t.Fatalf("seedream 5 4k auto = %q, want 4k", got)
	}
	// 分辨率档位应压过 quality:选 2K 时不因 quality=high 变 4K。
	if got := mapAspectRatioToVolcengineSize("doubao-seedream-5-0-260128", "auto", "2k", "high"); got != "2k" {
		t.Fatalf("seedream 5 2k(high quality) = %q, want 2k (resolution wins)", got)
	}
}

func TestGenerateVideoCustomSoraProviderKeepsPromptShape(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // safehttp blocks loopback; httptest serves from 127.0.0.1
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
	if !strings.HasPrefix(result.Content, "/uploads/generated/") || !strings.HasSuffix(result.Content, ".mp4") {
		t.Fatalf("result.Content = %q, want /uploads/generated/...mp4", result.Content)
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

func TestApplyGeminiProImageResolution(t *testing.T) {
	// Base model, no resolution → defaults to 2K, model unchanged.
	body := map[string]interface{}{"model": "gemini-3.0-pro-image"}
	applyGeminiProImageResolution(body, nil, GenerateRequest{Model: "gemini-3.0-pro-image"})
	if body["output_resolution"] != "2K" {
		t.Fatalf("expected output_resolution 2K, got %v", body["output_resolution"])
	}
	if body["model"] != "gemini-3.0-pro-image" {
		t.Fatalf("expected model unchanged, got %v", body["model"])
	}

	// Base model + resolution 4k → 4K + " 4K" model suffix.
	body = map[string]interface{}{"model": "gemini-3.0-pro-image"}
	applyGeminiProImageResolution(body, nil, GenerateRequest{Model: "gemini-3.0-pro-image", Resolution: "4k"})
	if body["output_resolution"] != "4K" {
		t.Fatalf("expected output_resolution 4K, got %v", body["output_resolution"])
	}
	if body["model"] != "gemini-3.0-pro-image 4K" {
		t.Fatalf("expected 4K model suffix, got %v", body["model"])
	}

	// Legacy " 4K" model id wins over a stale 2k resolution param.
	body = map[string]interface{}{"model": "gemini-3.0-pro-image 4K"}
	applyGeminiProImageResolution(body, nil, GenerateRequest{Model: "gemini-3.0-pro-image 4K", Resolution: "2k"})
	if body["output_resolution"] != "4K" {
		t.Fatalf("expected suffix to win with 4K, got %v", body["output_resolution"])
	}
	if body["model"] != "gemini-3.0-pro-image 4K" {
		t.Fatalf("expected model unchanged, got %v", body["model"])
	}

	// output_resolution survives an allowed-parameter whitelist.
	allowed := map[string]bool{"model": true, "messages": true}
	body = map[string]interface{}{"model": "gemini-3.0-pro-image"}
	applyGeminiProImageResolution(body, allowed, GenerateRequest{Model: "gemini-3.0-pro-image", Resolution: "2k"})
	pruneUnsupportedParameters(body, allowed)
	if body["output_resolution"] != "2K" {
		t.Fatalf("expected output_resolution to survive pruning, got %v", body["output_resolution"])
	}

	// Non-family models are untouched.
	body = map[string]interface{}{"model": "gpt-image-2"}
	applyGeminiProImageResolution(body, nil, GenerateRequest{Model: "gpt-image-2", Resolution: "4k"})
	if _, ok := body["output_resolution"]; ok {
		t.Fatalf("expected no output_resolution for non-gemini model")
	}
}
