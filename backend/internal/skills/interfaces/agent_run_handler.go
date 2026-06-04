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
	// Current canvas snapshot for the agent to reason about.
	Nodes []skillsapp.CanvasNode `json:"nodes"`
	Edges []skillsapp.CanvasEdge `json:"edges"`
	// Recent conversation context for the selected agent.
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

	// 3) Resolve upstream LLM endpoint for the agent's model.
	baseURL, apiKey, err := rt.catalogSvc.ResolveModelEndpoint(r.Context(), agent.Model)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
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
	conversation, err := rt.ensureAgentConversation(r.Context(), userID, agent)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load conversation"})
		return
	}
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

	runner := skillsapp.Runner{LLM: rt.llm, BaseURL: baseURL, APIKey: apiKey}
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
		_, _ = rt.q.TouchAgentConversation(r.Context(), sqlc.TouchAgentConversationParams{
			ID:    conversation.ID,
			Title: conversation.Title,
		})
	}
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

func (rt *AgentRunRouter) ensureAgentConversation(ctx context.Context, userID pgtype.UUID, agent sqlc.Agent) (sqlc.AgentConversation, error) {
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
		Title:   agent.Name,
	})
}
