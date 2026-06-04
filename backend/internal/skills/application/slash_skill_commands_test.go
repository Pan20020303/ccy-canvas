package application

import (
	"encoding/json"
	"testing"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

func TestResolveSlashSkillMessage(t *testing.T) {
	rewriteSpec, _ := json.Marshal(map[string]any{
		"slash_command": "rewrite",
		"content_md":    "Rewrite the user's selected content in a warmer, more premium tone.",
		"user_template": "Rewrite the user's selected content in a warmer, more premium tone.",
	})

	summarySpec, _ := json.Marshal(map[string]any{
		"slash_command": "summary",
		"content_md":    "Summarize the content into concise bullets.",
		"user_template": "Summarize the content into concise bullets.",
	})

	boundSkills := []sqlc.Skill{
		{
			Name:    "Rewrite",
			Kind:    "prompt",
			Spec:    rewriteSpec,
			Enabled: true,
		},
		{
			Name:    "Summary",
			Kind:    "prompt",
			Spec:    summarySpec,
			Enabled: false,
		},
	}

	message, invoked := ResolveSlashSkillMessage("/rewrite Turn this into a warmer launch caption.", boundSkills)
	if invoked != "/rewrite" {
		t.Fatalf("expected /rewrite, got %q", invoked)
	}

	expected := "Use the following bound skill template while answering.\n\n" +
		"Skill: /rewrite\n" +
		"Template:\n" +
		"Rewrite the user's selected content in a warmer, more premium tone.\n\n" +
		"User request:\n" +
		"Turn this into a warmer launch caption."
	if message != expected {
		t.Fatalf("unexpected injected message:\n%s", message)
	}

	raw, none := ResolveSlashSkillMessage("/summary Summarize this launch brief.", boundSkills)
	if none != "" {
		t.Fatalf("expected empty invoked command for unavailable skill, got %q", none)
	}
	if raw != "/summary Summarize this launch brief." {
		t.Fatalf("expected raw message passthrough, got %q", raw)
	}
}
