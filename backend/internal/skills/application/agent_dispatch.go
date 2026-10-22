package application

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// The production orchestrator may consult any visible, enabled specialist.
// Other agents retain their configured direct-child boundary.
func CanDelegateAgent(parent, child sqlc.Agent) bool {
	if !child.Enabled || parent.ID == child.ID {
		return false
	}
	return (parent.DeployKey == "productionAgent" && child.DeployKey != "productionAgent") ||
		(parent.DeployKey != "" && child.ParentDeployKey == parent.DeployKey)
}

type agentDispatchTool struct {
	agents []sqlc.Agent
	run    func(context.Context, sqlc.Agent, json.RawMessage) (string, error)
}

func BuildAgentDispatchTool(agents []sqlc.Agent, run func(context.Context, sqlc.Agent, json.RawMessage) (string, error)) []Tool {
	enabled := []sqlc.Agent{}
	for _, agent := range agents {
		if agent.Enabled {
			enabled = append(enabled, agent)
		}
	}
	if len(enabled) == 0 {
		return nil
	}
	return []Tool{&agentDispatchTool{agents: enabled, run: run}}
}
func (t *agentDispatchTool) Name() string { return "delegate_agent" }
func (t *agentDispatchTool) Description() string {
	var b strings.Builder
	b.WriteString("按任务需要选择一位专业 Agent 执行独立文本子任务；简单问候和普通问题直接回答，不委派。主 Agent 负责审核结果和执行画布操作。可用顾问：\n")
	for _, agent := range t.agents {
		fmt.Fprintf(&b, "- %x: %s — %s\n", agent.ID.Bytes, agent.Name, agent.Description)
	}
	return b.String()
}
func (t *agentDispatchTool) Parameters() json.RawMessage {
	ids := []string{}
	for _, agent := range t.agents {
		ids = append(ids, fmt.Sprintf("%x", agent.ID.Bytes))
	}
	raw, _ := json.Marshal(map[string]any{"type": "object", "properties": map[string]any{
		"agent_id":        map[string]any{"type": "string", "enum": ids},
		"instruction":     map[string]any{"type": "string", "description": "具体、独立、可验证的子任务"},
		"task_context":    map[string]any{"type": "object"},
		"expected_output": map[string]any{"type": "string"},
	}, "required": []string{"agent_id", "instruction"}, "additionalProperties": false})
	return raw
}
func (t *agentDispatchTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		AgentID     string `json:"agent_id"`
		Instruction string `json:"instruction"`
	}
	if json.Unmarshal(args, &input) != nil || strings.TrimSpace(input.Instruction) == "" {
		return "", apperror.New(apperror.CodeInvalidInput, "请选择专业 Agent 并提供明确的子任务")
	}
	for _, agent := range t.agents {
		if fmt.Sprintf("%x", agent.ID.Bytes) == input.AgentID {
			return (&delegationTool{child: agent, run: t.run}).Execute(ctx, args)
		}
	}
	return "", apperror.New(apperror.CodeForbidden, "该 Agent 未启用或不在本次允许调度的范围内")
}
