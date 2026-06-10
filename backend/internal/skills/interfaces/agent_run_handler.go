// Agent-run SSE handler. Lives outside the huma router because huma can't
// model Server-Sent Events (it always wraps in an envelope). We expose a
// plain chi route at /api/app/agents/{id}/run that authenticates via the
// session cookie just like uploads do.

package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	skillsapp "ccy-canvas/backend/internal/skills/application"
	"ccy-canvas/backend/internal/shared/httpx"
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
	// Recent conversation context for the selected agent. Kept for backward
	// compat with the old API shape; server-side history is the source of
	// truth now and overrides this if non-empty.
	History []agentRunHistoryTurn `json:"history"`
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

	var req agentRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
		return
	}

	// 3) Resolve every upstream provider that can serve the agent's model.
	// When more than one vendor declares the same model, ChatStreamMulti will
	// fall back across them on transient errors.
	resolved, err := rt.catalogSvc.ResolveModelEndpoints(r.Context(), agent.Model)
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
	}
	conversation, err := rt.ensureAgentConversation(r.Context(), userID, agent, req.ConversationID)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load conversation"})
		return
	}
	// Announce the resolved conversation id so the client can switch to it
	// when the server transparently created a new thread.
	emitter.Emit("conversation", map[string]string{"id": formatUUID(conversation.ID)})

	historyMessages, err := rt.q.ListAgentConversationMessages(r.Context(), sqlc.ListAgentConversationMessagesParams{
		ConversationID: conversation.ID,
		Limit:          24,
	})
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load conversation messages"})
		return
	}
	boundSkills := skillsapp.LoadBoundSkills(r.Context(), rt.q, agent.SkillIDs)
	tools = append(tools, skillsapp.BuildSkillToolsFromRows(rt.executor, boundSkills)...)
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

	startedAt := time.Now()
	stats, runErr := runner.Run(ctx, skillsapp.RunInput{
		SystemPrompt: agent.SystemPrompt,
		Model:        agent.Model,
		UserMessage:  resolvedMessage,
		History:      toRunHistoryFromMessages(historyMessages),
		Tools:        tools,
		Strategy:     agent.Strategy,
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
		_, _ = rt.q.InsertAgentConversationMessage(r.Context(), sqlc.InsertAgentConversationMessageParams{
			ConversationID: conversation.ID,
			Role:           "assistant",
			Content:        stats.FinalReply,
		})
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
//   1. explicit conversation_id from the request body (user picked one)
//   2. the most recently updated thread for (user, agent)
//   3. brand-new thread (first ever run)
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
