package interfaces

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/password"
	"ccy-canvas/backend/internal/platform/session"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func memberSafetyDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("CCY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CCY_TEST_DATABASE_URL for isolated PostgreSQL tests")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "member_safety_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = root.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		root.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !strings.HasPrefix(schema, "member_safety_test_") || len(schema) != len("member_safety_test_")+32 {
			t.Fatal("unsafe schema")
		}
		if _, err := root.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		root.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ddl, err := os.ReadFile("../../../db/migrations/001_identity_credit.sql")
	if err != nil {
		t.Fatal(err)
	}
	// PostgreSQL supplies gen_random_uuid; don't modify global extensions in a test.
	ddlText := strings.ReplaceAll(string(ddl), "CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
	if _, err = pool.Exec(ctx, ddlText); err != nil {
		t.Fatal(err)
	}
	return pool
}

func safetyRouter(pool *pgxpool.Pool) (http.Handler, session.Manager) {
	r := chi.NewMux()
	api := httpapi.New(r)
	sessions := session.NewManager(strings.Repeat("s", 32), false)
	api.UseMiddleware(authn.Middleware(api, sessions))
	NewAdminHandler(sqlc.New(pool), password.NewService()).WithPool(pool).RegisterRoutes(api)
	return r, sessions
}

func safetyRequest(r http.Handler, sessions session.Manager, actor, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	cookie, _ := sessions.NewCookie(actor, "admin")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestMemberSelfProtection(t *testing.T) {
	r, sessions := safetyRouter(nil)
	id := uuid.NewString()
	for _, test := range []struct{ method, suffix, body string }{
		{"PATCH", "/role", `{"role":"member"}`},
		{"PATCH", "/status", `{"status":"disabled"}`},
		{"DELETE", "", ""},
	} {
		w := safetyRequest(r, sessions, id, test.method, "/api/admin/users/"+id+test.suffix, test.body)
		if w.Code != 400 {
			t.Fatalf("self change not blocked: %d %s", w.Code, w.Body.String())
		}
	}
	// Noncanonical separators must not bypass the self-ID comparison.
	malformed := strings.ReplaceAll(id, "-", "_")
	w := safetyRequest(r, sessions, id, "PATCH", "/api/admin/users/"+malformed+"/role", `{"role":"member"}`)
	if w.Code != 400 {
		t.Fatal("malformed ID bypassed self protection")
	}
}

func TestMemberConcurrentDemotion(t *testing.T) {
	pool := memberSafetyDB(t)
	ctx := context.Background()
	first, second := uuid.NewString(), uuid.NewString()
	for _, id := range []string{first, second} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,role) VALUES($1,$2,'test','Test','admin')`, id, id+"@test.invalid"); err != nil {
			t.Fatal(err)
		}
	}
	r, sessions := safetyRouter(pool)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for _, pair := range [][2]string{{first, second}, {second, first}} {
		wg.Add(1)
		go func(actor, target string) {
			defer wg.Done()
			w := safetyRequest(r, sessions, actor, "PATCH", "/api/admin/users/"+target+"/role", `{"role":"member"}`)
			results <- w.Code
		}(pair[0], pair[1])
	}
	wg.Wait()
	close(results)
	ok, forbidden := 0, 0
	for code := range results {
		if code == 200 {
			ok++
		} else if code == 403 {
			forbidden++
		} else {
			t.Fatalf("unexpected status %d", code)
		}
	}
	var admins int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE role='admin' AND status='active'`).Scan(&admins); err != nil {
		t.Fatal(err)
	}
	if ok != 1 || forbidden != 1 || admins != 1 {
		t.Fatal("concurrent changes removed all administrators")
	}
}

func TestMemberCreditsAtomicAndValidated(t *testing.T) {
	pool := memberSafetyDB(t)
	ctx := context.Background()
	admin, member := uuid.NewString(), uuid.NewString()
	for _, u := range [][2]string{{admin, "admin"}, {member, "member"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,role) VALUES($1,$2,'test','Test',$3)`, u[0], u[0]+"@test.invalid", u[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO credit_accounts(user_id,daily_quota,current_balance) VALUES($1,100,100)`, member); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE credit_ledger_entries ADD CHECK (reason <> 'force-fail')`); err != nil {
		t.Fatal(err)
	}
	r, sessions := safetyRouter(pool)
	path := "/api/admin/users/" + member + "/credits"
	for _, tc := range []struct {
		body                            string
		status, balance, quota, entries int
	}{
		{`{"add_balance":10,"reason":""}`, 400, 100, 100, 0},
		{`{"add_balance":-101,"reason":"test"}`, 400, 100, 100, 0},
		{`{"add_balance":2147483647,"reason":"test"}`, 400, 100, 100, 0},
		{`{"add_balance":0,"reason":"test"}`, 400, 100, 100, 0},
		{`{"add_balance":10,"set_quota":200,"reason":"force-fail"}`, 500, 100, 100, 0},
		{`{"add_balance":10,"set_quota":200,"reason":"test topup"}`, 200, 110, 200, 1},
		{`{"set_quota":300,"reason":"quota only"}`, 200, 110, 300, 2},
	} {
		w := safetyRequest(r, sessions, admin, "POST", path, tc.body)
		if w.Code != tc.status {
			t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body.String())
		}
		var balance, quota, entries int
		if err := pool.QueryRow(ctx, `SELECT current_balance,daily_quota FROM credit_accounts WHERE user_id=$1`, member).Scan(&balance, &quota); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM credit_ledger_entries`).Scan(&entries); err != nil {
			t.Fatal(err)
		}
		if balance != tc.balance || quota != tc.quota || entries != tc.entries {
			t.Fatalf("non-atomic credit state: %d/%d ledger=%d", balance, quota, entries)
		}
	}
	// Existing credit/ledger data blocks hard deletion; nothing is silently cascaded.
	w := safetyRequest(r, sessions, admin, "DELETE", "/api/admin/users/"+member, "")
	if w.Code != 409 {
		t.Fatal("associated account deletion was not blocked")
	}
}
