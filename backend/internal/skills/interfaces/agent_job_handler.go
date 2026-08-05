package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// createAgentJob persists the complete request before it acknowledges the
// command. Execution belongs to Redis/Asynq when configured; the in-process
// fallback still uses context.Background so closing the browser cannot cancel
// the run, but production should keep Redis enabled for restart durability.
func (rt *AgentRunRouter) createAgentJob(w http.ResponseWriter, r *http.Request) {
	userID, ok := rt.authenticatedAgentUser(w, r)
	if !ok {
		return
	}

	agentID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "智能体 ID 格式不正确"))
		return
	}
	agent, err := rt.q.GetAgent(r.Context(), agentID)
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeNotFound, "智能体不存在"))
		return
	}
	if !agentAccessibleBy(agent, userID) {
		httpx.WriteError(w, r, apperror.New(apperror.CodeForbidden, "你没有权限运行此智能体"))
		return
	}

	var req agentRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "请求内容格式不正确"))
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "请输入要执行的内容"))
		return
	}

	conversation, err := rt.ensureAgentConversation(r.Context(), userID, agent, req.ConversationID)
	if err != nil {
		httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInternal, "无法加载智能体会话", err))
		return
	}
	req.ConversationID = formatUUID(conversation.ID)
	payload, err := json.Marshal(req)
	if err != nil {
		httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInvalidInput, "无法保存任务内容", err))
		return
	}
	job, err := rt.q.InsertAgentRunJob(r.Context(), sqlc.InsertAgentRunJobParams{
		UserID:         userID,
		AgentID:        agent.ID,
		ConversationID: conversation.ID,
		UserInput:      req.Message,
		RequestPayload: payload,
	})
	if err != nil {
		httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInternal, "无法创建智能体任务", err))
		return
	}
	runID := formatUUID(job.ID)

	if rt.taskQueue != nil && rt.taskQueue.Enabled() {
		if _, err := rt.taskQueue.EnqueueAgentRun(r.Context(), runID); err != nil {
			_ = rt.finishAgentJob(job.ID, skillsapp.RunStats{}, time.Now(), err,
				map[string]string{"message": "任务队列暂不可用，请稍后重试"})
			httpx.WriteError(w, r, apperror.WithRetryable(
				apperror.Wrap(apperror.CodeUpstreamUnavailable, "任务队列暂不可用，请稍后重试", err), true,
			))
			return
		}
	} else {
		go func() {
			_ = rt.ProcessAgentRun(context.Background(), runID)
		}()
	}

	httpx.WriteJSON(w, r, http.StatusAccepted, map[string]string{
		"job_id":          runID,
		"conversation_id": formatUUID(conversation.ID),
		"status":          "queued",
	})
}

func (rt *AgentRunRouter) authenticatedAgentUser(w http.ResponseWriter, r *http.Request) (pgtype.UUID, bool) {
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteError(w, r, apperror.New(apperror.CodeUnauthenticated, "请先登录"))
		return pgtype.UUID{}, false
	}
	claims, err := rt.sessions.Parse(cookie.Value)
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeUnauthenticated, "登录状态已失效，请重新登录"))
		return pgtype.UUID{}, false
	}
	var userID pgtype.UUID
	if err := userID.Scan(claims.UserID); err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeUnauthenticated, "登录状态已失效，请重新登录"))
		return pgtype.UUID{}, false
	}
	user, err := rt.q.GetUserByID(r.Context(), userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteError(w, r, apperror.New(apperror.CodeUnauthenticated, "账号不存在或已被移除"))
		} else {
			httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInternal, "无法验证当前账号状态", err))
		}
		return pgtype.UUID{}, false
	}
	if user.Status != "active" {
		httpx.WriteError(w, r, apperror.New(apperror.CodeUnauthenticated, "账号已停用"))
		return pgtype.UUID{}, false
	}
	return userID, true
}

func (rt *AgentRunRouter) getAgentJob(w http.ResponseWriter, r *http.Request) {
	userID, ok := rt.authenticatedAgentUser(w, r)
	if !ok {
		return
	}
	runID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "任务 ID 格式不正确"))
		return
	}
	job, err := rt.q.GetOwnedAgentRunJob(r.Context(), runID, userID)
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeNotFound, "智能体任务不存在"))
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"job_id":          formatUUID(job.ID),
		"conversation_id": formatUUID(job.ConversationID),
		"status":          job.Status,
		"final_reply":     job.FinalReply,
		"error_message":   job.ErrorMsg,
		"steps":           job.Steps,
	})
}

