package application

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"context"
	"encoding/json"
	"errors"
	"strings"
)

var ErrAgentSessionBusy = errors.New("agent session is busy")

type MemoryPolicy struct {
	ShortTermLimit int32 `json:"shortTermLimit"`
	RetrieveLimit  int32 `json:"deepRetrieveSummaryLimit"`
}

func NormalizeMemoryPolicy(raw []byte) MemoryPolicy {
	p := MemoryPolicy{ShortTermLimit: 12, RetrieveLimit: 5}
	_ = json.Unmarshal(raw, &p)
	if p.ShortTermLimit < 1 {
		p.ShortTermLimit = 12
	}
	if p.ShortTermLimit > 50 {
		p.ShortTermLimit = 50
	}
	if p.RetrieveLimit < 1 {
		p.RetrieveLimit = 5
	}
	if p.RetrieveLimit > 20 {
		p.RetrieveLimit = 20
	}
	return p
}
func LoadMemoryPolicy(ctx context.Context, q *sqlc.Queries) MemoryPolicy {
	row, err := q.GetAgentSetting(ctx, AgentMemorySettingsKey)
	if err != nil {
		return NormalizeMemoryPolicy(nil)
	}
	return NormalizeMemoryPolicy(row.Value)
}

// The SQL fetch reserves three rows per turn (user, tool log, assistant).
// Trim by user boundaries so conversations without tool logs still respect N.
func LimitHistoryTurns(messages []sqlc.AgentConversationMessage, limit int32) []sqlc.AgentConversationMessage {
	if limit <= 0 {
		return nil
	}
	count, firstUser := int32(0), -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			firstUser = i
			count++
			if count == limit {
				return messages[i:]
			}
		}
	}
	if firstUser < 0 {
		return nil
	}
	return messages[firstUser:]
}
func IsGuideSkill(skill sqlc.Skill) bool {
	if guideContentMD(skill) == "" {
		return false
	}
	if skill.Kind == "prompt" {
		return true
	}
	// Older bundled Markdown guides were incorrectly labelled as code. Read
	// their text only; this never enables arbitrary code execution.
	var spec struct {
		Source     string `json:"source"`
		SourceType string `json:"source_type"`
	}
	_ = json.Unmarshal(skill.Spec, &spec)
	return skill.Kind == "code" && isCreatorSuiteSource(spec.Source) && spec.SourceType == "skill"
}
func ResolveSelectedSkillMessage(raw string, skill sqlc.Skill) (string, string) {
	command := slashCommandName(skill)
	trimmed := strings.ToLower(strings.TrimSpace(raw))
	if trimmed != strings.ToLower(command) && !strings.HasPrefix(trimmed, strings.ToLower(command)+" ") {
		raw = command + " " + raw
	}
	return ResolveSlashSkillMessage(raw, []sqlc.Skill{skill})
}
