package application

import (
	"testing"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestBuildSkillToolsUsesUniqueSlashCommandNamesForChineseSkills(t *testing.T) {
	skills := []sqlc.Skill{
		{Name: "Logo设计风格", Spec: []byte(`{"slash_command":"logoDesignStyle"}`), Enabled: true},
		{Name: "房产宣传物料", Spec: []byte(`{"slash_command":"realEstateCampaign"}`), Enabled: true},
	}
	tools := BuildSkillToolsFromRows(nil, skills)
	if got, want := tools[0].Name(), "skill_logoDesignStyle"; got != want {
		t.Fatalf("first tool name = %q, want %q", got, want)
	}
	if got, want := tools[1].Name(), "skill_realEstateCampaign"; got != want {
		t.Fatalf("second tool name = %q, want %q", got, want)
	}
	if tools[0].Name() == tools[1].Name() {
		t.Fatal("tool names must be unique")
	}
}

func TestBuildSkillToolsAddsIDSuffixWhenCommandsCollide(t *testing.T) {
	skills := []sqlc.Skill{
		{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, Name: "技能一", Spec: []byte(`{"slash_command":"campaign"}`), Enabled: true},
		{ID: pgtype.UUID{Bytes: [16]byte{2}, Valid: true}, Name: "技能二", Spec: []byte(`{"slash_command":"campaign"}`), Enabled: true},
	}
	tools := BuildSkillToolsFromRows(nil, skills)
	if tools[0].Name() == tools[1].Name() {
		t.Fatal("colliding slash commands must receive distinct tool names")
	}
}
