package interfaces

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/httpapi"
	skillshttp "ccy-canvas/backend/internal/skills/interfaces"
	"github.com/go-chi/chi/v5"
)

// Register the actual model and skill handlers against one API, as main does.
// Package-local route tests do not reveal global Huma schema-name collisions.
func TestTaskControlSharesSchemaRegistryWithSkills(t *testing.T) {
	for _, skillsFirst := range []bool{false, true} {
		name := "catalog-first"
		if skillsFirst {
			name = "skills-first"
		}
		t.Run(name, func(t *testing.T) {
			router := chi.NewMux()
			api := httpapi.New(router)
			registerSkills := func() {
				skillshttp.NewHandler(nil, nil).RegisterRoutes(api)
				skillshttp.NewAdminHandler(nil).RegisterRoutes(api)
			}
			registerCatalog := func() { NewHandler(application.NewService(nil, nil), nil).RegisterRoutes(api) }
			if skillsFirst {
				registerSkills()
				registerCatalog()
			} else {
				registerCatalog()
				registerSkills()
			}

			schemas := api.OpenAPI().Components.Schemas.Map()
			result := schemas["TaskCancellationResult"]
			if result == nil || result.Properties["task"] == nil || result.Properties["cancelled"] == nil || result.Properties["reason"] == nil {
				t.Fatal("cancellation response must have its own complete named schema")
			}
			if legacy := schemas["DataStruct"]; legacy == nil || legacy.Properties["type"] == nil || legacy.Properties["task"] != nil {
				t.Fatal("task registration changed the legacy skill-test schema")
			}
			path := api.OpenAPI().Paths["/api/app/tasks/{id}/cancel"]
			if path == nil || path.Post == nil {
				t.Fatal("cancel endpoint missing from the shared OpenAPI document")
			}
			bodyRef := path.Post.Responses["200"].Content["application/json"].Schema.Ref
			body := schemas[strings.TrimPrefix(bodyRef, "#/components/schemas/")]
			if body == nil || body.Properties["data"].Ref != "#/components/schemas/TaskCancellationResult" {
				t.Fatal("cancel endpoint points at the wrong data schema")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil))
			if response.Code != http.StatusOK || !json.Valid(response.Body.Bytes()) {
				t.Fatalf("shared OpenAPI is not servable JSON: status %d", response.Code)
			}
		})
	}
}
