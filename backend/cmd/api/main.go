package main

import (
	"encoding/json"
	"log"
	"net/http"

	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	router := chi.NewRouter()
	router.Use(middleware.RealIP)
	router.Use(httpx.RequestIDMiddleware)
	router.Use(middleware.Logger)
	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	log.Printf("listening on %s", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, router); err != nil {
		log.Fatal(err)
	}
}
