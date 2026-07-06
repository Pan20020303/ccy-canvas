package interfaces

import (
	"net/http"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
)

// collabUser is the minimal public shape returned by the invite lookup —
// enough to render an invited member (id + display name), no sensitive fields.
type collabUser struct {
	UID  string `json:"uid"`
	Name string `json:"name"`
}

// RegisterCollabRoutes wires collaboration-support endpoints. For now: resolve
// a username / email to a real user so invites can be sent by name instead of
// raw UID. Authenticated (any signed-in user); returns only id + name.
func RegisterCollabRoutes(r chi.Router, sm session.Manager, q *sqlc.Queries) {
	r.Get("/api/app/users/lookup", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := historyUserID(w, r, sm); !ok {
			return
		}
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" {
			httpx.WriteJSON(w, r, http.StatusOK, []collabUser{})
			return
		}
		rows, err := q.LookupUsersByNameOrEmail(r.Context(), query, 5)
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Lookup failed"})
			return
		}
		out := make([]collabUser, 0, len(rows))
		for _, row := range rows {
			out = append(out, collabUser{UID: formatCollabUUID(row.ID.Bytes), Name: row.Name})
		}
		httpx.WriteJSON(w, r, http.StatusOK, out)
	})
}

func formatCollabUUID(b [16]byte) string {
	const hex = "0123456789abcdef"
	buf := make([]byte, 36)
	pos := 0
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[pos] = '-'
			pos++
		}
		buf[pos] = hex[v>>4]
		buf[pos+1] = hex[v&0x0f]
		pos += 2
	}
	return string(buf)
}
