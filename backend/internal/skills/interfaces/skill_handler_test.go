package interfaces

import (
	"context"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

func TestCreatePersonalSkillRejectsNonPromptKinds(t *testing.T) {
	handler := &Handler{}

	for _, kind := range []string{"http", "code"} {
		t.Run(kind, func(t *testing.T) {
			input := &createSkillInput{}
			input.Body.Kind = kind

			_, err := handler.createPersonalSkill(context.Background(), input)
			if err == nil {
				t.Fatal("expected non-prompt personal skill to be rejected")
			}
			statusErr, ok := err.(huma.StatusError)
			if !ok {
				t.Fatalf("error type = %T, want huma.StatusError", err)
			}
			if statusErr.GetStatus() != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", statusErr.GetStatus(), http.StatusBadRequest)
			}
		})
	}
}

func TestPersonalSkillKindValidationCoversUpdates(t *testing.T) {
	for _, kind := range []string{"http", "code"} {
		err := validatePersonalSkillKind(kind)
		if err == nil {
			t.Fatalf("kind %q should be rejected for create and update paths", kind)
		}
		statusErr, ok := err.(huma.StatusError)
		if !ok || statusErr.GetStatus() != http.StatusBadRequest {
			t.Fatalf("kind %q returned %T with unexpected status", kind, err)
		}
	}
	if err := validatePersonalSkillKind("prompt"); err != nil {
		t.Fatalf("prompt kind should be accepted: %v", err)
	}
}

func TestToAdminSkillItemAddsUploaderIdentity(t *testing.T) {
	item := toAdminSkillItem(
		sqlc.Skill{Name: "个人分镜技能", Scope: "personal"},
		&sqlc.User{Name: "小蔡", Email: "xiaocai@example.com"},
	)

	if item.Name != "个人分镜技能" {
		t.Fatalf("skill name = %q", item.Name)
	}
	if item.UploaderName != "小蔡" {
		t.Fatalf("uploader name = %q", item.UploaderName)
	}
	if item.UploaderEmail != "xiaocai@example.com" {
		t.Fatalf("uploader email = %q", item.UploaderEmail)
	}
}

func TestToAdminSkillItemLeavesOfficialUploaderEmpty(t *testing.T) {
	item := toAdminSkillItem(sqlc.Skill{Name: "官方技能", Scope: "global"}, nil)

	if item.UploaderName != "" || item.UploaderEmail != "" {
		t.Fatalf("official skill unexpectedly has uploader identity: %#v", item)
	}
}
