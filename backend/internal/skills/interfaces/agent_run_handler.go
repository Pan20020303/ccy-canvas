// Agent-run SSE handler. Lives outside the huma router because huma can't
// model Server-Sent Events (it always wraps in an envelope). We expose a
// plain chi route at /api/app/agents/{id}/run that authenticates via the
// session cookie just like uploads do.

package interfaces

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// AgentRunRouter wires the SSE endpoint into a chi router. We don't use huma
// here because huma envelopes every response in JSON, which would break SSE.
type AgentRunRouter struct {
	q          *sqlc.Queries
	llm        *skillsapp.LLMClient
	executor   *skillsapp.Executor
	catalogSvc *modelapp.Service
	sessions   session.Manager
}

func NewAgentRunRouter(q *sqlc.Queries, executor *skillsapp.Executor, catalog *modelapp.Service, sessions session.Manager) *AgentRunRouter {
	return &AgentRunRouter{
		q:          q,
		llm:        skillsapp.NewLLMClient(),
		executor:   executor,
		catalogSvc: catalog,
		sessions:   sessions,
	}
}

// RegisterChi attaches /api/app/agents/{id}/run to the supplied router.
func (rt *AgentRunRouter) RegisterChi(r chi.Router) {
	r.Post("/api/app/agents/{id}/run", rt.runAgent)
}

type agentRunRequest struct {
	// What the user typed.
	Message string `json:"message"`
	// Optional: which chat thread to attach this turn to. When empty the
	// runner targets the most recent thread (creating one on first ever
	// turn) — matches the legacy single-thread behavior.
	ConversationID string `json:"conversation_id"`
	// Current canvas snapshot for the agent to reason about.
	Nodes []skillsapp.CanvasNode `json:"nodes"`
	Edges []skillsapp.CanvasEdge `json:"edges"`
	// 分组(名字+成员+外壳几何):支撑"放在分组X上面"这类空间指令。
	Groups []skillsapp.CanvasGroup `json:"groups,omitempty"`
	// Recent conversation context for the selected agent. Kept for backward
	// compat with the old API shape; server-side history is the source of
	// truth now and overrides this if non-empty.
	History     []agentRunHistoryTurn `json:"history"`
	ProjectID   string                `json:"project_id,omitempty"`
	WorkspaceID string                `json:"workspace_id,omitempty"`
	TaskContext json.RawMessage       `json:"task_context,omitempty"`
	// 可用生成模型清单(前端从已启用 provider 提取)。注入 system prompt,
	// 让 agent 能挑合适的图片/视频模型并经 run_node(model=...) 编排生成。
	GenerationModels map[string][]string `json:"generation_models,omitempty"`
	// Optional per-message model override (from the composer model picker).
	// When set, it replaces the agent's configured model for this turn only.
	// If no provider serves it, ResolveModelEndpoints returns an error and the
	// turn is rejected with a clear 400 — same as any unconfigured model.
	Model string `json:"model,omitempty"`
	// 深度思考开关(composer 的「深度思考」按钮)。nil=按模型默认;
	// true/false 显式开关,仅对思考类模型生效(见 application.applyThinkingControl)。
	Thinking *bool `json:"thinking,omitempty"`
	// 视觉模型(前端 pickVisionModel 挑选)。设置后注册 analyze_image 工具,
	// agent 可以"看"画布上的图片(描述/反推提示词/分析构图)。
	VisionModel string `json:"vision_model,omitempty"`
}

type agentRunHistoryTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (rt *AgentRunRouter) runAgent(w http.ResponseWriter, r *http.Request) {
	// 1) Cookie auth (same pattern as upload handler).
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	claims, err := rt.sessions.Parse(cookie.Value)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}
	var userID pgtype.UUID
	_ = userID.Scan(claims.UserID)
	_ = authn.ScopeAdmin // keep authn referenced

	// 2) Resolve agent.
	agentIDStr := chi.URLParam(r, "id")
	pgID, err := parseUUID(agentIDStr)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid agent id"})
		return
	}
	agent, err := rt.q.GetAgent(r.Context(), pgID)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusNotFound, map[string]string{"error": "Agent not found"})
		return
	}
	// 越权修复(安全审计 HIGH-4):个人域 agent 仅 owner 可运行。此路由直挂 chi、
	// 绕过 huma 授权层，必须自己校验——否则任何登录用户凭 agent UUID 就能运行
	// 他人私有 agent，通过模型输出窃取其 system prompt(专有 IP)并调用其私有
	// bound skills。与 huma 路径 loadReadableAgent 共用同一 agentAccessibleBy 规则。
	if !agentAccessibleBy(agent, userID) {
		httpx.WriteJSON(w, r, http.StatusForbidden, map[string]string{"error": "Not allowed to run this agent"})
		return
	}

	var req agentRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
		return
	}

	// 3) Resolve every upstream provider that can serve the agent's model.
	// When more than one vendor declares the same model, ChatStreamMulti will
	// fall back across them on transient errors.
	route := rt.resolveAgentRoute(r.Context(), agent)
	catalogModel := skillsapp.ResolveCatalogModelName(route)
	// Per-message model override (composer model picker), when provided.
	if override := strings.TrimSpace(req.Model); override != "" {
		catalogModel = override
	}
	resolved, err := rt.catalogSvc.ResolveModelEndpoints(r.Context(), catalogModel)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	endpoints := make([]skillsapp.Endpoint, 0, len(resolved))
	for _, ep := range resolved {
		endpoints = append(endpoints, skillsapp.Endpoint{
			ProviderID: ep.ProviderID,
			BaseURL:    ep.BaseURL,
			APIKey:     ep.APIKey,
		})
	}

	// 4) Set up SSE headers + emitter.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx: don't buffer
	w.WriteHeader(http.StatusOK)

	emitter, err := skillsapp.NewEmitter(w)
	if err != nil {
		return
	}
	defer emitter.Close()

	// 5) Build the agent's tool set: canvas tools (if enabled) + bound skills.
	canvas := skillsapp.NewCanvasState(req.Nodes, req.Edges, emitter.Emit)
	tools := []skillsapp.Tool{}
	if agent.CanvasTools {
		tools = append(tools, skillsapp.BuildCanvasTools(canvas)...)
		// 看图工具:前端挑好视觉模型传进来,解析得到端点才注册 ——
		// 没配视觉模型时 agent 不见此工具,不会瞎调。
		if vm := strings.TrimSpace(req.VisionModel); vm != "" {
			if vres, verr := rt.catalogSvc.ResolveModelEndpoints(r.Context(), vm); verr == nil && len(vres) > 0 {
				veps := make([]skillsapp.Endpoint, 0, len(vres))
				for _, ep := range vres {
					veps = append(veps, skillsapp.Endpoint{ProviderID: ep.ProviderID, BaseURL: ep.BaseURL, APIKey: ep.APIKey})
				}
				tools = append(tools, skillsapp.BuildAnalyzeImageTool(canvas, rt.llm, veps, vm))
			}
		}
	}
	conversation, err := rt.ensureAgentConversation(r.Context(), userID, agent, req.ConversationID)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load conversation"})
		return
	}
	// Announce the resolved conversation id so the client can switch to it
	// when the server transparently created a new thread.
	emitter.Emit("conversation", map[string]string{"id": formatUUID(conversation.ID)})

	// 最近 12 轮(一轮 user/tool_log/assistant 3 行)。查询自身取的是时间尾部,
	// 长会话时 LLM 看到的是最新上下文而非最早几轮。
	historyMessages, err := rt.q.ListAgentConversationMessages(r.Context(), sqlc.ListAgentConversationMessagesParams{
		ConversationID: conversation.ID,
		Limit:          36,
	})
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load conversation messages"})
		return
	}
	boundSkills := skillsapp.LoadBoundSkills(r.Context(), rt.q, agent.SkillIDs)
	tools = append(tools, skillsapp.BuildSkillToolsFromRows(rt.executor, boundSkills)...)
	tools = append(tools, skillsapp.BuildDeepRetrieveTool(rt.q, userID, agent.ID, req.ProjectID, req.WorkspaceID))
	tools = append(tools, skillsapp.BuildSaveMemoryTool(rt.q, userID, agent.ID, req.ProjectID, req.WorkspaceID))
	tools = append(tools, skillsapp.BuildCreatorSuiteSubAgentTools(rt.q, rt.executor, agent)...)
	tools = append(tools, skillsapp.BuildAskUserTool(emitter.Emit))
	resolvedMessage, invokedSkill := skillsapp.ResolveSlashSkillMessage(req.Message, boundSkills)
	if invokedSkill != "" {
		emitter.Emit("thought", map[string]string{
			"content": "Resolved slash skill " + invokedSkill + " before starting the agent loop.",
		})
	}

	// 6) Persist a pending agent_runs row before kicking the loop.
	runRow, _ := rt.q.InsertAgentRun(r.Context(), sqlc.InsertAgentRunParams{
		UserID: userID, AgentID: agent.ID, ConversationID: conversation.ID, UserInput: req.Message,
	})

	runner := skillsapp.Runner{LLM: rt.llm, Endpoints: endpoints, Health: rt.catalogSvc}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Inject a complete canvas snapshot into the system prompt so the agent
	// already knows every node up-front and won't遍历-read each node via read_node.
	// This is re-built per run, so every new conversation / turn sees the latest
	// canvas state.
	systemPrompt := agent.SystemPrompt
	if overview := skillsapp.BuildCanvasOverview(req.Nodes, req.Edges, req.Groups); overview != "" {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n（以下是本次对话最新的画布状态）\n" + overview)
	}
	// Interaction guide: analyse intent first; for ambiguous requests offer a
	// multiple-choice question via ask_user instead of guessing.
	systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + skillsapp.AgentInteractionGuide)
	// 真实执行军规:画布只认工具调用,防"模拟执行"式幻觉(声称已创建实际没动)。
	if agent.CanvasTools {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" +
			"【真实执行】画布的一切变化(创建节点/连线/写入内容/触发生成)只能通过工具调用完成。" +
			"严禁在未调用工具的情况下声称『已创建/已连线/已写入/已完成』——那是伪造,系统会校验并打回。" +
			"要把内容写入画布时,调 create_node 并把完整内容放进 data.content;先执行,后汇报。")
	}
	// Memory nudge(hermes 式):提醒模型主动读写跨会话持久记忆。
	systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + skillsapp.AgentMemoryGuide)
	// 技能方法论指引:绑定的文档型技能是"领域方法论库"(剧本转分镜、
	// 提示词模板等)。命中场景先取方法论再动手,而不是凭通用能力自由发挥。
	if len(boundSkills) > 0 {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" +
			"【技能方法论】你绑定的技能工具中,凡描述为方法论/模板/工作流的(如剧本转分镜、视频提示词模板、台词表情改写)," +
			"在遇到匹配场景时必须先调用对应技能工具取回完整方法论,然后严格按方法论执行任务;不要跳过方法论凭记忆自由发挥。" +
			"一次任务只取用最相关的技能,取回后不必复述文档本身。" +
			"方法论文档里的自检报告/开场仪式在内部完成,严禁打印给用户;" +
			"文档要求向用户提问或选择时,一律经 ask_user 工具给出 options 选项,不在回复正文里罗列选项。")
	}
	// 可用生成模型清单:agent 可以创建图片/视频节点并经 run_node(model=...)
	// 指定模型触发生成 —— 大语言模型编排其它生成模型的关键上下文。
	if len(req.GenerationModels) > 0 {
		var b strings.Builder
		b.WriteString("【可用生成模型】\n你可以用 create_node + set_prompt + run_node 编排图片/视频生成;run_node 可带 model 参数指定模型:\n")
		for _, kind := range []string{"image", "video", "audio"} {
			if models := req.GenerationModels[kind]; len(models) > 0 {
				fmt.Fprintf(&b, "- %s: %s\n", kind, strings.Join(models, ", "))
			}
		}
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + strings.TrimSpace(b.String()))
	}
	// 跨轮工具历史(P3):把之前轮次的紧凑工具记录注入 system prompt,让本轮
	// "记得"已执行过什么。tool_log 行不进 messages(sanitize 会滤掉),无配对风险。
	var toolLogs []string
	for _, m := range historyMessages {
		if m.Role == "tool_log" && strings.TrimSpace(m.Content) != "" {
			toolLogs = append(toolLogs, m.Content)
		}
	}
	if hist := skillsapp.BuildToolHistoryPrompt(toolLogs, 2); hist != "" {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + hist)
	}

	startedAt := time.Now()
	stats, runErr := runner.Run(ctx, skillsapp.RunInput{
		SystemPrompt: systemPrompt,
		Model:        catalogModel,
		UserMessage:  resolvedMessage,
		History:      toRunHistoryFromMessages(historyMessages),
		Tools:        tools,
		Strategy:     agent.Strategy,
		Thinking:     req.Thinking,
	}, emitter.Emit)
	durationMs := int32(time.Since(startedAt).Milliseconds())

	// 7) Update agent_runs row with the final outcome (best-effort).
	status := "success"
	errMsg := ""
	if runErr != nil {
		status = "error"
		errMsg = runErr.Error()
	}
	_ = rt.q.UpdateAgentRunResult(r.Context(), sqlc.UpdateAgentRunResultParams{
		ID:         runRow.ID,
		FinalReply: stats.FinalReply,
		ToolCalls:  int32(stats.ToolCalls),
		Steps:      int32(stats.Steps),
		Status:     status,
		ErrorMsg:   errMsg,
		DurationMs: durationMs,
	})
	if runErr == nil && req.Message != "" && stats.FinalReply != "" {
		_, _ = rt.q.InsertAgentConversationMessage(r.Context(), sqlc.InsertAgentConversationMessageParams{
			ConversationID: conversation.ID,
			Role:           "user",
			Content:        req.Message,
		})
		// 紧凑工具记录(P3):持久化本轮工具执行摘要,供下一轮注入 system prompt。
		// 放在 user 之后、assistant 之前,保持时间序。前端历史读 agent_runs,不受影响。
		if transcript := skillsapp.FormatToolTranscript(stats.ToolTranscript); transcript != "" {
			_, _ = rt.q.InsertAgentConversationMessage(r.Context(), sqlc.InsertAgentConversationMessageParams{
				ConversationID: conversation.ID,
				Role:           "tool_log",
				Content:        transcript,
			})
		}
		_, _ = rt.q.InsertAgentConversationMessage(r.Context(), sqlc.InsertAgentConversationMessageParams{
			ConversationID: conversation.ID,
			Role:           "assistant",
			Content:        stats.FinalReply,
		})
		// 自动轮次记忆:把本轮 user/assistant 写入 agent_memories(会话消息只在
		// 本会话内可见,记忆才是 deep_retrieve 跨会话召回的来源)。best-effort。
		skillsapp.PersistTurnMemory(r.Context(), rt.q, userID, agent.ID, req.ProjectID, req.WorkspaceID,
			formatUUID(conversation.ID), req.Message, stats.FinalReply)
		// Auto-fill the title from the first user turn so the switcher has
		// something more meaningful than "新对话". Keep existing titles intact.
		nextTitle := conversation.Title
		if nextTitle == "" || nextTitle == agent.Name {
			nextTitle = truncateForTitle(req.Message)
		}
		_, _ = rt.q.TouchAgentConversation(r.Context(), sqlc.TouchAgentConversationParams{
			ID:    conversation.ID,
			Title: nextTitle,
		})
	}
}

