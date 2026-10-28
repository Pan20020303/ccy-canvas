package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

func visionularTestConfig() *domain.ProviderConfig {
	return &domain.ProviderConfig{ID: "visionular-channel", Vendor: "Visionular", ParameterSchema: json.RawMessage(`{"visionular":{"pipeline":"configured-pipeline","storage_id":"configured-storage"}}`)}
}

func TestVisionularUpscaleAllTiers(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for model, template := range visionularTemplates {
		t.Run(model, func(t *testing.T) {
			polls, submits := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ak, sk, ok := r.BasicAuth()
				if !ok || ak != "test-access" || sk != "test-secret" || r.Header.Get("auth-type") != "use-basic" {
					t.Error("V2 BasicAuth or auth-type header missing")
				}
				w.Header().Set("Content-Type", "application/json")
				if r.Method == "POST" && r.URL.Path == "/vodencoding/v1/create_enhance_task" {
					submits++
					var body map[string]any
					if json.NewDecoder(r.Body).Decode(&body) != nil {
						t.Error("bad JSON")
					}
					if body["template_name"] != template || body["pipeline"] != "configured-pipeline" || body["storage_id"] != "configured-storage" || body["input"] != "https://example.com/full-video.mp4" {
						t.Errorf("incorrect template/source/config contract: %#v", body)
					}
					if body["extra_options"].(map[string]any)["session_id"] != "log-stable" || body["output"] != "ccy-canvas/visionular/log-stable/"+template+".mp4" {
						t.Error("missing stable session/output identity")
					}
					if _, ok := body["duration"]; ok {
						t.Error("must not truncate the input video")
					}
					// Replayed session IDs return 1006 WITH the original task id.
					fmt.Fprint(w, `{"code":1006,"data":{"task_id":"task-1"}}`)
					return
				}
				if r.Method != "GET" || r.URL.Path != "/vodencoding/v1/query_task" || r.URL.Query().Get("task_id") != "task-1" {
					t.Errorf("wrong query: %s", r.URL)
					w.WriteHeader(404)
					return
				}
				states := []string{"pending", "downloading", "running", "uploading", "succeeded"}
				state := states[min(polls, len(states)-1)]
				polls++
				fmt.Fprintf(w, `{"code":0,"data":{"task_id":"task-1","status":%q,"output":"oss://test-bucket/out/final.mp4","region":"cn-beijing","code":0}}`, state)
			}))
			defer server.Close()
			repo := &recordingTaskRepo{}
			svc := &Service{repo: repo}
			result, err := svc.generateVideo(context.Background(), visionularTestConfig(), server.URL+"/v1", "test-access:test-secret", GenerateRequest{Model: model, GenerationLogID: "log-stable", ReferenceVideo: "https://example.com/full-video.mp4"})
			if err != nil {
				t.Fatal(err)
			}
			if result.Content != "https://test-bucket.oss-cn-beijing.aliyuncs.com/out/final.mp4" || result.Type != "url" {
				t.Fatalf("bad output: %#v", result)
			}
			if polls != 5 || submits != 1 || repo.taskID != "task-1" || repo.providerID != "visionular-channel" {
				t.Fatal("task lifecycle or checkpoint not recorded")
			}
		})
	}
}

func TestVisionularRejectsInvalidInputBeforeSubmit(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "")
	for _, source := range []string{"", "blob:local", "data:video/mp4;base64,aA==", "/uploads/local.mp4", "http://127.0.0.1/secret", "https://localhost/a.mp4", "https://user:secret@example.com/a.mp4"} {
		_, err := (&Service{}).generateVideoVisionular(context.Background(), visionularTestConfig(), visionularBaseURL, "test:secret", GenerateRequest{Model: "visionular-genopt-1080p", ReferenceVideo: source})
		if err == nil {
			t.Errorf("accepted private or invalid source %q", source)
		}
	}
	_, err := (&Service{}).generateVideoVisionular(context.Background(), visionularTestConfig(), visionularBaseURL, "test:secret", GenerateRequest{Model: "arbitrary-template"})
	if err == nil {
		t.Error("accepted an arbitrary template")
	}
	_, err = (&Service{}).generateVideoVisionular(context.Background(), visionularTestConfig(), visionularBaseURL, "test:secret", GenerateRequest{Model: "visionular-genopt-1080p", ReferenceVideos: []string{"https://example.com/a.mp4", "https://example.com/b.mp4"}})
	if err == nil {
		t.Error("accepted multiple source videos")
	}
}

