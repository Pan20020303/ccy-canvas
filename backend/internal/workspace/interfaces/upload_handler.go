package interfaces

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maxUploadSize = 50 * 1024 * 1024 // 50 MB
const maxProxySize = 100 * 1024 * 1024 // 100 MB
const uploadDir = "uploads"

// RegisterUploadRoutes registers file upload and media proxy endpoints.
func RegisterUploadRoutes(r chi.Router, sm session.Manager) {
	r.Get("/api/app/proxy-media", proxyMediaHandler(sm))
	r.Post("/api/app/upload", func(w http.ResponseWriter, r *http.Request) {
		// Auth check.
		cookie, err := r.Cookie(session.CookieName)
		if err != nil || cookie.Value == "" {
			httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
			return
		}
		claims, err := sm.Parse(cookie.Value)
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
			return
		}
		_ = claims

		r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
		if err := r.ParseMultipartForm(maxUploadSize); err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "File too large (max 50MB)"})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "No file provided"})
			return
		}
		defer file.Close()

		// Validate content type.
		contentType := header.Header.Get("Content-Type")
		if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Only image and video files are allowed"})
			return
		}

		// Create upload directory.
		dateDir := time.Now().Format("2006-01")
		dir := filepath.Join(uploadDir, dateDir)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to create upload directory"})
			return
		}

		// Generate unique filename.
		ext := filepath.Ext(header.Filename)
		if ext == "" {
			if strings.HasPrefix(contentType, "image/png") {
				ext = ".png"
			} else if strings.HasPrefix(contentType, "image/jpeg") {
				ext = ".jpg"
			} else if strings.HasPrefix(contentType, "video/mp4") {
				ext = ".mp4"
			} else if strings.HasPrefix(contentType, "video/quicktime") {
				ext = ".mov"
			} else {
				ext = ".bin"
			}
		}
		filename := fmt.Sprintf("%s%s", uuid.New().String(), ext)
		filePath := filepath.Join(dir, filename)

		dst, err := os.Create(filePath)
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save file"})
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to write file"})
			return
		}

		// Return URL path (served as static files).
		url := fmt.Sprintf("/uploads/%s/%s", dateDir, filename)

		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{
			"url":          url,
			"filename":     header.Filename,
			"content_type": contentType,
		})
	})
}

func proxyMediaHandler(sm session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(session.CookieName)
		if err != nil || cookie.Value == "" {
			http.Error(w, "Authentication required", http.StatusUnauthorized)
			return
		}
		if _, err := sm.Parse(cookie.Value); err != nil {
			http.Error(w, "Invalid session", http.StatusUnauthorized)
			return
		}

		target := r.URL.Query().Get("url")
		if target == "" || (!strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://")) {
			http.Error(w, "Missing or invalid url parameter", http.StatusBadRequest)
			return
		}

		client := &http.Client{Timeout: 60 * time.Second}
		resp, err := client.Get(target)
		if err != nil {
			http.Error(w, "Failed to fetch media", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		if !strings.HasPrefix(ct, "video/") && !strings.HasPrefix(ct, "image/") {
			http.Error(w, "Not a media resource", http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", ct)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			w.Header().Set("Content-Length", cl)
		}
		io.Copy(w, io.LimitReader(resp.Body, maxProxySize))
	}
}
