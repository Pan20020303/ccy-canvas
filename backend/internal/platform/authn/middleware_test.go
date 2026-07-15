package authn

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
)

type authCheckOutput struct {
	Body struct {
		UserID string `json:"user_id"`
	}
}

func newTestServer(t *testing.T) (*httptest.Server, session.Manager) {
	t.Helper()

	router := chi.NewMux()
	api := httpapi.New(router)
	manager := session.NewManager("01234567890123456789012345678901", false)
	api.UseMiddleware(Middleware(api, manager))

	huma.Register(api, huma.Operation{
		OperationID: "public-check",
		Method:      http.MethodGet,
		Path:        "/public",
	}, func(context.Context, *struct{}) (*struct{}, error) {
		return &struct{}{}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-check",
		Method:      http.MethodGet,
		Path:        "/admin",
		Security:    []map[string][]string{{httpapi.SecuritySchemeName: {ScopeAdmin}}},
	}, func(ctx context.Context, _ *struct{}) (*authCheckOutput, error) {
		claims, ok := ClaimsFromContext(ctx)
		if !ok {
			t.Fatal("expected claims in context")
		}
		out := &authCheckOutput{}
		out.Body.UserID = claims.UserID
		return out, nil
	})

	return httptest.NewServer(router), manager
}

func TestMiddlewareAllowsOperationsWithoutSecurity(t *testing.T) {
	server, _ := newTestServer(t)
	defer server.Close()

	resp, err := http.Get(server.URL + "/public")
	if err != nil {
		t.Fatalf("GET /public: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
}

func TestMiddlewareRejectsMissingSession(t *testing.T) {
	server, _ := newTestServer(t)
	defer server.Close()

	resp, err := http.Get(server.URL + "/admin")
	if err != nil {
		t.Fatalf("GET /admin: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
}

func TestMiddlewareRejectsNonAdminSession(t *testing.T) {
	server, manager := newTestServer(t)
	defer server.Close()

	cookie, err := manager.NewCookie("member-1", "member")
	if err != nil {
		t.Fatalf("NewCookie: %v", err)
	}
	req, err := http.NewRequest(http.MethodGet, server.URL+"/admin", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.AddCookie(cookie)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /admin: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

func TestMiddlewareAllowsAdminSession(t *testing.T) {
	server, manager := newTestServer(t)
	defer server.Close()

	cookie, err := manager.NewCookie("admin-1", "admin")
	if err != nil {
		t.Fatalf("NewCookie: %v", err)
	}
	req, err := http.NewRequest(http.MethodGet, server.URL+"/admin", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.AddCookie(cookie)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /admin: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
}
