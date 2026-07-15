// Real-time canvas sync: a project-scoped SSE stream (downstream) + a POST
// endpoint (upstream) that broadcast OPAQUE canvas-edit deltas to the room, so
// collaborators see each other's node/edge/group edits live and their states
// converge (which also stops the full-snapshot autosave from clobbering peers).
// Chi-direct (raw SSE), ccy_session cookie auth, AccessRole gate — mirrors the
// presence handler. Nothing persisted; the existing snapshot save/load is the
// source of truth + resync path.

package interfaces

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"ccy-canvas/backend/internal/canvassync"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
)

// RegisterCanvasSyncRoutes attaches the canvas-op stream + report endpoints.
func RegisterCanvasSyncRoutes(r chi.Router, sm session.Manager, bus *canvassync.Bus, access accessChecker) {
	r.Get("/api/app/projects/{id}/canvas/stream", canvasStreamHandler(sm, bus, access))
	r.Post("/api/app/projects/{id}/canvas/ops", canvasOpsHandler(sm, bus, access))
}

func canvasStreamHandler(sm session.Manager, bus *canvassync.Bus, access accessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, _, projectID, ok := authProject(sm, access, w, r)
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}

		sub, unsubscribe := bus.Subscribe(projectID)
		defer unsubscribe()

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
				if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case ev, open := <-sub.Events():
				if !open {
					return
				}
				payload, err := json.Marshal(ev)
				if err != nil {
					continue
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}

type canvasOpsBody struct {
	Ops json.RawMessage `json:"ops"`
}

func canvasOpsHandler(sm session.Manager, bus *canvassync.Bus, access accessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, role, projectID, ok := authProject(sm, access, w, r)
		if !ok {
			return
		}
		// Visitors are read-only: they may watch (subscribe) but never broadcast
		// their own edits — they can't edit the canvas anyway.
		if role == "visitor" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 4*1024*1024) // 4 MB cap per op batch
		var body canvasOpsBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		if len(body.Ops) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		bus.Publish(projectID, canvassync.CanvasEvent{
			UID: uid,
			Ops: body.Ops,
			TS:  time.Now().UnixMilli(),
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
