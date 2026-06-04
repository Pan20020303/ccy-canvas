package application

import (
	"encoding/json"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

type promptSkillSpec struct {
	SlashCommand string `json:"slash_command"`
	ContentMD    string `json:"content_md"`
	UserTemplate string `json:"user_template"`
}

func ResolveSlashSkillMessage(raw string, boundSkills []sqlc.Skill) (string, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return raw, ""
	}

	parts := strings.Fields(trimmed)
	if len(parts) == 0 || !strings.HasPrefix(parts[0], "/") {
		return trimmed, ""
	}

	for _, skill := range boundSkills {
		if !skill.Enabled || skill.Kind != "prompt" {
			continue
		}
		commandName := slashCommandName(skill)
		if !strings.EqualFold(commandName, parts[0]) {
			continue
		}
		requestText := strings.TrimSpace(strings.Join(parts[1:], " "))
		templateBody := promptTemplateBody(skill)
		message := strings.Join([]string{
			"Use the following bound skill template while answering.",
			"",
			"Skill: " + commandName,
			"Template:",
			templateBody,
			"",
			"User request:",
			requestText,
		}, "\n")
		return message, commandName
	}

	return trimmed, ""
}

func slashCommandName(skill sqlc.Skill) string {
	var spec promptSkillSpec
	_ = json.Unmarshal(skill.Spec, &spec)
	raw := strings.TrimSpace(spec.SlashCommand)
	if raw == "" {
		raw = strings.ToLower(strings.Join(strings.Fields(skill.Name), "-"))
	}
	if strings.HasPrefix(raw, "/") {
		return raw
	}
	return "/" + raw
}

func promptTemplateBody(skill sqlc.Skill) string {
	var spec promptSkillSpec
	_ = json.Unmarshal(skill.Spec, &spec)
	if body := strings.TrimSpace(spec.ContentMD); body != "" {
		return body
	}
	return strings.TrimSpace(spec.UserTemplate)
}