func (rt *AgentRunRouter) resolveAgentRoute(ctx context.Context, agent sqlc.Agent) skillsapp.AgentRouteConfig {
	exact := skillsapp.AgentRouteConfigFromRow(agent)
	if agent.ParentDeployKey == "" {
		return exact
	}
	mode := skillsapp.AgentUseModeSimple
	if setting, err := rt.q.GetAgentSetting(ctx, skillsapp.AgentUseModeSettingKey); err == nil {
		var payload struct {
			Mode int32 `json:"mode"`
		}
		if err := json.Unmarshal(setting.Value, &payload); err == nil && payload.Mode == skillsapp.AgentUseModeAdvanced {
			mode = skillsapp.AgentUseModeAdvanced
		}
	}
	parentRoute := skillsapp.AgentRouteConfig{}
	if parent, err := rt.q.GetAgentByDeployKey(ctx, agent.ParentDeployKey); err == nil {
		parentRoute = skillsapp.AgentRouteConfigFromRow(parent)
	}
	return skillsapp.ResolveCreatorSuiteRoute(mode, exact, parentRoute)
}

// truncateForTitle keeps the auto-derived conversation title short so the
// switcher UI doesn't blow out the dropdown width.
func truncateForTitle(s string) string {
	const limit = 30
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit]) + "…"
}

