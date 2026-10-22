package interfaces

import (
	"context"
	"encoding/json"
	"time"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	skillsapp "ccy-canvas/backend/internal/skills/application"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func (rt *AgentRunRouter) delegationTools(ctx context.Context, parent sqlc.Agent, userID pgtype.UUID, emit func(string, any), parentModelOverride ...string) []skillsapp.Tool {
	rows, err := rt.q.ListAllAgents(ctx)
	if err != nil || parent.DeployKey == "" {
		return nil
	}
	children := []sqlc.Agent{}
	for _, child := range rows {
		if skillsapp.CanDelegateAgent(parent, child) && agentAccessibleBy(child, userID) {
			children = append(children, child)
		}
	}
	// Keep a strict budget shared by all direct children in this parent run.
	calls := 0
	return skillsapp.BuildAgentDispatchTool(children, func(ctx context.Context, child sqlc.Agent, args json.RawMessage) (string, error) {
		if calls >= 4 {
			return "", apperror.New(apperror.CodeConflict, "本次子任务上限为 4，请根据已有结果继续")
		}
		calls++
		latest, err := rt.q.GetAgent(ctx, child.ID)
		if err != nil || !skillsapp.CanDelegateAgent(parent, latest) || !agentAccessibleBy(latest, userID) {
			return "", apperror.New(apperror.CodeConflict, "子 Agent 已停用或不再允许调度")
		}
		child = latest
		route := rt.resolveAgentRoute(ctx, child)
		model := skillsapp.ResolveCatalogModelName(route)
		mode := skillsapp.AgentUseModeSimple
		if row, e := rt.q.GetAgentSetting(ctx, skillsapp.AgentUseModeSettingKey); e == nil {
			var p struct {
				Mode int32 `json:"mode"`
			}
			if json.Unmarshal(row.Value, &p) == nil {
				mode = p.Mode
			}
		}
		if len(parentModelOverride) > 0 && parentModelOverride[0] != "" && (mode != skillsapp.AgentUseModeAdvanced || (child.Model == "" && child.ModelName == "")) {
			model = parentModelOverride[0]
		}
		id := uuid.NewString()
		started := time.Now()
		emit("delegation", map[string]any{"id": id, "agent_id": formatUUID(child.ID), "agent_name": child.Name, "parent_agent_id": formatUUID(parent.ID), "model": model, "status": "running"})
		result, runErr := func() (skillsapp.RunStats, error) {
			resolved, err := rt.catalogSvc.ResolveModelEndpoints(ctx, model)
			if err != nil {
				return skillsapp.RunStats{}, apperror.New(apperror.CodeConflict, "子 Agent 模型不可用，请检查后台模型路由")
			}
			endpoints := []skillsapp.Endpoint{}
			for _, endpoint := range resolved {
				endpoints = append(endpoints, skillsapp.Endpoint{ProviderID: endpoint.ProviderID, BaseURL: endpoint.BaseURL, APIKey: endpoint.APIKey})
			}
			// Advisory children cannot mutate canvas, spend generation credits, call
			// HTTP/code skills or recursively spawn. The parent owns all write actions.
			bound := skillsapp.LoadBoundSkills(ctx, rt.q, child.SkillIDs)
			promptSkills := []sqlc.Skill{}
			for _, skill := range bound {
				if skillsapp.IsGuideSkill(skill) && (skill.Scope == "global" || skill.OwnerID == userID) {
					promptSkills = append(promptSkills, skill)
				}
			}
			childTools := skillsapp.BuildSkillToolsFromRows(rt.executor, promptSkills)
			emitRuntimeSnapshot(child, route, model, childTools, promptSkills, "isolated-advisor", func(event string, data any) {
				emit("delegation_event", map[string]any{"id": id, "event": event, "data": data})
			})
			childCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			runner := skillsapp.Runner{LLM: rt.llm, Endpoints: endpoints, Health: rt.catalogSvc, MaxSteps: 6}
			return runner.Run(childCtx, skillsapp.RunInput{SystemPrompt: child.SystemPrompt + "\n你是独立的文本顾问。仅使用本次明确提供的上下文，缺失内容需说明。返回建议或结构化结果；不能声称已更改画布或生成媒体。", Model: model, UserMessage: string(args), Tools: childTools, Strategy: child.Strategy, Temperature: &route.Temperature, MaxOutputTokens: route.MaxOutputTokens}, func(event string, data any) {
				// Parent message stream remains isolated from the child's token stream.
				if event != "message_delta" && event != "thought_delta" && event != "thought" {
					emit("delegation_event", map[string]any{"id": id, "event": event, "data": data})
				}
			})
		}()
		status := "success"
		message := ""
		if runErr != nil {
			status = "error"
			message = apperror.PublicMessage(runErr)
		}
		emit("delegation", map[string]any{"id": id, "agent_id": formatUUID(child.ID), "agent_name": child.Name, "model": model, "status": status, "duration_ms": time.Since(started).Milliseconds(), "steps": result.Steps, "tool_calls": result.ToolCalls, "usage": result.TotalUsage, "error": message})
		if runErr != nil {
			return "", runErr
		}
		payload, _ := json.Marshal(map[string]any{"status": "success", "child_run_id": id, "agent": child.Name, "result": result.FinalReply})
		return string(payload), nil
	})
}

func emitRuntimeSnapshot(agent sqlc.Agent, route skillsapp.AgentRouteConfig, model string, tools []skillsapp.Tool, skills []sqlc.Skill, policy string, emit func(string, any)) {
	names := []string{}
	bindings := []map[string]string{}
	for _, tool := range tools {
		names = append(names, tool.Name())
	}
	for _, skill := range skills {
		bindings = append(bindings, map[string]string{"id": formatUUID(skill.ID), "name": skill.Name})
	}
	emit("runtime", map[string]any{"agent_id": formatUUID(agent.ID), "agent_name": agent.Name, "deploy_key": agent.DeployKey, "config_updated_at": formatTime(agent.UpdatedAt), "model": model, "configured_model": skillsapp.ResolveCatalogModelName(route), "temperature": route.Temperature, "max_output_tokens": route.MaxOutputTokens, "strategy": agent.Strategy, "tools": names, "skills": bindings, "policy": policy})
}
