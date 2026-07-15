// Task-completion SSE handler. Lives outside the huma router because
// huma envelopes every response in JSON, which would break SSE. The
// endpoint streams TaskEvent JSON to each connected client, scoped to
// the user identified by the session cookie.
//
// Wire-format: standard `data: <json>\n\n` SSE lines, plus a `: ping\n\n`
// keep-alive every 25 s so proxies that close idle connections don't
// kill the stream silently.

package interfaces

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
)

type TaskStreamRouter struct {
	bus      *modelapp.TaskEventBus
	sessions session.Manager
}

func NewTaskStreamRouter(bus *modelapp.TaskEventBus, sessions session.Manager) *TaskStreamRouter {
	return &TaskStreamRouter{bus: bus, sessions: sessions}
}

// RegisterChi attaches GET /api/app/tasks/stream to the supplied router.
// Path lives directly on chi (not huma) so we can write raw SSE frames.
func (rt *TaskStreamRouter) RegisterChi(r chi.Router) {
	r.Get("/api/app/tasks/stream", rt.handleStream)
}

func (rt *TaskStreamRouter) handleStream(w http.ResponseWriter, r *http.Request) {
	// Cookie auth — same pattern as upload + agent-run handlers.
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	claims, err := rt.sessions.Parse(cookie.Value)
	if err != nil || claims.UserID == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}

	// SSE headers. X-Accel-Buffering disables nginx-side buffering so
	// events arrive in real time rather than in chunks.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return // very old ResponseWriter shouldn't happen with chi
	}

	sub, unsubscribe := rt.bus.Subscribe(claims.UserID)
	defer unsubscribe()

	// Initial "ready" sentinel so the client knows the channel is alive
	// even before any task completes. Frontend can use this to flip
	// its `sseOnline` flag.
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-pingTicker.C:
			// Comment frame keeps the connection warm without confusing
			// the client's event parser (only `data:` lines are events).
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, open := <-sub.Events():
			if !open {
				return // bus closed our channel during unsubscribe race
			}
			payload, err := json.Marshal(event)
			if err != nil {
				continue
			}
			// One frame: `data: {json}\n\n` is the minimal SSE event.
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// Ensure context import isn't flagged unused when the file evolves.
var _ = context.Background
