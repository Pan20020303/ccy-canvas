package application

import (
	"context"
	"encoding/json"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

type deepRetrieveTool struct {
	q            *sqlc.Queries
	userID       pgtype.UUID
	agentID      pgtype.UUID
	isolationKey string
}

func BuildDeepRetrieveTool(q *sqlc.Queries, userID, agentID pgtype.UUID, projectID, workspaceID string) Tool {
	isolationKey := strings.TrimSpace(projectID + ":" + workspaceID)
	if isolationKey == ":" {
		isolationKey = "default"
	}
	return &deepRetrieveTool{q: q, userID: userID, agentID: agentID, isolationKey: isolationKey}
}

func (t *deepRetrieveTool) Name() string { return "deep_retrieve" }
func (t *deepRetrieveTool) Description() string {
	return "Retrieve persisted agent memory snippets for the current project/workspace."
}
func (t *deepRetrieveTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":false}`)
}
func (t *deepRetrieveTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		Query string `json:"query"`
		Limit int32  `json:"limit"`
	}
	_ = json.Unmarshal(args, &input)
	if input.Limit <= 0 || input.Limit > 20 {
		input.Limit = 5
	}
	rows, err := t.q.ListAgentMemories(ctx, sqlc.ListAgentMemoriesParams{
		UserID:       t.userID,
		AgentID:      t.agentID,
		IsolationKey: t.isolationKey,
		Limit:        input.Limit,
	})
	if err != nil {
		return "", err
	}
	type item struct {
		Role      string `json:"role"`
		Content   string `json:"content"`
		CreatedAt string `json:"created_at,omitempty"`
	}
	query := strings.ToLower(strings.TrimSpace(input.Query))
	out := make([]item, 0, len(rows))
	for _, row := range rows {
		if query != "" && !strings.Contains(strings.ToLower(row.Content), query) && len(out) > 0 {
			continue
		}
		out = append(out, item{Role: row.Role, Content: row.Content, CreatedAt: row.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00")})
		if int32(len(out)) >= input.Limit {
			break
		}
	}
	raw, _ := json.Marshal(out)
	return string(raw), nil
}

type subAgentTool struct {
	q              *sqlc.Queries
	name           string
	description    string
	childDeployKey string
}

func BuildCreatorSuiteSubAgentTools(q *sqlc.Queries, _ *Executor, agent sqlc.Agent) []Tool {
	switch agent.DeployKey {
	case "scriptAgent", "scriptAgent:decisionAgent":
		return []Tool{
			newSubAgentTool(q, "run_sub_agent_storySkeleton", "Ask the story skeleton child agent to produce or refine narrative structure.", "scriptAgent:storySkeletonAgent"),
			newSubAgentTool(q, "run_sub_agent_adaptationStrategy", "Ask the adaptation strategy child agent to turn source text into production strategy.", "scriptAgent:adaptationStrategyAgent"),
			newSubAgentTool(q, "run_sub_agent_script", "Ask the script child agent to write executable scene/script output.", "scriptAgent:scriptAgent"),
			newSubAgentTool(q, "run_supervision_agent", "Ask the script supervision child agent to check outputs against constraints.", "scriptAgent:supervisionAgent"),
		}
	case "productionAgent", "productionAgent:decisionAgent":
		return []Tool{
			newSubAgentTool(q, "run_sub_agent_derive_assets", "Ask the asset derivation child agent to extract roles, scenes, props, and references.", "productionAgent:deriveAssetsAgent"),
			newSubAgentTool(q, "run_sub_agent_generate_assets", "Ask the asset generation child agent to prepare image/video asset tasks.", "productionAgent:generateAssetsAgent"),
			newSubAgentTool(q, "run_sub_agent_director_plan", "Ask the director planning child agent to plan camera, pacing, and node layout.", "productionAgent:directorPlanAgent"),
			newSubAgentTool(q, "run_sub_agent_storyboard_gen", "Ask the storyboard generation child agent to draft shot prompts.", "productionAgent:storyboardGenAgent"),
			newSubAgentTool(q, "run_sub_agent_storyboard_panel", "Ask the storyboard panel child agent to turn prompts into canvas panel steps.", "productionAgent:storyboardPanelAgent"),
			newSubAgentTool(q, "run_sub_agent_storyboard_table", "Ask the storyboard table child agent to organize shot tables and production data.", "productionAgent:storyboardTableAgent"),
			newSubAgentTool(q, "run_sub_agent_supervision", "Ask the production supervision child agent to verify output completeness.", "productionAgent:supervisionAgent"),
		}
	default:
		return nil
	}
}

func newSubAgentTool(q *sqlc.Queries, name, description, childDeployKey string) Tool {
	return &subAgentTool{q: q, name: name, description: description, childDeployKey: childDeployKey}
}

func (t *subAgentTool) Name() string { return t.name }
func (t *subAgentTool) Description() string {
	return t.description
}
func (t *subAgentTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"instruction":{"type":"string"},"task_context":{"type":"object"},"expected_output":{"type":"string"}},"required":["instruction"],"additionalProperties":true}`)
}
func (t *subAgentTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	child, err := t.q.GetAgentByDeployKey(ctx, t.childDeployKey)
	if err != nil {
		return "", err
	}
	var input map[string]any
	_ = json.Unmarshal(args, &input)
	route := AgentRouteConfigFromRow(child)
	payload := map[string]any{
		"status":           "ready",
		"child_agent":      child.Name,
		"child_deploy_key": child.DeployKey,
		"runtime":          child.Runtime,
		"model":            ResolveCatalogModelName(route),
		"system_prompt":    child.SystemPrompt,
		"instruction":      input["instruction"],
		"task_context":     input["task_context"],
		"expected_output":  input["expected_output"],
		"execution_hint":   "Use this child agent configuration and its bound skills to complete the requested step.",
	}
	raw, _ := json.Marshal(payload)
	return string(raw), nil
}
