package main

import (
	"context"
	"log"
	"net/http"

	creditinfra "ccy-canvas/backend/internal/credits/infrastructure"
	identityapp "ccy-canvas/backend/internal/identity/application"
	identityinfra "ccy-canvas/backend/internal/identity/infrastructure"
	identityhttp "ccy-canvas/backend/internal/identity/interfaces"
	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/platform/database"
	"ccy-canvas/backend/internal/platform/database/sqlc"
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
	creditService := creditinfra.NewService(queries)
	identityRepository := identityinfra.NewRepository(pool, queries)
	identityService := identityapp.NewService(identityRepository, passwordService, creditService)
	identityHandler := identityhttp.NewHandler(identityService, creditService, sessionManager)
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

	router := chi.NewRouter()
	router.Use(middleware.RealIP)
	router.Use(httpx.RequestIDMiddleware)
	router.Use(httpx.CORSMiddleware(allowedOrigins))
	router.Use(middleware.Logger)
	router.Options("/*", func(w http.ResponseWriter, r *http.Request) {
		httpx.ApplyCORSHeaders(w, r, allowedOriginSet)
		w.WriteHeader(http.StatusNoContent)
	})
	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})
	identityHandler.Routes(router)

	log.Printf("listening on %s", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, router); err != nil {
		log.Fatal(err)
	}
}