// streamAgentJobEvents replays persisted frames and then tails the event log.
// A reconnect may pass ?after=<event id> or Last-Event-ID. The worker is not
// attached to this request context, so disconnecting only stops observation.
func (rt *AgentRunRouter) streamAgentJobEvents(w http.ResponseWriter, r *http.Request) {
	userID, ok := rt.authenticatedAgentUser(w, r)
	if !ok {
		return
	}
	runID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "任务 ID 格式不正确"))
		return
	}
	job, err := rt.q.GetOwnedAgentRunJob(r.Context(), runID, userID)
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeNotFound, "智能体任务不存在"))
		return
	}

	afterID := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("after")); value != "" {
		afterID, _ = strconv.ParseInt(value, 10, 64)
	} else if value := strings.TrimSpace(r.Header.Get("Last-Event-ID")); value != "" {
		afterID, _ = strconv.ParseInt(value, 10, 64)
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInternal, "当前服务不支持流式响应"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	poll := time.NewTicker(300 * time.Millisecond)
	keepalive := time.NewTicker(10 * time.Second)
	defer poll.Stop()
	defer keepalive.Stop()

	for {
		events, queryErr := rt.q.ListAgentRunEventsAfter(r.Context(), sqlc.ListAgentRunEventsAfterParams{
			RunID: runID, AfterID: afterID, Limit: 200,
		})
		if queryErr != nil {
			return
		}
		for _, event := range events {
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.EventType, event.Data)
			afterID = event.ID
		}
		if len(events) > 0 {
			flusher.Flush()
		}

		job, err = rt.q.GetOwnedAgentRunJob(r.Context(), runID, userID)
		if err != nil {
			return
		}
		if isTerminalAgentJobStatus(job.Status) && len(events) == 0 {
			return
		}

		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func isTerminalAgentJobStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "error", "cancelled":
		return true
	default:
		return false
	}
}

// ProcessAgentRun satisfies tasks.AgentRunProcessor. It may be called again
// when Redis recovers an interrupted lease; terminal rows are never replayed.
func (rt *AgentRunRouter) ProcessAgentRun(ctx context.Context, runID string) error {
	pgID, err := parseUUID(runID)
	if err != nil {
		return err
	}
	job, err := rt.q.GetAgentRunJob(ctx, pgID)
	if err != nil {
		return err
	}
	if isTerminalAgentJobStatus(job.Status) {
		return nil
	}
	if err := rt.q.MarkAgentRunRunning(ctx, job.ID); err != nil {
		return err
	}

	emit := func(event string, data any) { rt.persistAgentEvent(job.ID, event, data) }
	var req agentRunRequest
	if err := json.Unmarshal(job.RequestPayload, &req); err != nil {
		if finishErr := rt.finishAgentJob(job.ID, skillsapp.RunStats{}, time.Now(), err,
			map[string]string{"message": "任务数据损坏，无法继续执行"}); finishErr != nil {
			return finishErr
		}
		return nil
	}
	agent, err := rt.q.GetAgent(ctx, job.AgentID)
	if err != nil {
		if finishErr := rt.finishAgentJob(job.ID, skillsapp.RunStats{}, time.Now(), err,
			map[string]string{"message": "智能体已不存在或不可用"}); finishErr != nil {
			return finishErr
		}
		return nil
	}
	conversation, err := rt.q.GetAgentConversationByID(ctx, sqlc.GetAgentConversationByIDParams{
		ID: job.ConversationID, UserID: job.UserID, AgentID: job.AgentID,
	})
	if err != nil {
		if finishErr := rt.finishAgentJob(job.ID, skillsapp.RunStats{}, time.Now(), err,
			map[string]string{"message": "无法恢复智能体会话"}); finishErr != nil {
			return finishErr
		}
		return nil
	}
	return rt.executeDurableAgentJob(ctx, job, agent, conversation, req, emit)
}

