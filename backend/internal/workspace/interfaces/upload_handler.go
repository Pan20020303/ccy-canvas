package interfaces

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
	"ccy-canvas/backend/internal/shared/safehttp"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maxUploadSize = 50 * 1024 * 1024 // 50 MB
const maxProxySize = 100 * 1024 * 1024 // 100 MB

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
		// Defense against stored XSS: never trust the client-declared type for
		// safety decisions. Sniff the real bytes and reject anything a browser
		// could execute as an active document (SVG/HTML/XML) when later served
		// from /uploads on our own origin.
		sniff := make([]byte, 512)
		sn, _ := io.ReadFull(file, sniff)
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to read file"})
			return
		}
		detected := http.DetectContentType(sniff[:sn])
		if strings.Contains(contentType, "svg") ||
			strings.Contains(detected, "svg") ||
			strings.Contains(detected, "xml") ||
			strings.HasPrefix(detected, "text/html") {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Unsupported file content"})
			return
		}

		dateDir := time.Now().Format("2006-01")
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
		url, err := assetstore.Save(r.Context(), fmt.Sprintf("%s/%s", dateDir, filename), file, contentType)
		if err != nil {
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save file"})
			return
		}

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
		// SSRF guard: reject obviously-internal targets up front; the hardened
		// client additionally validates the resolved IP at dial time, defeating
		// DNS rebinding and redirects to internal hosts.
		if err := safehttp.ValidatePublicURL(target); err != nil {
			http.Error(w, "Refusing to proxy that url", http.StatusBadRequest)
			return
		}
		// Own-bucket objects are private (the bucket blocks public access, so the
		// upload-time public-read ACL is overridden and a raw GET 403s). Presign
		// the URL server-side so the proxy can read it; PresignGet returns "" for
		// anything that isn't one of our objects, in which case we fetch as-is.
		// The presigned URL keeps the same (already-validated, public) COS host,
		// and the hardened client re-checks the dialed IP, so SSRF posture holds.
		fetchURL := target
		if signed, perr := assetstore.PresignGet(r.Context(), target, 10*time.Minute); perr == nil && signed != "" {
			fetchURL = signed
		}
		client := safehttp.Client(60 * time.Second)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, fetchURL, nil)
		if err != nil {
			http.Error(w, "Failed to build request", http.StatusBadRequest)
			return
		}
		// Some buckets / CDNs (COS 防盗链, Cloudflare bot fight, etc.)
		// reject requests with an empty or non-browser User-Agent. Set
		// a common one. We explicitly do NOT forward Referer so
		// referrer-based hotlink protection doesn't bite either.
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; CCYCanvasProxy/1.0)")
		req.Header.Set("Accept", "image/*,video/*,*/*;q=0.8")

		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, "Failed to fetch media: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			http.Error(w, fmt.Sprintf("Upstream returned HTTP %d", resp.StatusCode), http.StatusBadGateway)
			return
		}

		// Be permissive with Content-Type. Many object stores (COS
		// included) return application/octet-stream when no
		// Content-Type was set at upload time — the file is still a
		// real image/video. Resolution order:
		//   1. trust upstream if it's already image/* or video/*
		//   2. sniff URL extension (covers signed-URL cases)
		//   3. peek the first 512 bytes and run http.DetectContentType
		//      (bulletproof for COS files saved with .bin/.img keys)
		ct := resp.Header.Get("Content-Type")
		body := bufio.NewReaderSize(resp.Body, 512)
		if !strings.HasPrefix(ct, "video/") && !strings.HasPrefix(ct, "image/") {
			if sniffed := sniffMediaType(target); sniffed != "" {
				ct = sniffed
			} else {
				peek, _ := body.Peek(512)
				detected := http.DetectContentType(peek)
				if strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") {
					ct = detected
				} else {
					http.Error(w, "Not a media resource (upstream="+resp.Header.Get("Content-Type")+", detected="+detected+")", http.StatusBadRequest)
					return
				}
			}
		}

		w.Header().Set("Content-Type", ct)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// SVG can carry <script>; served same-origin it is a stored-XSS vector
		// on direct navigation. Force download for it — inline <img> rendering
		// is unaffected by Content-Disposition.
		if strings.Contains(ct, "svg") {
			w.Header().Set("Content-Disposition", "attachment")
		}
		// NOTE: do NOT set Access-Control-Allow-Origin here. The global
		// CORSMiddleware already emitted the specific request origin plus
		// Access-Control-Allow-Credentials: true. Overwriting it with "*"
		// makes the browser reject any credentialed fetch (credentials:'include'
		// + ACAO "*" is invalid), which is exactly how download / capture /
		// re-upload calls to this proxy fail on the success path.
		w.Header().Set("Cache-Control", "public, max-age=86400")
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			w.Header().Set("Content-Length", cl)
		}
		io.Copy(w, io.LimitReader(body, maxProxySize))
	}
}

// sniffMediaType returns a best-guess image/video MIME type for a URL
// when the upstream Content-Type is missing or generic
// (application/octet-stream). Returns "" if the URL has no recognised
// media extension — caller should reject in that case.
func sniffMediaType(rawURL string) string {
	idx := strings.IndexAny(rawURL, "?#")
	path := rawURL
	if idx >= 0 {
		path = rawURL[:idx]
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	case ".avif":
		return "image/avif"
	case ".heic":
		return "image/heic"
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	}
	return ""
}
