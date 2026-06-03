package main

import (
	"context"
	"log"
	"net/http"

	creditinfra "ccy-canvas/backend/internal/credits/infrastructure"
	identityapp "ccy-canvas/backend/internal/identity/application"
	identityinfra "ccy-canvas/backend/internal/identity/infrastructure"
	identityhttp "ccy-canvas/backend/internal/identity/interfaces"
	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/infrastructure"
	modelhttp "ccy-canvas/backend/internal/modelcatalog/interfaces"
	skillshttp "ccy-canvas/backend/internal/skills/interfaces"
	workspaceinfra "ccy-canvas/backend/internal/workspace/infrastructure"
	workspacehttp "ccy-canvas/backend/internal/workspace/interfaces"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/platform/database"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/password"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	queries := sqlc.New(pool)
	sessionManager := session.NewManager(cfg.SessionSecret, cfg.CookieSecure)
	passwordService := password.NewService()

	// Identity & Auth
	creditService := creditinfra.NewService(queries)
	identityRepository := identityinfra.NewRepository(pool, queries)
	identityService := identityapp.NewService(identityRepository, passwordService, creditService)
	identityHandler := identityhttp.NewHandler(identityService, creditService, sessionManager)

	// Model Catalog
	catalogRepo := infrastructure.NewRepository(queries)
	catalogService := application.NewService(catalogRepo, cfg.EncryptionKey)
	catalogHandler := modelhttp.NewHandler(catalogService, queries)

	allowedOrigins := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"http://localhost:5174",
		"http://127.0.0.1:5174",
	}
	allowedOriginSet := map[string]struct{}{}
	for _, origin := range allowedOrigins {
		allowedOriginSet[origin] = struct{}{}
	}

	router := chi.NewMux()
	router.Use(middleware.RealIP)
	router.Use(httpx.RequestIDMiddleware)
	router.Use(httpx.CORSMiddleware(allowedOrigins))
	router.Use(httpx.MaxBodyMiddleware(10 * 1024 * 1024)) // 10 MB cap for non-upload endpoints
	router.Use(middleware.Logger)
	router.Options("/*", func(w http.ResponseWriter, r *http.Request) {
		httpx.ApplyCORSHeaders(w, r, allowedOriginSet)
		w.WriteHeader(http.StatusNoContent)
	})
	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})

	// File upload + static file serving.
	workspacehttp.RegisterUploadRoutes(router, sessionManager)
	fileServer := http.StripPrefix("/uploads/", http.FileServer(http.Dir("uploads")))
	router.Get("/uploads/*", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000")
		fileServer.ServeHTTP(w, r)
	})

	// Existing chi identity routes (login / register / logout / me / invitations).
	identityHandler.Routes(router)

	// Huma API: OpenAPI 3.1 at /api/openapi.json + per-operation auth middleware.
	api := httpapi.New(router)
	api.UseMiddleware(authn.Middleware(api, sessionManager))

	// Admin management routes (users, invitations, stats, logs).
	adminHandler := identityhttp.NewAdminHandler(queries, passwordService)
	adminHandler.RegisterRoutes(api)

	// Model catalog routes.
	catalogHandler.RegisterRoutes(api)

	// Workspace routes (projects + canvas).
	workspaceRepo := workspaceinfra.NewRepository(queries)
	workspaceHandler := workspacehttp.NewHandler(workspaceRepo)
	workspaceHandler.RegisterRoutes(api)

	// Skills + Agents routes (user CRUD + admin CRUD).
	skillsHandler := skillshttp.NewHandler(queries)
	skillsHandler.RegisterRoutes(api)
	skillsAdminHandler := skillshttp.NewAdminHandler(queries)
	skillsAdminHandler.RegisterRoutes(api)

	log.Printf("listening on %s", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, router); err != nil {
		log.Fatal(err)
	}
}
