package interfaces

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	"context"
	"encoding/json"
	"github.com/danielgtaylor/huma/v2"
)

type agentEventsInput struct {
	ID    string `path:"id"`
	After int64  `query:"after" minimum:"0" default:"0"`
}
type agentAuditEvent struct {
	ID        int64          `json:"id"`
	Type      string         `json:"type"`
	Data      map[string]any `json:"data"`
	CreatedAt string         `json:"created_at"`
}
type agentEventsPage struct {
	Events  []agentAuditEvent `json:"events"`
	Cursor  int64             `json:"cursor"`
	HasMore bool              `json:"has_more"`
}
type agentEventsOutput struct {
	Body struct {
		Data      agentEventsPage `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *AdminHandler) agentRunEvents(ctx context.Context, input *agentEventsInput) (*agentEventsOutput, error) {
	id, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("任务 ID 不正确")
	}
	if _, err := h.q.GetAgentRunJob(ctx, id); err != nil {
		return nil, huma.Error404NotFound("任务不存在")
	}
	rows, err := h.q.ListAgentRunAuditEvents(ctx, sqlc.ListAgentRunEventsAfterParams{RunID: id, AfterID: input.After, Limit: 200})
	if err != nil {
		return nil, huma.Error500InternalServerError("无法读取运行事件")
	}
	out := &agentEventsOutput{}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	out.Body.Data.Events = []agentAuditEvent{}
	out.Body.Data.Cursor = input.After
	out.Body.Data.HasMore = len(rows) == 200
	for _, row := range rows {
		out.Body.Data.Cursor = row.ID
		out.Body.Data.Events = append(out.Body.Data.Events, agentAuditEvent{ID: row.ID, Type: row.EventType, Data: safeAgentAuditData(row.EventType, row.Data), CreatedAt: formatTime(row.CreatedAt)})
	}
	return out, nil
}

// Allowlist structural telemetry, never export prompt contents, credentials,
// model reasoning, tool arguments/results or canvas reference URLs.
func safeAgentAuditData(event string, raw json.RawMessage) map[string]any {
	var source map[string]any
	_ = json.Unmarshal(raw, &source)
	out := map[string]any{}
	keys := []string{}
	switch event {
	case "runtime":
		keys = []string{"agent_id", "agent_name", "deploy_key", "config_updated_at", "model", "configured_model", "temperature", "max_output_tokens", "strategy", "tools", "skills", "policy"}
	case "context_policy":
		keys = []string{"history_turn_limit", "retrieval_limit", "memory_scope", "retrieval", "vector_search"}
	case "delegation":
		keys = []string{"id", "agent_id", "agent_name", "parent_agent_id", "model", "status", "duration_ms", "steps", "tool_calls", "usage"}
	case "delegation_event":
		keys = []string{"id", "event"}
		if name, ok := source["event"].(string); ok {
			nested, _ := json.Marshal(source["data"])
			out["data"] = safeAgentAuditData(name, nested)
		}
	case "lifecycle":
		keys = []string{"status", "conversation_id"}
	case "tool_call", "tool_result":
		keys = []string{"id", "name", "ok"}
		if failure, ok := source["failure"].(map[string]any); ok && failure["source"] == "application_error" {
			if message, ok := failure["message"].(string); ok {
				out["message"] = apperror.SafeProviderText(message)
			}
		}
	case "error":
		if source["source"] == "application_error" {
			if message, ok := source["message"].(string); ok {
				out["message"] = apperror.SafeProviderText(message)
			}
			keys = []string{"code", "retryable"}
		}
	case "canvas_patch":
		keys = []string{"op", "node_id"}
		if moves, ok := source["moves"].([]any); ok {
			out["moved_nodes"] = len(moves)
		}
	case "usage", "usage_total":
		keys = []string{"prompt_tokens", "completion_tokens", "total_tokens"}
	case "done":
		keys = []string{"steps"}
	}
	for _, key := range keys {
		if value, ok := source[key]; ok {
			out[key] = value
		}
	}
	return out
}