func TestVisionularFailureHandling(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, scenario := range []string{"failed", "unknown", "missing-task-id", "invalid-json", "auth-error", "query-retry", "cancelled", "missing-output", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			queries := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					switch scenario {
					case "missing-task-id":
						fmt.Fprint(w, `{"code":0,"data":{}}`)
						return
					case "invalid-json":
						fmt.Fprint(w, `{"data":{}}`)
						return
					case "auth-error":
						w.WriteHeader(401)
						fmt.Fprint(w, `test-access:test-secret`)
						return
					case "redirect":
						w.Header().Set("Location", "/must-not-follow")
						w.WriteHeader(302)
						return
					}
					fmt.Fprint(w, `{"code":0,"data":{"task_id":"t1"}}`)
					return
				}
				queries++
				if scenario == "query-retry" && queries == 1 {
					w.WriteHeader(503)
					return
				}
				switch scenario {
				case "failed":
					fmt.Fprint(w, `{"code":0,"data":{"status":"failed","code":2003,"message":"test-secret"}}`)
				case "unknown":
					fmt.Fprint(w, `{"code":0,"data":{"status":"other"}}`)
				case "cancelled":
					fmt.Fprint(w, `{"code":0,"data":{"status":"running"}}`)
				case "missing-output":
					fmt.Fprint(w, `{"code":0,"data":{"status":"succeeded"}}`)
				default:
					fmt.Fprint(w, `{"code":0,"data":{"status":"succeeded","output":"https://example.com/final.mp4"}}`)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			_, err := (&Service{}).generateVideoVisionular(ctx, visionularTestConfig(), server.URL, "test-access:test-secret", GenerateRequest{Model: "visionular-genopt-1080p", ReferenceVideo: "https://example.com/a.mp4"})
			if scenario == "query-retry" {
				if err != nil || queries != 2 {
					t.Fatalf("read retry failed: %v (%d queries)", err, queries)
				}
				return
			}
			if err == nil {
				t.Fatal("expected failure")
			}
			if strings.Contains(err.Error(), "test-secret") {
				t.Fatal("credential leaked in error")
			}
		})
	}
}

func TestVisionularOutputURLs(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "")
	for _, tc := range []struct{ input, region, base, want string }{
		{"oss://test-bucket/out/a%20b.mp4", "cn-beijing", "", "https://test-bucket.oss-cn-beijing.aliyuncs.com/out/a%20b.mp4"},
		{"oss://test-bucket/out/a.mp4", "", "https://cdn.example", "https://cdn.example/out/a.mp4"},
		{"https://cdn.example/out.mp4?signature=abc", "", "", "https://cdn.example/out.mp4?signature=abc"},
		{"oss://test-bucket/out/a.mp4", "", "", ""},
		{"http://169.254.169.254/secret", "", "", ""},
		{"file:///secret", "", "", ""},
	} {
		got, err := visionularOutputURL(tc.input, tc.region, tc.base)
		if tc.want == "" {
			if err == nil {
				t.Errorf("accepted invalid output %q", tc.input)
			}
		} else if err != nil || got != tc.want {
			t.Errorf("got %q %v, want %q", got, err, tc.want)
		}
	}
}

func TestVisionularReadOnlyConnectivityProbe(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	key := []byte("01234567890123456789012345678901")
	encrypted, _ := crypto.Encrypt(key, "test-access:test-secret")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ak, sk, ok := r.BasicAuth()
		if r.Method != "GET" || r.URL.Path != "/vodencoding/v1/list_storage" || !ok || ak != "test-access" || sk != "test-secret" || r.Header.Get("auth-type") != "use-basic" {
			t.Error("probe is not read-only V2 BasicAuth")
		}
		fmt.Fprint(w, `{"code":0,"data":{"list":[]}}`)
	}))
	defer server.Close()
	r := &connectivityRepository{provider: domain.ProviderConfig{Vendor: "Visionular", BaseURL: server.URL, EncryptedAPIKey: encrypted}}
	report, err := NewService(r, key).TestChannelConnectivity(context.Background(), "probe")
	if err != nil || !report.OK || report.HTTPStatus != 200 {
		t.Fatalf("read-only channel probe failed: %#v %v", report, err)
	}
}

type visionularSeedRepo struct {
	fakeRepository
	created *domain.ProviderConfig
}

func (r *visionularSeedRepo) CreateProviderConfig(_ context.Context, pc domain.ProviderConfig) (*domain.ProviderConfig, error) {
	pc.ID = "seed-channel"
	r.created = &pc
	return &pc, nil
}

func TestVisionularBootstrapEncryptedAndNonDestructive(t *testing.T) {
	t.Setenv("VISIONULAR_ACCESS_KEY", "test-access")
	t.Setenv("VISIONULAR_SECRET_KEY", "test-secret")
	t.Setenv("VISIONULAR_PIPELINE", "pipe")
	t.Setenv("VISIONULAR_STORAGE_ID", "storage")
	key := []byte("01234567890123456789012345678901")
	r := &visionularSeedRepo{}
	if err := NewService(r, key).EnsureVisionularProviderFromEnv(context.Background()); err != nil {
		t.Fatal(err)
	}
	pc := r.created
	if pc == nil || len(pc.ModelList) != 3 || pc.BaseURL != visionularBaseURL || pc.Status != "enabled" {
		t.Fatalf("incorrect bootstrap: %#v", pc)
	}
	plain, err := crypto.Decrypt(key, pc.EncryptedAPIKey)
	if err != nil || plain != "test-access:test-secret" || pc.EncryptedAPIKey == plain {
		t.Fatal("credentials not encrypted")
	}
	if strings.Contains(string(pc.ParameterSchema), "test-secret") || strings.Contains(string(pc.ParameterSchema), "test-access") {
		t.Fatal("credentials leaked in public schema")
	}
	r.created = nil
	r.providerConfigs = []domain.ProviderConfig{{Vendor: "Visionular", Status: "disabled"}}
	if err := NewService(r, key).EnsureVisionularProviderFromEnv(context.Background()); err != nil || r.created != nil {
		t.Fatal("bootstrap overwrote administrator configuration")
	}
}