func (rt *AgentRunRouter) executeDurableAgentJob(
	ctx context.Context,
	job sqlc.AgentRunJob,
	agent sqlc.Agent,
	conversation sqlc.AgentConversation,
	req agentRunRequest,
	emit func(string, any),
) error {
	startedAt := time.Now()
	emit("conversation", map[string]string{"id": formatUUID(conversation.ID)})

	route := rt.resolveAgentRoute(ctx, agent)
	catalogModel := skillsapp.ResolveCatalogModelName(route)
	if override := strings.TrimSpace(req.Model); override != "" {
		catalogModel = override
	}
	resolved, err := rt.catalogSvc.ResolveModelEndpoints(ctx, catalogModel)
	if err != nil {
		publicErr := apperror.New(apperror.CodeInvalidInput, "所选模型暂不可用，请更换后重试")
		if finishErr := rt.finishAgentJob(job.ID, skillsapp.RunStats{}, startedAt, publicErr,
			map[string]string{"message": apperror.PublicMessage(publicErr)}); finishErr != nil {
			return finishErr
		}
		return nil
	}
	endpoints := make([]skillsapp.Endpoint, 0, len(resolved))
	for _, endpoint := range resolved {
		endpoints = append(endpoints, skillsapp.Endpoint{
			ProviderID: endpoint.ProviderID, BaseURL: endpoint.BaseURL, APIKey: endpoint.APIKey,
		})
	}

	canvas := skillsapp.NewCanvasStateAtRevision(req.Nodes, req.Edges, req.CanvasRevision, emit)
	tools := []skillsapp.Tool{}
	if agent.CanvasTools {
		tools = append(tools, skillsapp.BuildCanvasTools(canvas)...)
		if visionModel := strings.TrimSpace(req.VisionModel); visionModel != "" {
			if visionResolved, visionErr := rt.catalogSvc.ResolveModelEndpoints(ctx, visionModel); visionErr == nil && len(visionResolved) > 0 {
				visionEndpoints := make([]skillsapp.Endpoint, 0, len(visionResolved))
				for _, endpoint := range visionResolved {
					visionEndpoints = append(visionEndpoints, skillsapp.Endpoint{
						ProviderID: endpoint.ProviderID, BaseURL: endpoint.BaseURL, APIKey: endpoint.APIKey,
					})
				}
				tools = append(tools, skillsapp.BuildAnalyzeImageTool(canvas, rt.llm, visionEndpoints, visionModel))
			}
		}
	}

	historyMessages, err := rt.q.ListAgentConversationMessages(ctx, sqlc.ListAgentConversationMessagesParams{
		ConversationID: conversation.ID, Limit: 36,
	})
	if err != nil {
		if finishErr := rt.finishAgentJob(job.ID, skillsapp.RunStats{}, startedAt, err,
			map[string]string{"message": "无法读取会话历史"}); finishErr != nil {
			return finishErr
		}
		return nil
	}
	boundSkills := skillsapp.LoadBoundSkills(ctx, rt.q, agent.SkillIDs)
	tools = append(tools, skillsapp.BuildSkillToolsFromRows(rt.executor, boundSkills)...)
	tools = append(tools, skillsapp.BuildDeepRetrieveTool(rt.q, job.UserID, agent.ID, req.ProjectID, req.WorkspaceID))
	tools = append(tools, skillsapp.BuildSaveMemoryTool(rt.q, job.UserID, agent.ID, req.ProjectID, req.WorkspaceID))
	tools = append(tools, skillsapp.BuildCreatorSuiteSubAgentTools(rt.q, rt.executor, agent)...)
	tools = append(tools, skillsapp.BuildAskUserTool(emit))
	resolvedMessage, invokedSkill := skillsapp.ResolveSlashSkillMessage(req.Message, boundSkills)
	if invokedSkill != "" {
		emit(skillsapp.EventThought, map[string]string{"content": "已加载技能：" + invokedSkill})
	}

	systemPrompt := agent.SystemPrompt
	if agent.CanvasTools {
		systemPrompt = strings.TrimSpace(systemPrompt + fmt.Sprintf("\n\n[Canvas revision: %d]", req.CanvasRevision))
	}
	if overview := skillsapp.BuildCanvasOverview(req.Nodes, req.Edges, req.Groups); overview != "" {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n【本次对话的最新画布状态】\n" + overview)
	}
	systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + skillsapp.AgentInteractionGuide)
	if agent.CanvasTools {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n【真实执行】所有画布变化必须通过工具调用完成。先执行，再汇报；不得在未调用工具时声称已经创建、连线或生成。")
	}
	systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + skillsapp.AgentMemoryGuide)
	if len(boundSkills) > 0 {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n【技能方法论】遇到匹配任务时先调用最相关的技能读取完整方法，再执行任务；一次只加载必要技能。")
	}
	if len(req.GenerationModels) > 0 {
		var models strings.Builder
		models.WriteString("【可用生成模型】\n可通过 create_node、set_prompt 和 run_node 编排生成：\n")
		for _, kind := range []string{"image", "video", "audio"} {
			if names := req.GenerationModels[kind]; len(names) > 0 {
				fmt.Fprintf(&models, "- %s: %s\n", kind, strings.Join(names, ", "))
			}
		}
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + strings.TrimSpace(models.String()))
	}
	var toolLogs []string
	for _, message := range historyMessages {
		if message.Role == "tool_log" && strings.TrimSpace(message.Content) != "" {
			toolLogs = append(toolLogs, message.Content)
		}
	}
	if historyPrompt := skillsapp.BuildToolHistoryPrompt(toolLogs, 2); historyPrompt != "" {
		systemPrompt = strings.TrimSpace(systemPrompt + "\n\n" + historyPrompt)
	}

	// Runner emits done/error before returning. Buffer only those terminal
	// frames so the database result and conversation are durable before the
	// browser is told the job has finished. Progress events still stream live.
	var terminalEvent string
	var terminalData any
	runEmit := func(event string, data any) {
		if event == skillsapp.EventDone || event == skillsapp.EventError {
			terminalEvent = event
			terminalData = data
			return
		}
		emit(event, data)
	}
	runner := skillsapp.Runner{LLM: rt.llm, Endpoints: endpoints, Health: rt.catalogSvc}
	stats, runErr := runner.Run(ctx, skillsapp.RunInput{
		SystemPrompt: systemPrompt,
		Model:        catalogModel,
		UserMessage:  resolvedMessage,
		History:      toRunHistoryFromMessages(historyMessages),
		Tools:        tools,
		Strategy:     agent.Strategy,
		Thinking:     req.Thinking,
	}, runEmit)
	if errors.Is(runErr, context.Canceled) {
		// A worker shutdown may cause Redis to recover the lease. Do not mark
		// the durable row terminal here; a restarted worker can resume it.
		return runErr
	}
	if runErr != nil {
		if terminalEvent == "" {
			terminalEvent = skillsapp.EventError
			terminalData = map[string]string{"message": apperror.PublicMessage(runErr)}
		}
		return rt.finishAgentJob(job.ID, stats, startedAt, runErr, terminalData)
	}

	persistCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if req.Message != "" && stats.FinalReply != "" {
		_, _ = rt.q.InsertAgentConversationMessage(persistCtx, sqlc.InsertAgentConversationMessageParams{
			ConversationID: conversation.ID, Role: "user", Content: req.Message,
		})
		if transcript := skillsapp.FormatToolTranscript(stats.ToolTranscript); transcript != "" {
			_, _ = rt.q.InsertAgentConversationMessage(persistCtx, sqlc.InsertAgentConversationMessageParams{
				ConversationID: conversation.ID, Role: "tool_log", Content: transcript,
			})
		}
		_, _ = rt.q.InsertAgentConversationMessage(persistCtx, sqlc.InsertAgentConversationMessageParams{
			ConversationID: conversation.ID, Role: "assistant", Content: stats.FinalReply,
		})
		skillsapp.PersistTurnMemory(persistCtx, rt.q, job.UserID, agent.ID, req.ProjectID, req.WorkspaceID,
			formatUUID(conversation.ID), req.Message, stats.FinalReply)
		nextTitle := conversation.Title
		if nextTitle == "" || nextTitle == agent.Name {
			nextTitle = truncateForTitle(req.Message)
		}
		_, _ = rt.q.TouchAgentConversation(persistCtx, sqlc.TouchAgentConversationParams{ID: conversation.ID, Title: nextTitle})
	}
	if terminalEvent == "" {
		terminalEvent = skillsapp.EventDone
		terminalData = map[string]int{"steps": stats.Steps}
	}
	return rt.finishAgentJob(job.ID, stats, startedAt, nil, terminalData)
}

