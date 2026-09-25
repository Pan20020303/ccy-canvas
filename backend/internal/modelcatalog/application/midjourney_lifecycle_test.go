package application

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestMidjourneyBudgetsOutliveProviderTerminalDeadline(t *testing.T) {
	t.Setenv("IMAGE_TASK_MAX_RUNTIME_SECONDS", "900")
	req := GenerateRequest{ServiceType: "image", Model: "midjourney-v8-2"}
	if MidjourneyTaskPollBudget <= 2*time.Hour {
		t.Fatal("polling must allow the provider's two-hour terminal state to propagate")
	}
	if runtime := maxRuntimeForRequest(req); runtime != MidjourneyTaskRuntimeBudget || runtime < MidjourneyTaskPollBudget+10*time.Minute {
		t.Fatalf("runtime %s does not leave time to save four results", runtime)
	}
	if got := maxRuntimeForRequest(GenerateRequest{ServiceType: "image", Model: "gpt-image-2"}); got != 15*time.Minute {
		t.Fatalf("ordinary image runtime changed to %s", got)
	}
	if got := staleGenerationBudgetForModel("image", "running", req.Model); got <= MidjourneyTaskRuntimeBudget {
		t.Fatalf("reaper budget %s must outlive the worker", got)
	}
	if got := staleGenerationBudgetForModel("image", "queued", req.Model); got != 24*time.Hour {
		t.Fatalf("queued MJ budget = %s, want unchanged queue allowance", got)
	}
}

type midjourneyReaperRepo struct {
	fakeRepository
	rows   []domain.StaleGeneration
	reaped []string
}

func (r *midjourneyReaperRepo) ListStaleActiveGenerations(context.Context, time.Time) ([]domain.StaleGeneration, error) {
	return r.rows, nil
}

func (r *midjourneyReaperRepo) MarkGenerationTimedOut(_ context.Context, logID, _ string) (bool, error) {
	r.reaped = append(r.reaped, logID)
	return true, nil
}

func TestMidjourneyReaperPreservesActiveTwoHourTasks(t *testing.T) {
	t.Setenv("IMAGE_TASK_MAX_RUNTIME_SECONDS", "900")
	repo := &midjourneyReaperRepo{rows: []domain.StaleGeneration{
		{ID: "mj-active", ServiceType: "image", Model: "midjourney-v8-2", Status: "running", CreatedAt: time.Now().Add(-2 * time.Hour)},
		{ID: "mj-expired", ServiceType: "image", Model: "midjourney-v8-2", Status: "running", CreatedAt: time.Now().Add(-3 * time.Hour)},
		{ID: "ordinary-expired", ServiceType: "image", Model: "gpt-image-2", Status: "running", CreatedAt: time.Now().Add(-70 * time.Minute)},
	}}
	count, err := (&Service{repo: repo}).ReapStaleGenerations(context.Background())
	if err != nil || count != 2 || !reflect.DeepEqual(repo.reaped, []string{"mj-expired", "ordinary-expired"}) {
		t.Fatalf("count=%d reaped=%v err=%v", count, repo.reaped, err)
	}
}

func TestMidjourneyPersistenceRejectsMissingOrInvalidSecondaryImage(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	t.Setenv("UPLOAD_DIR", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte(`{"error":"not an image"}`))
	}))
	defer server.Close()
	for _, secondary := range []string{"", server.URL + "/missing", server.URL + "/invalid"} {
		urls := []string{"/uploads/one.png", secondary, "/uploads/three.png", "/uploads/four.png"}
		result := &GenerateResult{Type: "url", Content: urls[0], ContentList: append([]string(nil), urls...)}
		_, err := (&Service{}).persistGeneratedAssetForResult(context.Background(), GenerateRequest{ServiceType: "image", Model: "midjourney-v8-2"}, result, time.Now(), candidateChannel{})
		if err == nil || !strings.Contains(err.Error(), "asset persistence failed") {
			t.Fatalf("secondary %q silently dropped: result=%+v err=%v", secondary, result, err)
		}
		if !reflect.DeepEqual(result.ContentList, urls) {
			t.Fatalf("failed save truncated the original result list: %v", result.ContentList)
		}
	}
}

func TestMidjourneyPersistenceKeepsExactlyFourResults(t *testing.T) {
	urls := []string{"/uploads/one.png", "/uploads/two.png", "/uploads/three.png", "/uploads/four.png"}
	for _, count := range []int{1, 3, 4} {
		result := &GenerateResult{Type: "url", Content: urls[0], ContentList: append([]string(nil), urls[:count]...)}
		_, err := (&Service{}).persistGeneratedAssetForResult(context.Background(), GenerateRequest{ServiceType: "image", Model: "midjourney-v8-2"}, result, time.Now(), candidateChannel{})
		if (err == nil) != (count == 4) {
			t.Fatalf("result count %d: err=%v", count, err)
		}
		if count == 4 && (!reflect.DeepEqual(result.ContentList, urls) || result.Content != urls[0]) {
			t.Fatalf("saved list lost results or order: %+v", result)
		}
	}
}

type resultListRetryRepo struct {
	fakeRepository
	listCalls int
	failures  int
	writes    []string
}

func (r *resultListRetryRepo) SetGenerationLogResultURLs(ctx context.Context, logID, value string) error {
	r.listCalls++
	r.writes = append(r.writes, "list")
	if r.listCalls <= r.failures {
		return errors.New("temporary list write failure")
	}
	return r.fakeRepository.SetGenerationLogResultURLs(ctx, logID, value)
}

func (r *resultListRetryRepo) UpdateGenerationLogResult(ctx context.Context, logID, status, resultURL, errMsg string, durationMs int32, cacheHit bool) error {
	r.writes = append(r.writes, status)
	return r.fakeRepository.UpdateGenerationLogResult(ctx, logID, status, resultURL, errMsg, durationMs, cacheHit)
}

func TestMultiImageResultListWriteRetriesBeforePublishingSuccess(t *testing.T) {
	urls := []string{"/uploads/one.png", "/uploads/two.png", "/uploads/three.png", "/uploads/four.png"}
	for _, failures := range []int{1, 2} {
		repo := &resultListRetryRepo{failures: failures}
		result := &GenerateResult{Type: "url", Content: urls[0], ContentList: urls}
		err := (&Service{repo: repo}).persistGenerationOutcome("log-1", result, nil, time.Second, true)
		if repo.listCalls != 2 || (err == nil) != (failures == 1) {
			t.Fatalf("failures=%d calls=%d err=%v", failures, repo.listCalls, err)
		}
		wantWrites := []string{"list", "list"}
		if failures == 1 {
			wantWrites = append(wantWrites, "success")
			var stored []string
			if json.Unmarshal([]byte(repo.lastLogResultURLs), &stored) != nil || !reflect.DeepEqual(stored, urls) {
				t.Fatalf("stored list = %s", repo.lastLogResultURLs)
			}
		}
		if !reflect.DeepEqual(repo.writes, wantWrites) {
			t.Fatalf("success became visible before the full list was durable: %v", repo.writes)
		}
	}
}
