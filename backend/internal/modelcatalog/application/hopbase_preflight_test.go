package application

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

func hopBaseAudioFixture(t *testing.T, root, name string, seconds int) string {
	t.Helper()
	// Offline PCM WAV; no encoders, network, or application state required.
	const sampleRate = 8000
	dataSize := seconds * sampleRate * 2
	data := make([]byte, 44+dataSize)
	copy(data[0:4], "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(36+dataSize))
	copy(data[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:20], 16)
	binary.LittleEndian.PutUint16(data[20:22], 1)
	binary.LittleEndian.PutUint16(data[22:24], 1)
	binary.LittleEndian.PutUint32(data[24:28], sampleRate)
	binary.LittleEndian.PutUint32(data[28:32], sampleRate*2)
	binary.LittleEndian.PutUint16(data[32:34], 2)
	binary.LittleEndian.PutUint16(data[34:36], 16)
	copy(data[36:40], "data")
	binary.LittleEndian.PutUint32(data[40:44], uint32(dataSize))
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func requireHopBaseFFprobe(t *testing.T) {
	t.Helper()
	if _, err := localMediaExecutable("ffprobe"); err != nil {
		t.Skip("offline audio validation requires local ffprobe: " + err.Error())
	}
}

func TestHopBasePreflightAcceptsLocalAudioWithoutUpload(t *testing.T) {
	requireHopBaseFFprobe(t)
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	t.Setenv("STORAGE_BACKEND", "oss")
	hopBaseAudioFixture(t, root, "voice.wav", 3)
	previous := uploadHopBaseLocalReference
	calls := 0
	uploadHopBaseLocalReference = func(context.Context, string, string, string) (string, error) {
		calls++
		return "", fmt.Errorf("preflight must never upload")
	}
	t.Cleanup(func() { uploadHopBaseLocalReference = previous })
	req := GenerateRequest{Model: "dreamina-seedance-2-5-260628", ReferenceAudios: []string{"/uploads/voice.wav"}, Duration: 30, Resolution: "720p", AspectRatio: "21:9"}
	if err := validateHopBaseReferences(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("preflight upload calls = %d, want 0", calls)
	}
}

func TestHopBasePreflightLocalAudioConstraints(t *testing.T) {
	requireHopBaseFFprobe(t)
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	t.Setenv("STORAGE_BACKEND", "oss")
	hopBaseAudioFixture(t, root, "short.wav", 1)
	hopBaseAudioFixture(t, root, "long.wav", 31)
	hopBaseAudioFixture(t, root, "twenty-a.wav", 20)
	hopBaseAudioFixture(t, root, "twenty-b.wav", 20)
	hopBaseAudioFixture(t, root, "sixteen.wav", 16)
	for _, name := range []string{"bad.wav", "bad.ogg"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("not audio"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	large, err := os.Create(filepath.Join(root, "large.wav"))
	if err != nil {
		t.Fatal(err)
	}
	if err := large.Truncate(15*1024*1024 + 1); err != nil {
		t.Fatal(err)
	}
	_ = large.Close()
	for _, tc := range []struct {
		name, model string
		audios      []string
		images      []string
	}{
		{name: "under two seconds", audios: []string{"short.wav"}},
		{name: "over thirty seconds", audios: []string{"long.wav"}},
		{name: "aggregate over thirty", audios: []string{"twenty-a.wav", "twenty-b.wav"}},
		{name: "not decodable", audios: []string{"bad.wav"}},
		{name: "wrong extension", audios: []string{"bad.ogg"}},
		{name: "too large", audios: []string{"large.wav"}},
		{name: "2.0 duration cap", model: "dreamina-seedance-2-0-hc", audios: []string{"sixteen.wav"}, images: []string{"asset://kept"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			model := tc.model
			if model == "" {
				model = "dreamina-seedance-2-5-260628"
			}
			var refs []string
			for _, name := range tc.audios {
				refs = append(refs, "/uploads/"+name)
			}
			if err := validateHopBaseReferences(context.Background(), GenerateRequest{Model: model, ReferenceAudios: refs, ReferenceImages: tc.images}); err == nil {
				t.Fatal("expected local validation failure")
			}
		})
	}
}

func TestHopBaseLocalReferencePathRejectsEscapes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "uploads")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UPLOAD_DIR", root)
	if err := os.WriteFile(filepath.Join(parent, "outside.wav"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty.wav"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"/uploads/../outside.wav", "/uploads/%2e%2e/outside.wav", "/uploads/voice.wav%3Asecret", "/uploads/..%5coutside.wav", "/uploads/", "/uploads/empty.wav", "/uploads/missing.wav"} {
		if _, err := hopBaseLocalReferencePath(raw); err == nil {
			t.Errorf("accepted unsafe or invalid path %q", raw)
		}
	}
}

func TestHopBaseLocalReferencePromotionUsesMockStoreOnly(t *testing.T) {
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	path := hopBaseAudioFixture(t, root, "voice.wav", 3)
	previous := uploadHopBaseLocalReference
	var uploadedKey string
	calls := 0
	uploadHopBaseLocalReference = func(ctx context.Context, key, localPath, contentType string) (string, error) {
		calls++
		uploadedKey = key
		wantPath, _ := filepath.EvalSymlinks(path)
		if localPath != wantPath || contentType != "audio/wav" {
			t.Errorf("upload path or MIME mismatch: path=%q want=%q MIME=%q", localPath, wantPath, contentType)
		}
		return "https://media.example.invalid/voice.wav", nil
	}
	t.Cleanup(func() { uploadHopBaseLocalReference = previous })
	got, err := hopBaseReferenceMediaURL(context.Background(), "/uploads/voice.wav")
	if err != nil || got != "https://media.example.invalid/voice.wav" {
		t.Fatalf("mock promotion = %q, %v", got, err)
	}
	if calls != 1 || !strings.HasPrefix(uploadedKey, "references/hopbase/") || !strings.HasSuffix(uploadedKey, ".wav") {
		t.Fatalf("upload calls/key = %d / %q", calls, uploadedKey)
	}
	if _, err := hopBaseReferenceMediaURL(context.Background(), "/uploads/missing.wav"); err == nil || calls != 1 {
		t.Fatal("missing local file must fail before upload")
	}
}

func TestHopBasePreflightRejectsBeforeAnyImageFetch(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	t.Setenv("UPLOAD_DIR", t.TempDir())
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	defer server.Close()
	svc := &Service{}
	_, err := svc.generateVideoHopBase(context.Background(), &domain.ProviderConfig{Vendor: "HopBase"}, server.URL, "offline-mock", GenerateRequest{
		Model: "dreamina-seedance-2-5-260628", ReferenceImages: []string{server.URL + "/image.png"}, ReferenceAudios: []string{"/uploads/missing.wav"},
	})
	if err == nil || calls != 0 {
		t.Fatalf("err = %v, HTTP calls = %d; invalid later audio must prevent earlier image fetch", err, calls)
	}
}

func TestHopBaseServicePreflightRespectsSelectedProvider(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encrypted, err := crypto.Encrypt(key, "offline-test-key")
	if err != nil {
		t.Fatal(err)
	}
	model := "dreamina-seedance-2-5-260628"
	config := domain.ProviderConfig{ID: "mock", Vendor: "HopBase", ServiceType: "video", BaseURL: "https://hop-base.com", Status: "enabled", ModelList: []string{model}, EncryptedAPIKey: encrypted}
	repo := &fakeRepository{providerConfigs: []domain.ProviderConfig{config}}
	svc := NewService(repo, key)
	req := GenerateRequest{ServiceType: "video", ProviderConfigID: "mock", Model: model, Duration: 31, Prompt: "offline"}
	if err := svc.PreflightGeneration(context.Background(), req); err == nil {
		t.Fatal("expected selected HopBase duration rejection")
	}
	repo.providerConfigs[0].Vendor = "another vendor"
	repo.providerConfigs[0].BaseURL = "https://provider.example.invalid"
	if err := svc.PreflightGeneration(context.Background(), req); err != nil {
		t.Fatalf("must not apply HopBase contract to another selected provider: %v", err)
	}
}

// Optional read-only deployment check for existing local canvas references.
// The manifest is a JSON array of GenerateRequest values; it never calls
// Service.Generate, a repository, a queue, or a media upload implementation.
func TestHopBasePreflightLocalManifest(t *testing.T) {
	path := os.Getenv("CCY_HOPBASE_PREFLIGHT_MANIFEST")
	if path == "" {
		t.Skip("no local manifest selected")
	}
	requireHopBaseFFprobe(t)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var requests []GenerateRequest
	if err := json.Unmarshal(raw, &requests); err != nil || len(requests) == 0 {
		t.Fatalf("invalid or empty local manifest: %v", err)
	}
	previous := uploadHopBaseLocalReference
	uploadHopBaseLocalReference = func(context.Context, string, string, string) (string, error) {
		t.Fatal("local preflight must never upload")
		return "", fmt.Errorf("upload forbidden")
	}
	t.Cleanup(func() { uploadHopBaseLocalReference = previous })
	for _, req := range requests {
		t.Run(req.NodeID, func(t *testing.T) {
			if err := validateHopBaseReferences(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			t.Logf("validated %d images, %d videos, %d audios locally", len(req.ReferenceImages), len(collectArkReferenceVideos(req)), len(collectHopBaseReferenceAudios(req)))
		})
	}
}
