package interfaces

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func filmTestDocument() map[string]any {
	return map[string]any{"version": 1, "id": "client-draft", "name": "测试作品", "script": "旅人来到云上的车站。", "step": 2, "settings": map[string]any{"splitSkillId": "草帽与梦", "ratio": "9:16"}, "assets": []any{}, "shots": []any{}, "jobs": []any{}, "scriptHistory": []any{}, "editProject": map[string]any{"clips": []any{}}, "updatedAt": 123}
}
func TestFilmDocumentValidation(t *testing.T) {
	good := filmTestDocument()
	raw, _ := json.Marshal(good)
	doc, id, name, err := validateFilmDocument(raw)
	if err != nil || id != "client-draft" || name != "测试作品" {
		t.Fatalf("valid document rejected: %v", err)
	}
	var roundtrip map[string]any
	_ = json.Unmarshal(encodeFilmDocument(doc, "server-id"), &roundtrip)
	if roundtrip["backendId"] != "server-id" || roundtrip["cloudId"] != "server-id" || roundtrip["editProject"] == nil {
		t.Fatal("identity/timeline not preserved")
	}
	for _, bad := range []string{`null`, `[]`, `{}`, `{"version":2}`} {
		if _, _, _, err := validateFilmDocument([]byte(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	for key, value := range map[string]any{"version": 2, "step": nil, "assets": nil, "jobs": "bad", "settings": []any{}, "script": nil} {
		p := filmTestDocument()
		p[key] = value
		raw, _ := json.Marshal(p)
		if _, _, _, err := validateFilmDocument(raw); err == nil {
			t.Fatalf("accepted invalid %s", key)
		}
	}
}
func TestFilmRoutesRequireAuthentication(t *testing.T) {
	router := chi.NewMux()
	api := httpapi.New(router)
	manager := session.NewManager("01234567890123456789012345678901", false)
	api.UseMiddleware(authn.Middleware(api, manager))
	NewFilmHandler(nil).RegisterRoutes(api)
	for _, method := range []string{"GET", "POST"} {
		out := httptest.NewRecorder()
		router.ServeHTTP(out, httptest.NewRequest(method, "/api/app/film-projects", nil))
		if out.Code != 401 {
			t.Fatalf("%s status=%d", method, out.Code)
		}
	}
}

// Runs only against an explicitly supplied DB. Every object lives in an isolated
// random schema; no application users/projects are read or changed.
func TestFilmDatabaseRoundTrip(t *testing.T) {
	url := os.Getenv("FILM_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set FILM_TEST_DATABASE_URL for isolated PostgreSQL integration test")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "film_test_" + uuid.New().String()[:8]
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	_, err = pool.Exec(ctx, `CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid REFERENCES users(id),name text,updated_at timestamptz DEFAULT now())`)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "db", "migrations", "046_film_projects.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	a, b := uuid.NewString(), uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id) VALUES($1),($2)`, a, b); err != nil {
		t.Fatal(err)
	}
	router := chi.NewMux()
	api := httpapi.New(router)
	manager := session.NewManager("01234567890123456789012345678901", false)
	api.UseMiddleware(authn.Middleware(api, manager))
	NewFilmHandler(pool).RegisterRoutes(api)
	request := func(user, method, path string, body any, want int) []byte {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		cookie, _ := manager.NewCookie(user, "member")
		req.AddCookie(cookie)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != want {
			t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, out.Code, want, out.Body.String())
		}
		return out.Body.Bytes()
	}
	decode := func(raw []byte) filmRecord {
		var r struct {
			Data filmRecord `json:"data"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatal(err)
		}
		return r.Data
	}
	p := filmTestDocument()
	r := decode(request(a, "POST", "/api/app/film-projects", map[string]any{"document": p}, 200))
	path := "/api/app/film-projects/" + r.ID
	if r.Revision != 1 {
		t.Fatal("wrong initial revision")
	}
	p["script"] = "完整保存后的剧本"
	p["backendId"] = uuid.NewString()
	save := map[string]any{"document": p, "revision": 1, "mutation_id": "save-1"}
	r = decode(request(a, "PUT", path, save, 200))
	if r.Revision != 2 {
		t.Fatal("revision did not advance")
	}
	var restored map[string]any
	_ = json.Unmarshal(decode(request(a, "GET", path, nil, 200)).Document, &restored)
	if restored["script"] != p["script"] || restored["backendId"] != r.ID || restored["settings"].(map[string]any)["splitSkillId"] != "草帽与梦" {
		t.Fatal("full document did not survive roundtrip")
	}
	if decode(request(a, "PUT", path, save, 200)).Revision != 2 {
		t.Fatal("lost acknowledgement advanced revision twice")
	}
	save["mutation_id"] = "stale-client"
	request(a, "PUT", path, save, 409)
	request(b, "GET", path, nil, 404)
	request(b, "PUT", path, save, 404)
	var list struct {
		Data []filmSummary `json:"data"`
	}
	_ = json.Unmarshal(request(b, "GET", "/api/app/film-projects", nil, 200), &list)
	if len(list.Data) != 0 {
		t.Fatal("cross-user list leak")
	}
	p["script"] = "旧草稿"
	r2 := decode(request(a, "POST", "/api/app/film-projects", map[string]any{"document": p}, 200))
	if r2.ID != r.ID || r2.Revision != 2 {
		t.Fatal("migration replaced cloud data")
	}
	legacy := filmTestDocument()
	legacy["id"] = "another-draft"
	legacy["backendId"] = r.ID
	request(b, "POST", "/api/app/film-projects", map[string]any{"document": legacy}, 404)
	request(a, "POST", "/api/app/film-projects", map[string]any{"document": legacy}, 409)
	second := filmTestDocument()
	second["id"] = "second"
	second["name"] = "第二集"
	r3 := decode(request(a, "POST", "/api/app/film-projects", map[string]any{"document": second}, 200))
	if r3.ID == r.ID {
		t.Fatal("projects share identity")
	}
	_ = json.Unmarshal(request(a, "GET", "/api/app/film-projects", nil, 200), &list)
	if len(list.Data) != 2 {
		t.Fatal("multiple projects not listed")
	}
	// Requests with the same draft ID remain isolated by user.
	other := decode(request(b, "POST", "/api/app/film-projects", map[string]any{"document": filmTestDocument()}, 200))
	if other.ID == r.ID {
		t.Fatal("cross-user create collision")
	}
}
