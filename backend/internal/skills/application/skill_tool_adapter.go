package application

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

// SkillTool wraps a stored Skill row so it can be exposed to the LLM as a
// regular Tool. The LLM picks tools by name, so we sanitize the skill name
// into something matching ^[a-zA-Z0-9_-]+$ that OpenAI accepts.
type SkillTool struct {
	skill    sqlc.Skill
	executor *Executor
	safeName string
}

func NewSkillTool(skill sqlc.Skill, executor *Executor) *SkillTool {
	return &SkillTool{
		skill:    skill,
		executor: executor,
		safeName: sanitizeToolName(skill.Name),
	}
}

func (t *SkillTool) Name() string { return t.safeName }

func (t *SkillTool) Description() string {
	if t.skill.Description != "" {
		return t.skill.Description
	}
	return "Skill " + t.skill.Name
}

func (t *SkillTool) Parameters() json.RawMessage {
	if len(t.skill.InputSchema) > 0 && string(t.skill.InputSchema) != "{}" && string(t.skill.InputSchema) != "null" {
		return t.skill.InputSchema
	}
	// Sensible default: a free-form object so the LLM can pass any args.
	return json.RawMessage(`{"type":"object","additionalProperties":true}`)
}

func (t *SkillTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	result, err := t.executor.Invoke(ctx, t.skill, args)
	if err != nil {
		return "", err
	}
	// Wrap the result so the LLM sees a structured tool_result payload.
	envelope := map[string]string{"type": result.Type, "content": result.Content}
	out, _ := json.Marshal(envelope)
	return string(out), nil
}

var safeNamePattern = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func sanitizeToolName(raw string) string {
	clean := safeNamePattern.ReplaceAllString(strings.TrimSpace(raw), "_")
	clean = strings.Trim(clean, "_-")
	if clean == "" {
		clean = "skill"
	}
	if len(clean) > 60 {
		clean = clean[:60]
	}
	return clean
}

// BuildSkillTools loads the agent's bound skills from the DB and wraps each as
// a Tool. Disabled skills are silently skipped.
func LoadBoundSkills(ctx context.Context, q *sqlc.Queries, skillIDs []pgtype.UUID) []sqlc.Skill {
	rows := make([]sqlc.Skill, 0, len(skillIDs))
	for _, id := range skillIDs {
		if !id.Valid {
			continue
		}
		skill, err := q.GetSkill(ctx, id)
		if err != nil || !skill.Enabled {
			continue
		}
		rows = append(rows, skill)
	}
	return rows
}

func BuildSkillToolsFromRows(executor *Executor, skills []sqlc.Skill) []Tool {
	tools := make([]Tool, 0, len(skills))
	for _, skill := range skills {
		tools = append(tools, NewSkillTool(skill, executor))
	}
	return tools
}

func BuildSkillTools(ctx context.Context, q *sqlc.Queries, executor *Executor, skillIDs []pgtype.UUID) []Tool {
	return BuildSkillToolsFromRows(executor, LoadBoundSkills(ctx, q, skillIDs))
}
