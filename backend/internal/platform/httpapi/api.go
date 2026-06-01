package httpapi

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"ccy-canvas/backend/internal/platform/session"
)

// SecuritySchemeName is the cookie security scheme name referenced in per-operation Security declarations.
const SecuritySchemeName = "sessionCookie"

// New creates a huma API mounted on the given chi router.
// OpenAPI 3.1 spec is served at /api/openapi.json and /api/openapi.yaml.
func New(router *chi.Mux) huma.API {
	cfg := huma.DefaultConfig("CCY Canvas API", "0.1.0")
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "" // disable built-in Stoplight renderer
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		SecuritySchemeName: {
			Type: "apiKey",
			In:   "cookie",
			Name: session.CookieName,
		},
	}
	return humachi.New(router, cfg)
}
