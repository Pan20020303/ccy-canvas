package interfaces

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"encoding/json"
	"strings"
	"testing"
)

func TestAdminTraceDoesNotExposeToolContents(t *testing.T) {
	for _, event := range []string{"tool_call", "tool_result", "message", "thought", "error"} {
		data := safeAgentAuditData(event, []byte(`{"id":"tool-1","name":"fetch","ok":true,"arguments":"secret-input","result":"secret-output","message":"secret-error","api_key":"secret-key"}`))
		raw, _ := json.Marshal(data)
		if strings.Contains(string(raw), "secret") {
			t.Fatalf("%s leaked %s", event, raw)
		}
	}
	data := safeAgentAuditData("delegation_event", []byte(`{"id":"child","event":"tool_result","data":{"name":"fetch","result":"secret","ok":true}}`))
	raw, _ := json.Marshal(data)
	if strings.Contains(string(raw), "secret") {
		t.Fatal(string(raw))
	}
}
func TestPublicAgentIncludesRuntimeIdentity(t *testing.T) {
	row := sqlc.Agent{Model: "display-only", ModelName: "provider:real-model", DeployKey: "root", ParentDeployKey: "parent"}
	item := toAgentItem(row)
	if item.DeployKey != "root" || item.ParentDeployKey != "parent" || item.Model != "real-model" {
		t.Fatalf("runtime identity missing: %+v", item)
	}
	if toAdminAgentItem(row).Model != "display-only" {
		t.Fatal("admin editable model must be preserved")
	}
}

func TestAdminTraceShowsOnlyMarkedPublicFailure(t *testing.T) {
	data := safeAgentAuditData("error", []byte(`{"source":"application_error","message":"duration unsupported; token=secret-value","code":"UPSTREAM_UNAVAILABLE","retryable":false,"raw_body":"private"}`))
	raw, _ := json.Marshal(data)
	if !strings.Contains(string(raw), "duration unsupported") || strings.Contains(string(raw), "secret-value") || strings.Contains(string(raw), "private") {
		t.Fatal(string(raw))
	}
	nested := safeAgentAuditData("delegation_event", []byte(`{"event":"error","data":{"source":"application_error","message":"model unavailable","code":"UPSTREAM_UNAVAILABLE"}}`))
	raw, _ = json.Marshal(nested)
	if !strings.Contains(string(raw), "model unavailable") {
		t.Fatal(string(raw))
	}
}
