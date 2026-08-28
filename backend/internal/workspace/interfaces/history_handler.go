package interfaces

import (
	"encoding/json"
	"net/http"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// decodeHistoryBody decodes JSON leniently (unknown fields ignored) so a future
// frontend HistoryItem field can't silently 400 a best-effort save.
func decodeHistoryBody(r *http.Request, dst any) error {
	return json.NewDecoder(r.Body).Decode(dst)
}

// historyItem is the wire shape shared by POST (input) and GET (output). It
// mirrors the frontend HistoryItem (camelCase) so the store can round-trip it
// without translation.
type historyItem struct {
	ID               string `json:"id"`
	SpaceID          string `json:"spaceId"`
	SpaceType        string `json:"spaceType"`
	ProjectID        string `json:"projectId"`
	Type             string `json:"type"`
	MediaType        string `json:"mediaType"`
	Timestamp        int64  `json:"timestamp"`
	Title            string `json:"title"`
	Thumbnail        string `json:"thumbnail"`
	Content          string `json:"content"`
	AspectRatio      string `json:"aspectRatio"`
	PromptExcerpt    string `json:"promptExcerpt"`
	SourceNodeID     string `json:"sourceNodeId"`
	DerivationAction string `json:"derivationAction"`
}

type deleteHistoryInput struct {
	IDs []string `json:"ids"`
}

const maxHistoryListLimit = 200

// RegisterHistoryRoutes wires the user-scoped generation-history persistence
// endpoints. History was previously localStorage-only; these let it survive a
// cache wipe and follow the user across devices. Reads are scoped to the
// authenticated user (space_id is stored for future team-shared reads).
func RegisterHistoryRoutes(r chi.Router, sm session.Manager, q *sqlc.Queries) {
	r.Post("/api/app/history", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in historyItem
		if err := decodeHistoryBody(r, &in); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid history item"})
			return
		}
		if in.ID == "" {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Missing history id"})
			return
		}
		if in.MediaType == "" {
			in.MediaType = "image"
		}
		if err := q.UpsertGenerationHistory(r.Context(), sqlc.UpsertGenerationHistoryParams{
			UserID:           uid,
			ClientID:         in.ID,
			SpaceID:          in.SpaceID,
			SpaceType:        in.SpaceType,
			ProjectID:        in.ProjectID,
			ItemType:         in.Type,
			MediaType:        in.MediaType,
			Title:            in.Title,
			Thumbnail:        in.Thumbnail,
			Content:          in.Content,
			AspectRatio:      in.AspectRatio,
			PromptExcerpt:    in.PromptExcerpt,
			SourceNodeID:     in.SourceNodeID,
			DerivationAction: in.DerivationAction,
			ClientTs:         in.Timestamp,
		}); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save history"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})

	r.Get("/api/app/history", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		rows, err := q.ListGenerationHistory(r.Context(), sqlc.ListGenerationHistoryParams{
			UserID:    uid,
			SpaceID:   r.URL.Query().Get("spaceId"),
			ProjectID: r.URL.Query().Get("projectId"),
			MediaType: r.URL.Query().Get("type"),
			Limit:     maxHistoryListLimit,
		})
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load history"})
			return
		}
		items := make([]historyItem, 0, len(rows))
		for _, row := range rows {
			items = append(items, historyItem{
				ID:               row.ClientID,
				SpaceID:          row.SpaceID,
				SpaceType:        row.SpaceType,
				ProjectID:        row.ProjectID,
				Type:             row.ItemType,
				MediaType:        row.MediaType,
				Timestamp:        row.ClientTs,
				Title:            row.Title,
				Thumbnail:        row.Thumbnail,
				Content:          row.Content,
				AspectRatio:      row.AspectRatio,
				PromptExcerpt:    row.PromptExcerpt,
				SourceNodeID:     row.SourceNodeID,
				DerivationAction: row.DerivationAction,
			})
		}
		httpx.WriteJSON(w, r, http.StatusOK, items)
	})

	r.Delete("/api/app/history", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in deleteHistoryInput
		if err := decodeHistoryBody(r, &in); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid request"})
			return
		}
		if len(in.IDs) == 0 {
			httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		if err := q.DeleteGenerationHistory(r.Context(), uid, in.IDs); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to delete history"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})
}

// historyUserID authenticates via the session cookie and returns the caller's
// user id as a pgtype.UUID. It writes a 401 and returns ok=false on failure.
func historyUserID(w http.ResponseWriter, r *http.Request, sm session.Manager) (pgtype.UUID, bool) {
	var uid pgtype.UUID
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return uid, false
	}
	claims, err := sm.Parse(cookie.Value)
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return uid, false
	}
	if err := uid.Scan(claims.UserID); err != nil || !uid.Valid {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session user"})
		return uid, false
	}
	return uid, true
}
