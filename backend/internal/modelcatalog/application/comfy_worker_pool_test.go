package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestBuildCandidatesExpandsSelectedComfyComputePool(t *testing.T) {
	repo := &fakeRepository{providerConfigs: []domain.ProviderConfig{
		comfyPoolTestConfig("worker-a", "http://worker-a:8188", "h3-lan"),
		comfyPoolTestConfig("worker-b", "http://worker-b:8188", "h3-lan"),
		comfyPoolTestConfig("worker-c", "http://worker-c:8188", "other-pool"),
	}}
	service := NewService(repo, nil)
	candidates, err := service.buildCandidates(GenerateRequest{
		ServiceType:      "video",
		ProviderConfigID: "worker-b",
		Model:            comfyMiniMaxH3Model,
	})
	if err != nil {
		t.Fatalf("buildCandidates returned error: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidate count = %d, want 2", len(candidates))
	}
	if candidates[0].cfg.ID != "worker-b" || candidates[1].cfg.ID != "worker-a" {
		t.Fatalf("candidate IDs = [%s %s], want [worker-b worker-a]", candidates[0].cfg.ID, candidates[1].cfg.ID)
	}
}

func TestComfyWorkerPoolSelectsIdleWorker(t *testing.T) {
	busy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/queue" {
			t.Fatalf("busy worker path = %q, want /queue", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"queue_running":[[1,"busy"]],"queue_pending":[]}`))
	}))
	defer busy.Close()
	idle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/queue" {
			t.Fatalf("idle worker path = %q, want /queue", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"queue_running":[],"queue_pending":[]}`))
	}))
	defer idle.Close()

	busyConfig := comfyPoolTestConfig("busy", busy.URL, "h3-lan")
	idleConfig := comfyPoolTestConfig("idle", idle.URL, "h3-lan")
	candidates := []candidateChannel{
		{cfg: &busyConfig, baseURL: busy.URL},
		{cfg: &idleConfig, baseURL: idle.URL},
	}
	scheduler := newComfyWorkerPoolScheduler()
	selected, release, err := scheduler.selectWorker(context.Background(), candidates)
	if err != nil {
		t.Fatalf("selectWorker returned error: %v", err)
	}
	defer release()
	if selected.cfg.ID != "idle" {
		t.Fatalf("selected worker = %q, want idle", selected.cfg.ID)
	}
}

func TestComfyWorkerPoolDoesNotSwitchWhenPoolIsNotConfigured(t *testing.T) {
	config := comfyPoolTestConfig("exact", "http://127.0.0.1:1", "")
	scheduler := newComfyWorkerPoolScheduler()
	selected, release, err := scheduler.selectWorker(context.Background(), []candidateChannel{{cfg: &config, baseURL: config.BaseURL}})
	if err != nil {
		t.Fatalf("selectWorker returned error: %v", err)
	}
	release()
	if selected.cfg.ID != "exact" {
		t.Fatalf("selected worker = %q, want exact", selected.cfg.ID)
	}
}

func TestComfyChannelConnectivityUsesNativeQueueWithoutAPIKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/queue" {
			t.Fatalf("path = %q, want /queue", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"queue_running":[],"queue_pending":[[2,"queued"]]}`))
	}))
	defer server.Close()
	config := comfyPoolTestConfig("worker-native", server.URL, "h3-lan")
	service := NewService(&fakeRepository{providerConfigs: []domain.ProviderConfig{config}}, nil)
	report, err := service.TestChannelConnectivity(context.Background(), config.ID)
	if err != nil {
		t.Fatalf("TestChannelConnectivity returned error: %v", err)
	}
	if !report.OK || report.HTTPStatus != http.StatusOK {
		t.Fatalf("report = %+v, want healthy HTTP 200", report)
	}
}

func comfyPoolTestConfig(id, baseURL, pool string) domain.ProviderConfig {
	schema, _ := json.Marshal(map[string]any{
		"compute_pool":    pool,
		"worker_name":     id,
		"max_concurrency": 1,
	})
	return domain.ProviderConfig{
		ID:              id,
		ServiceType:     "video",
		Vendor:          "ComfyUI",
		Name:            id,
		Status:          "enabled",
		BaseURL:         baseURL,
		ModelList:       []string{comfyMiniMaxH3Model},
		ParameterSchema: schema,
	}
}
