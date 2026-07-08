package interfaces

import (
	"testing"

	"ccy-canvas/backend/internal/platform/database/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

// 越权修复(安全审计 HIGH-4):个人域 agent 仅 owner 可访问/运行；huma CRUD 路径
// 与 chi 直连的 SSE run 路径共用这一规则，不得漂移。

func TestAgentAccessibleBy(t *testing.T) {
	mkUUID := func(s string) pgtype.UUID {
		var u pgtype.UUID
		if err := u.Scan(s); err != nil {
			t.Fatalf("scan uuid %q: %v", s, err)
		}
		return u
	}
	owner := mkUUID("11111111-1111-1111-1111-111111111111")
	other := mkUUID("22222222-2222-2222-2222-222222222222")

	// personal: owner allowed, everyone else denied
	if !agentAccessibleBy(sqlc.Agent{Scope: "personal", OwnerID: owner}, owner) {
		t.Error("owner must be able to access their own personal agent")
	}
	if agentAccessibleBy(sqlc.Agent{Scope: "personal", OwnerID: owner}, other) {
		t.Error("non-owner must NOT access a personal-scope agent (the HIGH-4 hole)")
	}
	// personal with no valid owner: inaccessible to all
	if agentAccessibleBy(sqlc.Agent{Scope: "personal"}, owner) {
		t.Error("personal agent with no owner must be inaccessible")
	}
	// non-personal scopes: any authenticated user
	for _, scope := range []string{"shared", "workspace", "global", ""} {
		if !agentAccessibleBy(sqlc.Agent{Scope: scope, OwnerID: owner}, other) {
			t.Errorf("scope %q must be accessible by any authenticated user", scope)
		}
	}
}
