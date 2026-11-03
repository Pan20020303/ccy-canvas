package interfaces

import (
	"encoding/json"
	"net/http"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
)

// savedAsset is the wire shape shared by POST (input) and GET (output). It
// mirrors the frontend SavedAsset (camelCase) so the store can round-trip it
// without translation.
type savedAsset struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Category  string `json:"category"`
	Kind      string `json:"kind"`
	Thumbnail string `json:"thumbnail"`
	URL       string `json:"url"`
	Text      string `json:"text"`
	FolderID  string `json:"folderId"`
	CreatedAt int64  `json:"createdAt"`
}

type deleteAssetsInput struct {
	IDs []string `json:"ids"`
}

// assetFolder is the wire shape for素材库文件夹, mirroring the frontend
// AssetFolder (camelCase) so the store round-trips it without translation.
type assetFolder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
}

type deleteAssetFolderInput struct {
	ID string `json:"id"`
}

const maxAssetListLimit = 500

// RegisterAssetRoutes wires the user-scoped asset-library persistence endpoints.
// The library ("素材库 / 我的素材 / 我的主体库") was previously localStorage-only;
// these let it survive a cache wipe and follow the user across devices. Reads are
// scoped to the authenticated user. Mirrors RegisterHistoryRoutes 1:1.
func RegisterAssetRoutes(r chi.Router, sm session.Manager, q *sqlc.Queries) {
	r.Post("/api/app/assets", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in savedAsset
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid asset"})
			return
		}
		if in.ID == "" {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Missing asset id"})
			return
		}
		if in.Category == "" {
			in.Category = "other"
		}
		if in.Kind == "" {
			in.Kind = "image"
		}
		if err := q.UpsertSavedAsset(r.Context(), sqlc.UpsertSavedAssetParams{
			UserID:      uid,
			ClientID:    in.ID,
			Name:        in.Name,
			Category:    in.Category,
			Kind:        in.Kind,
			Thumbnail:   in.Thumbnail,
			URL:         in.URL,
			TextContent: in.Text,
			FolderID:    in.FolderID,
			ClientTs:    in.CreatedAt,
		}); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save asset"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})

	r.Get("/api/app/assets", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		rows, err := q.ListSavedAssets(r.Context(), sqlc.ListSavedAssetsParams{
			UserID:   uid,
			Category: r.URL.Query().Get("category"),
			Limit:    maxAssetListLimit,
		})
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load assets"})
			return
		}
		items := make([]savedAsset, 0, len(rows))
		for _, row := range rows {
			items = append(items, savedAsset{
				ID:        row.ClientID,
				Name:      row.Name,
				Category:  row.Category,
				Kind:      row.Kind,
				Thumbnail: row.Thumbnail,
				URL:       row.URL,
				Text:      row.TextContent,
				FolderID:  row.FolderID,
				CreatedAt: row.ClientTs,
			})
		}
		httpx.WriteJSON(w, r, http.StatusOK, items)
	})

	r.Delete("/api/app/assets", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in deleteAssetsInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid request"})
			return
		}
		if len(in.IDs) == 0 {
			httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		if err := q.DeleteSavedAssets(r.Context(), uid, in.IDs); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to delete assets"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})

	// ─── 素材库文件夹 ────────────────────────────────────────────────────

	r.Get("/api/app/asset-folders", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		rows, err := q.ListAssetFolders(r.Context(), uid)
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to load folders"})
			return
		}
		items := make([]assetFolder, 0, len(rows))
		for _, row := range rows {
			items = append(items, assetFolder{ID: row.ClientID, Name: row.Name, CreatedAt: row.ClientTs})
		}
		httpx.WriteJSON(w, r, http.StatusOK, items)
	})

	// POST creates a new folder or renames an existing one (idempotent by id).
	r.Post("/api/app/asset-folders", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in assetFolder
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.ID == "" {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid folder"})
			return
		}
		if err := q.UpsertAssetFolder(r.Context(), sqlc.UpsertAssetFolderParams{
			UserID:   uid,
			ClientID: in.ID,
			Name:     in.Name,
			ClientTs: in.CreatedAt,
		}); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save folder"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})

	// DELETE removes a folder and re-parents its assets to the root.
	r.Delete("/api/app/asset-folders", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := historyUserID(w, r, sm)
		if !ok {
			return
		}
		var in deleteAssetFolderInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.ID == "" {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid request"})
			return
		}
		if err := q.DeleteAssetFolder(r.Context(), uid, in.ID); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to delete folder"})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
	})
}
