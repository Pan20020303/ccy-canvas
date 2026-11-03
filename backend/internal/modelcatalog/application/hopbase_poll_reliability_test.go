package application

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

func TestHopBasePollingSurvivesTransientFailuresAndLateOutputs(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	polls, submits := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/video/tasks/vt_saved" {
			submits++
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		polls++
		switch polls {
		case 1:
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusBadGateway)
		case 3:
			_, _ = w.Write([]byte(`{"task":{"status":"error"}}`)) // not a documented terminal state
		case 4:
			_, _ = w.Write([]byte(`{"task":{"status":"completed"}}`))
		default:
			_, _ = w.Write([]byte(`{"task":{"status":"completed","outputs":[{"url":"https://media.example.test/result.mp4"}]}}`))
		}
	}))
	defer server.Close()
	result, err := (&Service{}).generateVideoHopBase(context.Background(), &domain.ProviderConfig{ID: "saved-provider"}, server.URL, "mock-key", GenerateRequest{
		UpstreamTaskID: "vt_saved", UpstreamProviderID: "saved-provider",
		// Recovery must not fetch now-expired references or submit the prompt.
		ReferenceImages: []string{"/uploads/missing.png"},
	})
	if err != nil || result == nil || result.Content != "https://media.example.test/result.mp4" || submits != 0 || polls != 5 {
		t.Fatalf("result=%v err=%v submits=%d polls=%d", result, err, submits, polls)
	}
}

func TestHopBaseRecoveryRejectsChangedProviderWithoutSubmitting(t *testing.T) {
	_, err := (&Service{}).generateVideoHopBase(context.Background(), &domain.ProviderConfig{ID: "new-provider"}, "https://example.invalid", "mock-key", GenerateRequest{UpstreamTaskID: "vt_saved", UpstreamProviderID: "old-provider"})
	if err == nil || !strings.Contains(apperror.PublicMessage(err), "渠道已变更") {
		t.Fatalf("err=%v", err)
	}
	_, err = (&Service{}).dispatchToVendor(context.Background(), candidateChannel{cfg: &domain.ProviderConfig{ID: "new-provider"}}, GenerateRequest{UpstreamTaskID: "vt_saved", UpstreamProviderID: "old-provider"})
	if err == nil || !strings.Contains(apperror.PublicMessage(err), "渠道已变更") {
		t.Fatalf("dispatch recovery err=%v", err)
	}
}

func TestHopBaseFailedTaskExposesReasonAndDoesNotRetry(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		polls++
		_, _ = w.Write([]byte(`{"task":{"status":"failed","error_code":"InvalidParameter.TaskTypeConstraint","error_message":"ratio must be adaptive"}}`))
	}))
	defer server.Close()
	_, err := (&Service{}).pollHopBaseVideoTask(context.Background(), server.URL, "mock-key", "vt_failed")
	if err == nil || !strings.Contains(apperror.PublicMessage(err), "ratio must be adaptive") || polls != 1 {
		t.Fatalf("err=%v polls=%d", err, polls)
	}
}

func TestHopBase25ResolutionIncludesCurrent1080pSupport(t *testing.T) {
	for _, tc := range []struct {
		model, resolution string
		allowed           bool
	}{
		{"dreamina-seedance-2-5-260628", "720p", true},
		{"dreamina-seedance-2-5-260628", "1080p", true},
		{"dreamina-seedance-2-5-260628", "4k", false},
		{"doubao-seedance-2-5-260628-a", "1080p", true},
	} {
		caps, ok := hopBaseSeedanceCapabilitiesFor(tc.model)
		_, allowed := caps.resolutions[tc.resolution]
		if !ok || allowed != tc.allowed {
			t.Fatalf("model=%s resolution=%s allowed=%t", tc.model, tc.resolution, allowed)
		}
	}
}

func TestHopBase25Submits1080pWithoutDowngrading(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != hopBaseVideoSubmitPath {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"task":{"status":"completed","outputs":[{"url":"https://media.example.test/1080.mp4"}]}}`))
	}))
	defer server.Close()
	result, err := (&Service{}).generateVideoHopBase(context.Background(), &domain.ProviderConfig{ID: "provider"}, server.URL, "mock-key", GenerateRequest{
		Model: "dreamina-seedance-2-5-260628", Resolution: "1080p", Prompt: "A landscape", Duration: 5, AspectRatio: "16:9",
	})
	if err != nil || result == nil || submitted["resolution"] != "1080p" || submitted["model"] != "dreamina-seedance-2-5-260628" {
		t.Fatalf("result=%v err=%v submitted=%v", result, err, submitted)
	}
}