func toRunHistoryFromMessages(messages []sqlc.AgentConversationMessage) []skillsapp.ChatMessage {
	if len(messages) == 0 {
		return nil
	}

	history := make([]skillsapp.ChatMessage, 0, len(messages))
	for _, message := range messages {
		history = append(history, skillsapp.ChatMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}
	return history
}

// ensureAgentConversation resolves which thread this run belongs to. Priority:
//  1. explicit conversation_id from the request body (user picked one)
//  2. the most recently updated thread for (user, agent)
//  3. brand-new thread (first ever run)
func (rt *AgentRunRouter) ensureAgentConversation(ctx context.Context, userID pgtype.UUID, agent sqlc.Agent, conversationID string) (sqlc.AgentConversation, error) {
	if conversationID != "" {
		cid, err := parseUUID(conversationID)
		if err != nil {
			return sqlc.AgentConversation{}, err
		}
		return rt.q.GetAgentConversationByID(ctx, sqlc.GetAgentConversationByIDParams{
			ID:      cid,
			UserID:  userID,
			AgentID: agent.ID,
		})
	}

	conversation, err := rt.q.GetAgentConversationByUserAndAgent(ctx, sqlc.GetAgentConversationByUserAndAgentParams{
		UserID:  userID,
		AgentID: agent.ID,
	})
	if err == nil {
		return conversation, nil
	}
	if err != pgx.ErrNoRows {
		return sqlc.AgentConversation{}, err
	}
	return rt.q.InsertAgentConversation(ctx, sqlc.InsertAgentConversationParams{
		UserID:  userID,
		AgentID: agent.ID,
		Title:   "",
	})
}
