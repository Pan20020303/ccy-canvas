// Live-collaboration presence: a project-scoped SSE stream (downstream) plus a
// throttled POST endpoint (upstream). Both live on chi (not huma) so the SSE
// frames stay raw and the JSON stays un-enveloped. Auth reuses the ccy_session
// cookie; a project AccessRole check gates the room so only members/owner can
// join. Nothing here is persisted — presence is purely ephemeral.

package interfaces

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/presence"
	"ccy-canvas/backend/internal/shared/httpx"
)

// accessChecker is satisfied by *workspace/infrastructure.Repository.
type accessChecker interface {
	AccessRole(ctx context.Context, projectID, userID string) (string, error)
}

// RegisterPresenceRoutes attaches the presence stream + report endpoints.
func RegisterPresenceRoutes(r chi.Router, sm session.Manager, bus *presence.Bus, access accessChecker) {
	r.Get("/api/app/projects/{id}/presence/stream", presenceStreamHandler(sm, bus, access))
	r.Post("/api/app/projects/{id}/presence", presenceReportHandler(sm, bus, access))
}

// authProject resolves (userID, role) for the request or writes an error and
// returns ok=false. role == "" means no access to this project.
func authProject(sm session.Manager, access accessChecker, w http.ResponseWriter, r *http.Request) (userID, role, projectID string, ok bool) {
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return "", "", "", false
	}
	claims, err := sm.Parse(cookie.Value)
	if err != nil || claims.UserID == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return "", "", "", false
	}
	projectID = chi.URLParam(r, "id")
	role, err = access.AccessRole(r.Context(), projectID, claims.UserID)
	if err != nil || role == "" {
		httpx.WriteJSON(w, r, http.StatusForbidden, map[string]string{"error": "No access to this project"})
		return "", "", "", false
	}
	return claims.UserID, role, projectID, true
}

func presenceStreamHandler(sm session.Manager, bus *presence.Bus, access accessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, _, projectID, ok := authProject(sm, access, w, r)
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

		sub, snapshot, unsubscribe := bus.Subscribe(projectID, uid)
		defer unsubscribe()

		fmt.Fprintf(w, ": connected\n\n")
		flusher.Flush()

		// Replay who is already present so the newcomer sees them immediately.
		for _, ev := range snapshot {
			if payload, err := json.Marshal(ev); err == nil {
				fmt.Fprintf(w, "data: %s\n\n", payload)
			}
		}
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

type presenceReport struct {
	Name      string             `json:"name"`
	Color     string             `json:"color"`
	Cursor    *presence.Cursor   `json:"cursor"`
	Selection []string           `json:"selection"`
	Activity  *presence.Activity `json:"activity"`
}

func presenceReportHandler(sm session.Manager, bus *presence.Bus, access accessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, role, projectID, ok := authProject(sm, access, w, r)
		if !ok {
			return
		}
		// Visitors are read-only: they may watch (subscribe) but never broadcast
		// their own cursor, so they stay invisible to others.
		if role == "visitor" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
		var body presenceReport
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		// Cap selection/activity node lists so a malformed client can't flood.
		if len(body.Selection) > 500 {
			body.Selection = body.Selection[:500]
		}
		if body.Activity != nil && len(body.Activity.NodeIDs) > 500 {
			body.Activity.NodeIDs = body.Activity.NodeIDs[:500]
		}

		bus.Publish(projectID, presence.PresenceEvent{
			Type:      "presence",
			UID:       uid,
			Name:      body.Name,
			Color:     body.Color,
			Cursor:    body.Cursor,
			Selection: body.Selection,
			Activity:  body.Activity,
			TS:        time.Now().UnixMilli(),
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
