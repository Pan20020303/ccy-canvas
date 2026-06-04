// Agent-run SSE handler. Lives outside the huma router because huma can't
// model Server-Sent Events (it always wraps in an envelope). We expose a
// plain chi route at /api/app/agents/{id}/run that authenticates via the
// session cookie just like uploads do.

package interfaces

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
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
	catalogSvc *modelapp.Service
	sessions   session.Manager
}

func NewAgentRunRouter(q *sqlc.Queries, catalog *modelapp.Service, sessions session.Manager) *AgentRunRouter {
	return &AgentRunRouter{
		q:          q,
		llm:        skillsapp.NewLLMClient(),
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
}

func (rt *AgentRunRouter) runAgent(w http.ResponseWriter, r *http.Request) {
	// 1) Cookie auth (same pattern as upload handler).
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	if _, err := rt.sessions.Parse(cookie.Value); err != nil {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}

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
	// TODO: append skill-bound tools here once Skill -> Tool adapter is wired.

	// 6) Run the loop.
	runner := skillsapp.Runner{
		LLM:     rt.llm,
		BaseURL: baseURL,
		APIKey:  apiKey,
	}

	// Pass through cancellation if the client disconnects.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		<-ctx.Done()
	}()

	_ = runner.Run(ctx, skillsapp.RunInput{
		SystemPrompt: agent.SystemPrompt,
		Model:        agent.Model,
		UserMessage:  req.Message,
		Tools:        tools,
	}, emitter.Emit)
}
