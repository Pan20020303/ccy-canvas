package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ccy-canvas/backend/internal/platform/authn"
)

// Film documents use their own revisions. Canvas saves cannot overwrite them.
type FilmHandler struct{ pool *pgxpool.Pool }

func NewFilmHandler(pool *pgxpool.Pool) *FilmHandler { return &FilmHandler{pool: pool} }

type filmRecord struct {
	ID         string          `json:"id"`
	Document   json.RawMessage `json:"document"`
	Revision   int             `json:"revision"`
	MutationID string          `json:"mutation_id"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}
type filmSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Excerpt   string    `json:"excerpt"`
	CoverURL  string    `json:"cover_url"`
	Step      int       `json:"step"`
	Completed bool      `json:"completed"`
	UpdatedAt time.Time `json:"updated_at"`
}
type filmOutput struct {
	Body struct {
		Data filmRecord `json:"data"`
	}
}
type filmsOutput struct {
	Body struct {
		Data []filmSummary `json:"data"`
	}
}
type filmCreateInput struct {
	Body struct {
		Document json.RawMessage `json:"document"`
	}
}
type filmGetInput struct {
	ID string `path:"id" format:"uuid"`
}
type filmSaveInput struct {
	ID   string `path:"id" format:"uuid"`
	Body struct {
		Document   json.RawMessage `json:"document"`
		Revision   int             `json:"revision" minimum:"1"`
		MutationID string          `json:"mutation_id" minLength:"1" maxLength:"100"`
	}
}

func (h *FilmHandler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-film-projects", Method: http.MethodGet, Path: "/api/app/film-projects", Security: userSecurity}, h.list)
	huma.Register(api, huma.Operation{OperationID: "create-film-project", Method: http.MethodPost, Path: "/api/app/film-projects", Security: userSecurity, MaxBodyBytes: 20 << 20}, h.create)
	huma.Register(api, huma.Operation{OperationID: "get-film-project", Method: http.MethodGet, Path: "/api/app/film-projects/{id}", Security: userSecurity}, h.get)
	huma.Register(api, huma.Operation{OperationID: "save-film-project", Method: http.MethodPut, Path: "/api/app/film-projects/{id}", Security: userSecurity, MaxBodyBytes: 20 << 20}, h.save)
}
func filmUser(ctx context.Context) (string, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return "", huma.Error401Unauthorized("Authentication required")
	}
	return claims.UserID, nil
}
func filmResponse(r filmRecord) *filmOutput { out := &filmOutput{}; out.Body.Data = r; return out }

const filmColumns = `id::text, document, revision, mutation_id, created_at, updated_at`

func scanFilm(row pgx.Row) (r filmRecord, err error) {
	err = row.Scan(&r.ID, &r.Document, &r.Revision, &r.MutationID, &r.CreatedAt, &r.UpdatedAt)
	return
}
func filmDBError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return huma.Error404NotFound("Film project not found")
	}
	return huma.Error500InternalServerError("Film project storage unavailable")
}

// Keep the extensible document intact, but validate fields used by the editor
// and summary SQL. Identity fields are always assigned by the server.
func validateFilmDocument(raw json.RawMessage) (map[string]json.RawMessage, string, string, error) {
	var doc map[string]json.RawMessage
	bad := func() (map[string]json.RawMessage, string, string, error) {
		return nil, "", "", huma.Error400BadRequest("Invalid film project document")
	}
	if len(raw) > 20<<20 || json.Unmarshal(raw, &doc) != nil || doc == nil {
		return bad()
	}
	if string(doc["script"]) == "null" || string(doc["step"]) == "null" {
		return bad()
	}
	var id, name, script string
	var version, step int
	if json.Unmarshal(doc["id"], &id) != nil || len(id) == 0 || len(id) > 100 || json.Unmarshal(doc["name"], &name) != nil || utf8.RuneCountInString(name) > 100 || json.Unmarshal(doc["script"], &script) != nil || json.Unmarshal(doc["version"], &version) != nil || version != 1 || json.Unmarshal(doc["step"], &step) != nil || step < 0 || step > 5 {
		return bad()
	}
	for _, key := range []string{"assets", "shots", "jobs", "scriptHistory"} {
		var v []json.RawMessage
		if json.Unmarshal(doc[key], &v) != nil || v == nil {
			return bad()
		}
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(doc["settings"], &settings) != nil || settings == nil {
		return bad()
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "未命名项目"
	}
	doc["name"], _ = json.Marshal(name)
	return doc, id, name, nil
}
func encodeFilmDocument(doc map[string]json.RawMessage, cloudID string) []byte {
	doc["backendId"], _ = json.Marshal(cloudID)
	doc["cloudId"], _ = json.Marshal(cloudID)
	encoded, _ := json.Marshal(doc)
	return encoded
}
func (h *FilmHandler) list(ctx context.Context, _ *struct{}) (*filmsOutput, error) {
	user, err := filmUser(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.pool.Query(ctx, `SELECT id::text, document->>'name', left(document->>'script',220),
 COALESCE(NULLIF(document->'shots'->0->>'imageUrl',''),document->'assets'->0->>'url',''),
 (document->>'step')::int, COALESCE(document->>'exportUrl','') <> '', updated_at
 FROM film_projects WHERE owner_id=$1 ORDER BY updated_at DESC,id`, user)
	if err != nil {
		return nil, filmDBError(err)
	}
	defer rows.Close()
	out := &filmsOutput{}
	out.Body.Data = []filmSummary{}
	for rows.Next() {
		var s filmSummary
		if err = rows.Scan(&s.ID, &s.Name, &s.Excerpt, &s.CoverURL, &s.Step, &s.Completed, &s.UpdatedAt); err != nil {
			return nil, filmDBError(err)
		}
		out.Body.Data = append(out.Body.Data, s)
	}
	if rows.Err() != nil {
		return nil, filmDBError(rows.Err())
	}
	return out, nil
}
func (h *FilmHandler) get(ctx context.Context, in *filmGetInput) (*filmOutput, error) {
	user, err := filmUser(ctx)
	if err != nil {
		return nil, err
	}
	r, err := scanFilm(h.pool.QueryRow(ctx, `SELECT `+filmColumns+` FROM film_projects WHERE id=$1 AND owner_id=$2`, in.ID, user))
	if err != nil {
		return nil, filmDBError(err)
	}
	return filmResponse(r), nil
}
func (h *FilmHandler) create(ctx context.Context, in *filmCreateInput) (*filmOutput, error) {
	user, err := filmUser(ctx)
	if err != nil {
		return nil, err
	}
	doc, clientID, name, err := validateFilmDocument(in.Body.Document)
	if err != nil {
		return nil, err
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, filmDBError(err)
	}
	defer tx.Rollback(ctx)
	// Serialize retry/migration of one local draft; never replace an existing cloud document.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, user+":"+clientID); err != nil {
		return nil, filmDBError(err)
	}
	existing, err := scanFilm(tx.QueryRow(ctx, `SELECT `+filmColumns+` FROM film_projects WHERE owner_id=$1 AND client_id=$2`, user, clientID))
	if err == nil {
		return filmResponse(existing), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, filmDBError(err)
	}
	id := uuid.NewString()
	// Preserve the old generation ownership when migrating a local draft.
	var legacyID string
	_ = json.Unmarshal(doc["backendId"], &legacyID)
	if legacyID != "" {
		if _, err = uuid.Parse(legacyID); err != nil {
			return nil, huma.Error400BadRequest("Invalid backing project")
		}
		err = tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND owner_id=$2 FOR UPDATE`, legacyID, user).Scan(&id)
		if err != nil {
			return nil, filmDBError(err)
		}
		var used bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM film_projects WHERE id=$1)`, id).Scan(&used)
		if err != nil {
			return nil, filmDBError(err)
		}
		if used {
			return nil, huma.Error409Conflict("Backing project already in use")
		}
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO projects(id,owner_id,name) VALUES($1,$2,$3)`, id, user, name)
		if err != nil {
			return nil, filmDBError(err)
		}
	}
	r, err := scanFilm(tx.QueryRow(ctx, `INSERT INTO film_projects(id,owner_id,client_id,document) VALUES($1,$2,$3,$4) RETURNING `+filmColumns, id, user, clientID, encodeFilmDocument(doc, id)))
	if err != nil {
		return nil, filmDBError(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, filmDBError(err)
	}
	return filmResponse(r), nil
}
func (h *FilmHandler) save(ctx context.Context, in *filmSaveInput) (*filmOutput, error) {
	user, err := filmUser(ctx)
	if err != nil {
		return nil, err
	}
	doc, clientID, name, err := validateFilmDocument(in.Body.Document)
	if err != nil {
		return nil, err
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, filmDBError(err)
	}
	defer tx.Rollback(ctx)
	r, err := scanFilm(tx.QueryRow(ctx, `SELECT `+filmColumns+` FROM film_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE`, in.ID, user))
	if err != nil {
		return nil, filmDBError(err)
	}
	if r.MutationID == in.Body.MutationID {
		return filmResponse(r), nil
	} // Lost acknowledgement: no duplicate write.
	if r.Revision != in.Body.Revision {
		return nil, huma.Error409Conflict("Project changed in another session")
	}
	var current struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(r.Document, &current)
	if current.ID != clientID {
		return nil, huma.Error400BadRequest("Project identity cannot change")
	}
	r, err = scanFilm(tx.QueryRow(ctx, `UPDATE film_projects SET document=$3,revision=revision+1,mutation_id=$4,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING `+filmColumns, in.ID, user, encodeFilmDocument(doc, in.ID), in.Body.MutationID))
	if err != nil {
		return nil, filmDBError(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE projects SET name=$2,updated_at=now() WHERE id=$1 AND owner_id=$3`, in.ID, name, user); err != nil {
		return nil, filmDBError(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, filmDBError(err)
	}
	return filmResponse(r), nil
}
