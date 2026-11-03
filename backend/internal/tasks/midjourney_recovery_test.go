package tasks

import (
	"context"
	"errors"
	"fmt"
	"testing"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/shared/apperror"
)

func TestMidjourneyRedeliveryRequiresDurableCheckpoint(t *testing.T) {
	for _, status := range []string{"running", "retrying"} {
		for _, checkpoint := range []string{"", "{\"_upstream_task_id\":\"kt-1\"}", "{\"_upstream_task_id\":\"kt-1\",\"_upstream_provider_id\":\"provider-1\"}"} {
			req := modelapp.GenerateRequest{ServiceType: "image", Model: "midjourney-v8-2"}
			restoreProviderCheckpoint(&req, []byte(checkpoint))
			err := validateMidjourneyRedelivery(req, status)
			complete := req.UpstreamTaskID != "" && req.UpstreamProviderID != ""
			if (err == nil) != complete {
				t.Fatalf("status=%s checkpoint=%s err=%v", status, checkpoint, err)
			}
			if complete && req.ProviderConfigID != "provider-1" {
				t.Fatal("recovery not bound to original provider")
			}
		}
	}
	for _, req := range []modelapp.GenerateRequest{
		{ServiceType: "image", Model: "midjourney-v8-2"},
		{ServiceType: "image", Model: "gpt-image-2"},
	} {
		if err := validateMidjourneyRedelivery(req, "queued"); err != nil {
			t.Fatal("fresh queued task blocked", err)
		}
	}
	if err := validateMidjourneyRedelivery(modelapp.GenerateRequest{ServiceType: "image", Model: "gpt-image-2"}, "running"); err != nil {
		t.Fatal("changed unrelated image recovery policy", err)
	}
}

func TestMidjourneyRetriesPersistenceButNeverReplaysFailedSubmit(t *testing.T) {
	fresh := modelapp.GenerateRequest{ServiceType: "image", Model: "midjourney-v8-2"}
	resumed := fresh
	resumed.UpstreamTaskID, resumed.UpstreamProviderID = "kt-existing", "provider"
	if !shouldResumeMidjourneyAfterFailure(fresh, fmt.Errorf("result: %w", modelapp.ErrMidjourneyResultPersistence)) {
		t.Fatal("completed task persistence failure was discarded")
	}
	if shouldResumeMidjourneyAfterFailure(fresh, errors.New("connection reset")) {
		t.Fatal("ambiguous initial POST could be automatically replayed")
	}
	if !shouldResumeMidjourneyAfterFailure(resumed, errors.New("database unavailable")) {
		t.Fatal("read-only recovery may retry temporary DB failure")
	}
	for _, err := range []error{nil, context.DeadlineExceeded, apperror.New(apperror.CodeInvalidInput, "bad model")} {
		if shouldResumeMidjourneyAfterFailure(resumed, err) {
			t.Fatalf("unexpected recovery retry: %v", err)
		}
	}
	if shouldResumeMidjourneyAfterFailure(modelapp.GenerateRequest{ServiceType: "image", Model: "other"}, modelapp.ErrMidjourneyResultPersistence) {
		t.Fatal("changed unrelated image retry policy")
	}
}
