package interfaces

import (
	"bufio"
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
	"ccy-canvas/backend/internal/shared/safehttp"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const maxUploadSize = 50 * 1024 * 1024 // 50 MB
const maxProxySize = 100 * 1024 * 1024 // 100 MB

// RegisterUploadRoutes registers file upload and media proxy endpoints.
func RegisterUploadRoutes(r chi.Router, sm session.Manager) {
	cache := newMediaCache() // nil unless MEDIA_CACHE_DIR is set (opt-in)
	r.Get("/api/app/proxy-media", proxyMediaHandler(sm, cache))
	r.Get("/api/app/media-thumbnail", localMediaThumbnailHandler(sm, cache))
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
		if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") && !strings.HasPrefix(contentType, "audio/") {
			httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Only image, video and audio files are allowed"})
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
			} else if strings.HasPrefix(contentType, "audio/mpeg") {
				ext = ".mp3"
			} else if strings.HasPrefix(contentType, "audio/wav") || strings.HasPrefix(contentType, "audio/x-wav") || strings.HasPrefix(contentType, "audio/wave") {
				ext = ".wav"
			} else if strings.HasPrefix(contentType, "audio/mp4") || strings.HasPrefix(contentType, "audio/x-m4a") {
				ext = ".m4a"
			} else {
				ext = ".bin"
			}
		}
		filename := fmt.Sprintf("%s%s", uuid.New().String(), ext)
		key := fmt.Sprintf("%s/%s", dateDir, filename)
		url, err := assetstore.Save(r.Context(), key, file, contentType)
		if err != nil {
			// 之前这里静默吞错(生产 500 无从排查):必须落日志,并降级到
			// 本地磁盘 —— 对象存储(COS/OSS)故障时上传不该整体瘫痪。
			log.Printf("[upload] primary store save failed (key=%s): %v — falling back to local disk", key, err)
			if _, seekErr := file.Seek(0, io.SeekStart); seekErr != nil {
				httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save file (storage error, see server log)"})
				return
			}
			url, err = assetstore.SaveLocal(r.Context(), key, file, contentType)
			if err != nil {
				log.Printf("[upload] local fallback also failed (key=%s): %v", key, err)
				httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to save file (storage error, see server log)"})
				return
			}
		}

		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{
			"url":          url,
			"filename":     header.Filename,
			"content_type": contentType,
		})
	})
}

func localMediaThumbnailHandler(sm session.Manager, cache *mediaCache) http.HandlerFunc {
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

		requested := strings.TrimSpace(r.URL.Query().Get("path"))
		width := parseThumbWidth(r.URL.Query().Get("w"))
		if !strings.HasPrefix(requested, "/uploads/") || width == 0 {
			http.Error(w, "Missing or invalid thumbnail parameters", http.StatusBadRequest)
			return
		}
		rel := filepath.Clean(filepath.FromSlash(strings.TrimPrefix(requested, "/uploads/")))
		if rel == "." || rel == "" || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			http.Error(w, "Invalid media path", http.StatusBadRequest)
			return
		}
		root, err := filepath.Abs(strings.TrimSpace(os.Getenv("UPLOAD_DIR")))
		if err != nil || strings.TrimSpace(os.Getenv("UPLOAD_DIR")) == "" {
			root, err = filepath.Abs("uploads")
		}
		if err != nil {
			http.Error(w, "Media storage unavailable", http.StatusInternalServerError)
			return
		}
		source := filepath.Join(root, rel)
		resolved, err := filepath.Abs(source)
		if err != nil || (resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator))) {
			http.Error(w, "Invalid media path", http.StatusBadRequest)
			return
		}

		cacheKey := "local:" + filepath.ToSlash(rel) + "|w=" + strconv.Itoa(width)
		if cache != nil {
			if bodyPath, ct, ok := cache.lookup(cacheKey); ok {
				w.Header().Set("X-Cache", "HIT")
				serveCachedFile(w, r, bodyPath, ct)
				return
			}
		}
		file, err := os.Open(resolved)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "Media not found", http.StatusNotFound)
			} else {
				http.Error(w, "Failed to read media", http.StatusInternalServerError)
			}
			return
		}
		defer file.Close()
		thumb, err := resizeImageToJPEG(io.LimitReader(file, maxProxySize), width)
		if err != nil {
			http.Error(w, "Failed to resize media", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", cacheControlOwnObject)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Length", strconv.Itoa(len(thumb)))
		if cache != nil {
			w.Header().Set("X-Cache", "MISS")
			if err := cache.storeWhileServing(cacheKey, "image/jpeg", w, bytes.NewReader(thumb)); err != nil {
				log.Printf("[media-thumbnail] cache fill failed: %v", err)
			}
			return
		}
		_, _ = w.Write(thumb)
	}
}

