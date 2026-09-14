package application

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"testing"
)

func TestMainDispatchChoosesRealSpecialist(t *testing.T) {
	var rootID, childID pgtype.UUID
	_ = rootID.Scan("11111111-1111-1111-1111-111111111111")
	_ = childID.Scan("22222222-2222-2222-2222-222222222222")
	root := sqlc.Agent{ID: rootID, DeployKey: "productionAgent", Enabled: true}
	child := sqlc.Agent{ID: childID, DeployKey: "scriptAgent", Name: "剧本顾问", Enabled: true}
	if !CanDelegateAgent(root, child) || CanDelegateAgent(root, root) {
		t.Fatal("invalid dispatch eligibility")
	}
	calls := 0
	tools := BuildAgentDispatchTool([]sqlc.Agent{child, {Enabled: false}}, func(_ context.Context, selected sqlc.Agent, _ json.RawMessage) (string, error) {
		calls++
		if selected.ID != childID {
			t.Fatal("wrong specialist")
		}
		return "real result", nil
	})
	if len(tools) != 1 || tools[0].Name() != "delegate_agent" {
		t.Fatal("expected one dispatch capability")
	}
	out, err := tools[0].Execute(context.Background(), []byte(fmt.Sprintf(`{"agent_id":"%x","instruction":"整理故事结构"}`, childID.Bytes)))
	if err != nil || out != "real result" || calls != 1 {
		t.Fatalf("%s %v", out, err)
	}
	if _, err = tools[0].Execute(context.Background(), []byte(`{"agent_id":"unknown","instruction":"test"}`)); err == nil {
		t.Fatal("unauthorized specialist accepted")
	}
	child.Enabled = false
	if CanDelegateAgent(root, child) {
		t.Fatal("disabled specialist accepted")
	}
}