func (rt *AgentRunRouter) persistAgentEvent(runID pgtype.UUID, event string, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = rt.q.InsertAgentRunEvent(ctx, sqlc.InsertAgentRunEventParams{
		RunID: runID, EventType: event, Data: raw,
	})
}

func (rt *AgentRunRouter) finishAgentJob(runID pgtype.UUID, stats skillsapp.RunStats, startedAt time.Time, runErr error, terminalData ...any) error {
	status := "success"
	errorMessage := ""
	eventType := skillsapp.EventDone
	eventData := any(map[string]int{"steps": stats.Steps})
	if runErr != nil {
		status = "error"
		errorMessage = apperror.PublicMessage(runErr)
		eventType = skillsapp.EventError
		eventData = map[string]string{"message": errorMessage}
	}
	if len(terminalData) > 0 && terminalData[0] != nil {
		eventData = terminalData[0]
	}
	rawEvent, err := json.Marshal(eventData)
	if err != nil {
		rawEvent = []byte(`{}`)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return rt.q.FinishAgentRunJob(ctx, sqlc.FinishAgentRunJobParams{
		ID: runID, FinalReply: stats.FinalReply, ToolCalls: int32(stats.ToolCalls),
		Steps: int32(stats.Steps), Status: status, ErrorMsg: errorMessage,
		DurationMs: int32(time.Since(startedAt).Milliseconds()),
		EventType:  eventType, EventData: rawEvent,
	})
}
