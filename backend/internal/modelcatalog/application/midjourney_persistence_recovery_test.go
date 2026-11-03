package application

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/platform/crypto"
)

type midjourneyOutcomeRecoveryRepo struct {
	fakeRepository
	failingPhase       string
	writeFailures      int
	providerID, taskID string
}

func (r *midjourneyOutcomeRecoveryRepo) SetGenerationLogUpstreamTask(_ context.Context, _, providerID, taskID string) error {
	r.providerID, r.taskID = providerID, taskID
	return nil
}

func (r *midjourneyOutcomeRecoveryRepo) SetGenerationLogResultURLs(ctx context.Context, logID, urls string) error {
	if r.failingPhase == "list" && r.writeFailures > 0 {
		r.writeFailures--
		return errors.New("database unavailable")
	}
	return r.fakeRepository.SetGenerationLogResultURLs(ctx, logID, urls)
}

func (r *midjourneyOutcomeRecoveryRepo) UpdateGenerationLogResult(ctx context.Context, logID, status, url, msg string, duration int32, hit bool) error {
	if r.failingPhase == "status" && r.writeFailures > 0 {
		r.writeFailures--
		return errors.New("database unavailable")
	}
	return r.fakeRepository.UpdateGenerationLogResult(ctx, logID, status, url, msg, duration, hit)
}

func TestMidjourneyPersistenceFailureRecoversSamePaidTask(t *testing.T) {
	for _, inline := range []bool{true, false} {
		for _, phase := range []string{"list", "status"} {
			t.Run(fmt.Sprintf("inline=%t/%s", inline, phase), func(t *testing.T) {
				fastMidjourneyPoll(t)
				originalStore, err := assetstore.Default()
				if err != nil {
					t.Fatal(err)
				}
				uploadDir := t.TempDir()
				t.Setenv("UPLOAD_DIR", uploadDir)
				t.Setenv("STORAGE_BACKEND", "local")
				localStore, err := assetstore.Build(assetstore.Config{Backend: "local"})
				if err != nil {
					t.Fatal(err)
				}
				assetstore.Activate(localStore, nil)
				t.Cleanup(func() { assetstore.Activate(originalStore, nil) })
				png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0i0AAAAASUVORK5CYII=")
				posts, polls := 0, 0
				var baseURL string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/v1/images/generations":
						posts++
						w.WriteHeader(http.StatusAccepted)
						fmt.Fprint(w, "{\"id\":\"kt-persisted\",\"status\":\"queued\"}")
					case "/v1/video/tasks/kt-persisted":
						polls++
						urls := []string{baseURL + "/1.png", baseURL + "/2.png", baseURL + "/3.png", baseURL + "/4.png"}
						_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "outputs": urls})
					default:
						w.Header().Set("Content-Type", "image/png")
						_, _ = w.Write(png)
					}
				}))
				defer server.Close()
				baseURL = server.URL
				key := []byte("01234567890123456789012345678901")
				encrypted, err := crypto.Encrypt(key, "fixture-key")
				if err != nil {
					t.Fatal(err)
				}
				repo := &midjourneyOutcomeRecoveryRepo{failingPhase: phase, writeFailures: 2}
				repo.providerConfigs = []domain.ProviderConfig{{
					ID: "mj-provider", Vendor: "HopBase", ServiceType: "image", Status: "enabled",
					BaseURL: baseURL, EncryptedAPIKey: encrypted, ModelList: []string{hopBaseMidjourneyModel},
				}}
				svc := NewService(repo, key)
				generate := svc.GenerateInline
				if !inline {
					generate = svc.Generate
				}
				req := GenerateRequest{ServiceType: "image", Model: hopBaseMidjourneyModel, Prompt: "A forest", OutputCount: 4, GenerationLogID: "mj-log"}
				result, err := generate(context.Background(), req)
				if !errors.Is(err, ErrMidjourneyResultPersistence) || result == nil || repo.lastLogStatus == "success" {
					t.Fatalf("failed DB writes became success: result=%+v status=%s err=%v", result, repo.lastLogStatus, err)
				}
				if repo.taskID != "kt-persisted" || repo.providerID != "mj-provider" {
					t.Fatal("upstream checkpoint lost on persistence failure")
				}
				if len(result.ContentList) != 4 {
					t.Fatalf("lost generated files: %+v", result)
				}
				for _, url := range result.ContentList {
					if !strings.HasPrefix(url, "/uploads/") {
						t.Fatalf("not saved locally: %q", url)
					}
					if _, err := os.Stat(filepath.Join(uploadDir, strings.TrimPrefix(url, "/uploads/"))); err != nil {
						t.Fatal(err)
					}
				}
				// Emulate the worker reloading its durable checkpoint after the
				// database recovers. Recovery must GET the same task, never POST.
				req.UpstreamTaskID, req.UpstreamProviderID = repo.taskID, repo.providerID
				req.ProviderConfigID = repo.providerID
				result, err = generate(context.Background(), req)
				if err != nil || posts != 1 || polls != 2 || repo.lastLogStatus != "success" {
					t.Fatalf("recovery result=%+v err=%v posts=%d polls=%d status=%s", result, err, posts, polls, repo.lastLogStatus)
				}
				var urls []string
				if json.Unmarshal([]byte(repo.lastLogResultURLs), &urls) != nil || len(urls) != 4 {
					t.Fatalf("recovery did not save four results: %s", repo.lastLogResultURLs)
				}
			})
		}
	}
}
