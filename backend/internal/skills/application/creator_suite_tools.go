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
	return &deepRetrieveTool{q: q, userID: userID, agentID: agentID, isolationKey: memoryIsolationKey(projectID, workspaceID)}
}

func (t *deepRetrieveTool) Name() string { return "deep_retrieve" }
func (t *deepRetrieveTool) Description() string {
	return "检索你的持久记忆(跨会话):用户偏好、项目设定、历史对话要点。需要回忆用户背景或之前聊过的内容时调用。query 传关键词。"
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

// ─── save_memory:模型主动持久化长期记忆(hermes 式 self-nudge)────────────────
// 与 deep_retrieve 同一隔离域(user+agent+project:workspace):save 存进去的,
// retrieve 一定能召回。给模型一个「记住这件事」的动作,是跨会话个性化的写入端。

const memoryContentMaxLen = 2000 // 防单条爆表;超长截断(按 rune,防切碎中文)

func truncateMemoryContent(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= memoryContentMaxLen {
		return s
	}
	return string(r[:memoryContentMaxLen])
}

type saveMemoryTool struct {
	q            *sqlc.Queries
	userID       pgtype.UUID
	agentID      pgtype.UUID
	isolationKey string
}

func BuildSaveMemoryTool(q *sqlc.Queries, userID, agentID pgtype.UUID, projectID, workspaceID string) Tool {
	return &saveMemoryTool{q: q, userID: userID, agentID: agentID, isolationKey: memoryIsolationKey(projectID, workspaceID)}
}

// memoryIsolationKey 与 BuildDeepRetrieveTool 的规则保持一致(读写同域)。
func memoryIsolationKey(projectID, workspaceID string) string {
	key := strings.TrimSpace(projectID + ":" + workspaceID)
	if key == ":" {
		return "default"
	}
	return key
}

func (t *saveMemoryTool) Name() string { return "save_memory" }
func (t *saveMemoryTool) Description() string {
	return "把值得长期记住的信息存入持久记忆(跨会话生效):用户偏好、项目设定、重要决定、反复出现的事实。content 写一句自包含的陈述;kind 选 preference/fact/decision/profile 之一。"
}
func (t *saveMemoryTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"content":{"type":"string","description":"要记住的内容(一句自包含的陈述)"},"kind":{"type":"string","enum":["preference","fact","decision","profile"]}},"required":["content"],"additionalProperties":false}`)
}
func (t *saveMemoryTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		Content string `json:"content"`
		Kind    string `json:"kind"`
	}
	_ = json.Unmarshal(args, &input)
	content := truncateMemoryContent(input.Content)
	if content == "" {
		return `{"saved":false,"reason":"content is empty"}`, nil
	}
	kind := strings.TrimSpace(input.Kind)
	if kind == "" {
		kind = "fact"
	}
	meta, _ := json.Marshal(map[string]string{"kind": kind, "source": "save_memory"})
	if _, err := t.q.InsertAgentMemory(ctx, sqlc.InsertAgentMemoryParams{
		UserID:       t.userID,
		AgentID:      t.agentID,
		IsolationKey: t.isolationKey,
		Role:         "memory",
		Content:      content,
		Embedding:    []byte(`[]`),
		Metadata:     meta,
		Summarized:   false,
	}); err != nil {
		return "", err
	}
	return `{"saved":true}`, nil
}

// AgentMemoryGuide 追加进每个 agent 的 system prompt:提醒模型主动使用跨会话
// 持久记忆(写入靠 save_memory,召回靠 deep_retrieve)。
const AgentMemoryGuide = `【持久记忆】
你拥有跨会话的持久记忆(按用户隔离):
- 当用户透露长期有效的信息(偏好、项目设定、重要决定、个人背景)时,主动调用 save_memory 记住它;
- 当需要回忆用户背景、之前的约定或历史对话要点时,调用 deep_retrieve 检索;
- 不要把一次性的临时指令存入记忆。`

// PersistTurnMemory 把一轮成功对话写入 agent_memories(best-effort,失败静默):
// 会话消息只在本会话内加载,写进记忆后 deep_retrieve 才能跨会话召回。
func PersistTurnMemory(ctx context.Context, q *sqlc.Queries, userID, agentID pgtype.UUID, projectID, workspaceID, conversationID, userMsg, finalReply string) {
	if q == nil {
		return
	}
	key := memoryIsolationKey(projectID, workspaceID)
	meta, _ := json.Marshal(map[string]string{"source": "turn", "conversation_id": conversationID})
	for _, m := range []struct{ role, content string }{
		{"user", userMsg},
		{"assistant", finalReply},
	} {
		content := truncateMemoryContent(m.content)
		if content == "" {
			continue
		}
		_, _ = q.InsertAgentMemory(ctx, sqlc.InsertAgentMemoryParams{
			UserID:       userID,
			AgentID:      agentID,
			IsolationKey: key,
			Role:         m.role,
			Content:      content,
			Embedding:    []byte(`[]`),
			Metadata:     meta,
			Summarized:   false,
		})
	}
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
