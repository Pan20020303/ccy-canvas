package tasks

import (
	"encoding/json"
	"testing"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
)

func TestProviderCheckpointIsRestoredOnlyFromDatabase(t *testing.T) {
	payload := []byte(`{"UpstreamTaskID":"forged","UpstreamProviderID":"forged","_upstream_task_id":"vt_saved","_upstream_provider_id":"saved-provider"}`)
	var req modelapp.GenerateRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		t.Fatal(err)
	}
	if req.UpstreamTaskID != "" || req.UpstreamProviderID != "" {
		t.Fatal("HTTP JSON can inject recovery fields")
	}
	restoreProviderCheckpoint(&req, payload)
	if req.UpstreamTaskID != "vt_saved" || req.UpstreamProviderID != "saved-provider" || req.ProviderConfigID != "saved-provider" {
		t.Fatalf("checkpoint not restored: %q %q", req.UpstreamTaskID, req.UpstreamProviderID)
	}
}

func TestIncompleteProviderCheckpointDoesNotTriggerRecovery(t *testing.T) {
	var req modelapp.GenerateRequest
	restoreProviderCheckpoint(&req, []byte(`{"_upstream_task_id":"vt_saved"}`))
	if req.UpstreamTaskID != "" {
		t.Fatal("unbound task accepted")
	}
}
