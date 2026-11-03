package main

import (
	"context"
	"net/http"
	"time"

	"ccy-canvas/backend/internal/shared/httpx"
)

var buildCommit = "dev"

func readinessHandler(ping func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := ping(ctx); err != nil {
			httpx.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "version": buildCommit})
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"status": "ok", "version": buildCommit})
	}
}
