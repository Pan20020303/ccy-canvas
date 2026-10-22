package application

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"strings"
	"testing"
)

func TestLegacyBundledGuideIsReadableWithoutCodeExecution(t *testing.T) {
	skill := sqlc.Skill{Kind: "code", Enabled: true, Spec: []byte(`{"source":"creator-suite","source_type":"skill","content_md":"真实方法论"}`)}
	result, err := (&Executor{}).Invoke(context.Background(), skill, nil)
	if err != nil || !strings.Contains(result.Content, "真实方法论") {
		t.Fatalf("guide: %+v, %v", result, err)
	}
	skill.Spec = []byte(`{"code":"untrusted()"}`)
	if IsGuideSkill(skill) {
		t.Fatal("arbitrary code must not be treated as a guide")
	}
}
func TestChineseSkillToolNamesRemainUnique(t *testing.T) {
	a := NewSkillTool(sqlc.Skill{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, Name: "角色设定"}, nil)
	b := NewSkillTool(sqlc.Skill{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, Name: "镜头规划"}, nil)
	if a.Name() == b.Name() || len(a.Name()) > 64 || len(b.Name()) > 64 {
		t.Fatalf("invalid names: %s / %s", a.Name(), b.Name())
	}
}

func TestHistoryLimitCountsTurnsNotRows(t *testing.T) {
	messages := []sqlc.AgentConversationMessage{{Role: "assistant", Content: "orphan"}, {Role: "user", Content: "1"}, {Role: "assistant"}, {Role: "user", Content: "2"}, {Role: "tool_log"}, {Role: "assistant"}, {Role: "user", Content: "3"}, {Role: "assistant"}}
	got := LimitHistoryTurns(messages, 2)
	if len(got) != 5 || got[0].Content != "2" {
		t.Fatalf("wrong turn boundary: %+v", got)
	}
	if got = LimitHistoryTurns(messages, 12); len(got) != 7 || got[0].Content != "1" {
		t.Fatal("orphan retained")
	}
}