func proxyMediaHandler(sm session.Manager, cache *mediaCache) http.HandlerFunc {
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
		// Own-bucket objects may be private (COS/OSS access rules), so presign
		// the URL server-side; PresignGet returns "" for anything that isn't one
		// of our objects. A non-empty result also flags "this is our asset",
		// which drives the immutable long cache and the on-disk media cache.
		signed, _ := assetstore.PresignGet(r.Context(), target, 10*time.Minute)
		ourObject := signed != ""

		// ③ Thumbnail variant: for image objects on a host with a server-side
		// resize pipeline (Aliyun OSS x-oss-process OR Tencent COS imageMogr2),
		// ?w=<px> fetches a small WebP instead of the multi-MB original — a big
		// win for gallery/canvas tiles. Public bucket URLs are fetchable without
		// a presign, so this does NOT require ourObject (matters while images are
		// still on COS but the configured storage backend is OSS).
		width := parseThumbWidth(r.URL.Query().Get("w"))
		useResize := width > 0 && supportsThumbnail(target) &&
			strings.HasPrefix(sniffMediaType(target), "image/")

		// Cache key is the STABLE public URL (+ thumb width), never the rotating
		// presigned URL. Cache our own assets AND our OSS/COS-hosted media (which
		// are ours too, just on the not-currently-configured backend).
		cacheKey := target
		if useResize {
			cacheKey = target + "|w=" + strconv.Itoa(width)
		}
		caching := cache != nil && (ourObject || supportsThumbnail(target))

		// ① Cache hit — serve straight from local disk (Range via ServeContent).
		if caching {
			if bodyPath, ct, ok := cache.lookup(cacheKey); ok {
				w.Header().Set("X-Cache", "HIT")
				serveCachedFile(w, r, bodyPath, ct)
				return
			}
		}

		fetchURL := target
		switch {
		case useResize:
			fetchURL = resizeURL(target, width) // public object + OSS/COS resize pipeline
		case signed != "":
			fetchURL = signed
		}

		client := safehttp.Client(60 * time.Second)
		rangeHeader := r.Header.Get("Range")
		// A browser probes videos with Range requests so it can decode the first
		// frame without downloading the whole file. Never turn that probe into a
		// full-object cache fill: doing so is what kept completed video nodes grey
		// until every byte had arrived. Full responses still populate the cache
		// through the streaming tee below.
		if caching && rangeHeader != "" {
			caching = false
		}
		upstreamRange := rangeHeader

		// fetch does the request with one retry on transport error / upstream
		// 5xx (the provider link occasionally drops the first connection).
		fetch := func(u, rng string) (*http.Response, error) {
			var resp *http.Response
			var lastErr error
			for attempt := 0; attempt < 2; attempt++ {
				req, rerr := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
				if rerr != nil {
					return nil, rerr
				}
				// Some buckets / CDNs (COS 防盗链, Cloudflare bot fight, etc.)
				// reject empty / non-browser User-Agents. We also deliberately do
				// NOT forward Referer so hotlink protection doesn't bite.
				req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; CCYCanvasProxy/1.0)")
				req.Header.Set("Accept", "image/*,video/*,audio/*,*/*;q=0.8")
				if rng != "" {
					req.Header.Set("Range", rng)
				}
				resp, lastErr = client.Do(req)
				if lastErr == nil && resp.StatusCode < 500 {
					return resp, nil
				}
				if resp != nil {
					resp.Body.Close()
					resp = nil
				}
			}
			return resp, lastErr
		}

		resp, lastErr := fetch(fetchURL, upstreamRange)
		localResize := false
		// If the resized fetch fails (e.g. non-image / pipeline error), fall back
		// to the original object once. Keep the requested thumbnail width so very
		// large images rejected by OSS image processing can still be resized here;
		// otherwise a 20+ MB source is sent to every browser unchanged.
		if useResize && (lastErr != nil || resp == nil || resp.StatusCode >= 400) {
			if resp != nil {
				resp.Body.Close()
			}
			useResize = false
			localResize = true
			fallback := target
			if signed != "" {
				fallback = signed
			}
			resp, lastErr = fetch(fallback, upstreamRange)
		}
		if lastErr != nil {
			http.Error(w, "Failed to fetch media: "+lastErr.Error(), http.StatusBadGateway)
			return
		}
		if resp == nil {
			http.Error(w, "Upstream unavailable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
				http.Error(w, "Requested range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
				return
			}
			http.Error(w, fmt.Sprintf("Upstream returned HTTP %d", resp.StatusCode), http.StatusBadGateway)
			return
		}

		// OSS rejects image processing for source files larger than 20 MiB. In
		// that case create the requested thumbnail locally. The browser receives
		// a small JPEG and the normal media cache stores this variant by URL+width.
		if localResize {
			thumb, rerr := resizeImageToJPEG(io.LimitReader(resp.Body, maxProxySize), width)
			if rerr != nil {
				http.Error(w, "Failed to resize media", http.StatusBadGateway)
				return
			}
			resp.Body.Close()
			resp.Body = io.NopCloser(bytes.NewReader(thumb))
			resp.ContentLength = int64(len(thumb))
			resp.Header.Set("Content-Type", "image/jpeg")
			resp.Header.Set("Content-Length", strconv.Itoa(len(thumb)))
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
		// A 206 partial that does not start at byte 0 carries mid-file bytes —
		// http.DetectContentType on them is meaningless. Browsers always begin
		// with `bytes=0-`, so byte sniffing stays available for the request
		// that matters; later mid-file seeks fall back to the URL extension.
		partialFromMiddle := resp.StatusCode == http.StatusPartialContent &&
			!strings.HasPrefix(strings.ReplaceAll(rangeHeader, " ", ""), "bytes=0-")
		if !strings.HasPrefix(ct, "video/") && !strings.HasPrefix(ct, "image/") && !strings.HasPrefix(ct, "audio/") {
			if sniffed := sniffMediaType(target); sniffed != "" {
				ct = sniffed
			} else if partialFromMiddle {
				http.Error(w, "Not a media resource (mid-file range without a media extension)", http.StatusBadRequest)
				return
			} else {
				peek, _ := body.Peek(512)
				detected := http.DetectContentType(peek)
				// application/ogg is how Go detects Ogg audio containers.
				if strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") || strings.HasPrefix(detected, "audio/") || detected == "application/ogg" {
					ct = detected
				} else {
					http.Error(w, "Not a media resource (upstream="+resp.Header.Get("Content-Type")+", detected="+detected+")", http.StatusBadRequest)
					return
				}
			}
		}

		// A resized thumbnail comes back as WebP regardless of the source ext.
		if useResize {
			ct = "image/webp"
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
		// ② Our content-addressed assets never change → immutable long cache;
		// arbitrary passthrough URLs keep the conservative 1-day cache.
		// Our OSS/COS-hosted media is content-addressed (immutable) too, even when
		// ourObject is false because the configured backend differs from where the
		// image currently lives (COS during the in-flight OSS migration).
		w.Header().Set("Cache-Control", cacheControlFor(ourObject || supportsThumbnail(target)))
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			w.Header().Set("Content-Length", cl)
		}
		// Range plumbing: advertise seekability and mirror partial responses so
		// media elements can scrub.
		if ar := resp.Header.Get("Accept-Ranges"); ar != "" {
			w.Header().Set("Accept-Ranges", ar)
		}
		if cr := resp.Header.Get("Content-Range"); cr != "" {
			w.Header().Set("Content-Range", cr)
		}
		if resp.StatusCode == http.StatusPartialContent {
			w.WriteHeader(http.StatusPartialContent)
		}
		// Cache misses stream to the browser and cache simultaneously. This must
		// happen after response headers are prepared so first paint is not held
		// hostage by a multi-megabyte image or video download.
		if caching {
			w.Header().Set("X-Cache", "MISS")
			if cerr := cache.storeWhileServing(cacheKey, ct, w, io.LimitReader(body, maxProxySize)); cerr != nil {
				log.Printf("[proxy-media] streaming cache fill failed: %v", cerr)
			}
			return
		}
		io.Copy(w, io.LimitReader(body, maxProxySize))
	}
}

func resizeImageToJPEG(src io.Reader, maxWidth int) ([]byte, error) {
	if maxWidth <= 0 {
		return nil, fmt.Errorf("invalid width")
	}
	decoded, _, err := image.Decode(src)
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid image dimensions")
	}
	targetWidth := min(width, maxWidth)
	targetHeight := max(1, height*targetWidth/width)
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	// ApproxBiLinear is intentionally used for canvas thumbnails: it is much
	// faster on provider images with very large pixel dimensions while remaining
	// visually clean at the 640-960px display sizes used by the UI.
	draw.ApproxBiLinear.Scale(target, target.Bounds(), decoded, bounds, draw.Over, nil)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, target, &jpeg.Options{Quality: 84}); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
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
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".ogg", ".oga":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	}
	return ""
}
