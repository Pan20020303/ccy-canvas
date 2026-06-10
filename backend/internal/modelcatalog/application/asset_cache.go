package application

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// PersistRemoteAsset downloads a generated asset from an upstream URL and
// writes it under uploads/generated/{yyyy-mm}/{uuid}.{ext}, returning a
// stable backend-served path (/uploads/generated/...).
//
// Why server-side: upstream URLs from OpenAI/Volcengine/Sora-style relays
// frequently expire (signed URLs valid for hours-to-days, or relay-host
// proxies that disappear). The legacy client-side persist (proxy → upload
// → local URL) only ran when the browser was alive at the moment the
// generation returned. Doing it here covers EVERY completion path —
// inline-success, SSE push, recovery poller — so by the time anyone sees
// the result_url it already points to a file we own.
//
// Best-effort: failures here return the original URL unchanged so the
// node still has *something* renderable; an admin can chase the missing
// local file later via the generation_attempts trail.
//
// Skips data:/blob: URIs (already inline) and same-origin /uploads/
// paths (already ours). Only http(s) external URLs are downloaded.
func PersistRemoteAsset(ctx context.Context, remoteURL string) (string, error) {
	trimmed := strings.TrimSpace(remoteURL)
	if trimmed == "" {
		return remoteURL, nil
	}
	// data: URIs come from relays that return base64 inline (e.g. RelayBases
	// gpt-image-2 ships `data[0].b64_json`, which our parser wraps as
	// `data:image/png;base64,...`). Decode and write to disk so we don't
	// store multi-MB base64 blobs in generation_logs.result_url or push
	// huge SSE frames at the browser.
	if strings.HasPrefix(trimmed, "data:") {
		return persistDataURI(trimmed)
	}
	// blob: URLs are browser-only — there's nothing we can fetch server-side.
	if strings.HasPrefix(trimmed, "blob:") {
		return remoteURL, nil
	}
	// Already same-origin static asset (this server's /uploads/...) —
	// no point re-downloading our own file.
	if strings.HasPrefix(trimmed, "/uploads/") {
		return remoteURL, nil
	}
	// Only handle absolute http(s) URLs.
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return remoteURL, nil
	}

	// Bound the download itself so a hung upstream can't pin the
	// detached goroutine forever. 60s covers reasonable image/video
	// downloads (~50 MB at conservative bandwidth).
	dlCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, trimmed, nil)
	if err != nil {
		return remoteURL, err
	}
	resp, err := assetCacheHTTPClient.Do(req)
	if err != nil {
		return remoteURL, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return remoteURL, fmt.Errorf("upstream returned HTTP %d while caching asset", resp.StatusCode)
	}

	ext := extensionFor(trimmed, resp.Header.Get("Content-Type"))

	// One subdir per month keeps the directory small (filesystems get
	// unhappy with 100k+ entries in a single dir). Same scheme as the
	// existing user upload handler in workspace/interfaces/upload_handler.go.
	dateDir := time.Now().Format("2006-01")
	dir := filepath.Join("uploads", "generated", dateDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return remoteURL, err
	}

	filename := uuid.New().String() + ext
	diskPath := filepath.Join(dir, filename)

	// Cap the disk write to a generous ceiling so a misbehaving upstream
	// streaming a multi-GB file can't fill our disk on a single request.
	const maxBytes = 200 * 1024 * 1024 // 200 MB
	dst, err := os.Create(diskPath)
	if err != nil {
		return remoteURL, err
	}
	written, copyErr := io.Copy(dst, io.LimitReader(resp.Body, maxBytes))
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		// Don't leave a half-written file on disk.
		_ = os.Remove(diskPath)
		if copyErr != nil {
			return remoteURL, copyErr
		}
		return remoteURL, closeErr
	}
	if written == 0 {
		_ = os.Remove(diskPath)
		return remoteURL, fmt.Errorf("upstream asset was empty")
	}

	return fmt.Sprintf("/uploads/generated/%s/%s", dateDir, filename), nil
}

// persistDataURI decodes a `data:<mime>;base64,<payload>` URI to bytes
// and writes them to uploads/generated/{yyyy-mm}/{uuid}.{ext}. Same
// disk layout as PersistRemoteAsset so the static handler serves both
// identically. Returns the local /uploads/... path on success; on any
// parse / decode / write failure returns the original URI so the
// caller can still surface SOMETHING renderable to the user.
func persistDataURI(uri string) (string, error) {
	// Expected: data:<mime>;base64,<base64data>
	const prefix = "data:"
	if !strings.HasPrefix(uri, prefix) {
		return uri, fmt.Errorf("not a data URI")
	}
	commaIdx := strings.IndexByte(uri, ',')
	if commaIdx <= len(prefix) {
		return uri, fmt.Errorf("malformed data URI: missing payload")
	}
	header := uri[len(prefix):commaIdx]
	payload := uri[commaIdx+1:]
	// header looks like `image/png;base64` (or `image/png` w/o base64).
	mimeType := header
	isBase64 := false
	if idx := strings.IndexByte(header, ';'); idx >= 0 {
		mimeType = header[:idx]
		for _, attr := range strings.Split(header[idx+1:], ";") {
			if strings.EqualFold(strings.TrimSpace(attr), "base64") {
				isBase64 = true
			}
		}
	}

	var bytes []byte
	if isBase64 {
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			// Some clients drop padding — try the URL-safe variant.
			decoded, err = base64.RawStdEncoding.DecodeString(payload)
			if err != nil {
				return uri, err
			}
		}
		bytes = decoded
	} else {
		// Plain text payload — URL-decode and use as-is.
		unescaped, err := url.QueryUnescape(payload)
		if err != nil {
			return uri, err
		}
		bytes = []byte(unescaped)
	}

	if len(bytes) == 0 {
		return uri, fmt.Errorf("decoded data URI was empty")
	}

	ext := extensionFor("", mimeType)
	dateDir := time.Now().Format("2006-01")
	dir := filepath.Join("uploads", "generated", dateDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return uri, err
	}
	filename := uuid.New().String() + ext
	diskPath := filepath.Join(dir, filename)
	if err := os.WriteFile(diskPath, bytes, 0o644); err != nil {
		return uri, err
	}
	return fmt.Sprintf("/uploads/generated/%s/%s", dateDir, filename), nil
}

// extensionFor picks the best file extension we can derive from the
// upstream URL and Content-Type. URL path wins when present (some
// providers serve all media as application/octet-stream); Content-Type
// fills in the gap when the URL has none (signed S3-style URLs often
// drop the suffix). Defaults to .bin if neither helps.
func extensionFor(urlStr, contentType string) string {
	if u, err := url.Parse(urlStr); err == nil {
		if ext := strings.ToLower(filepath.Ext(u.Path)); ext != "" && len(ext) <= 6 {
			return ext
		}
	}
	if contentType != "" {
		mt, _, _ := mime.ParseMediaType(contentType)
		switch mt {
		case "image/png":
			return ".png"
		case "image/jpeg":
			return ".jpg"
		case "image/webp":
			return ".webp"
		case "image/gif":
			return ".gif"
		case "video/mp4":
			return ".mp4"
		case "video/quicktime":
			return ".mov"
		case "video/webm":
			return ".webm"
		case "audio/mpeg":
			return ".mp3"
		case "audio/wav", "audio/x-wav":
			return ".wav"
		case "audio/ogg":
			return ".ogg"
		case "audio/aac":
			return ".aac"
		}
		// Fallback: derive from primary type.
		if strings.HasPrefix(mt, "image/") {
			return ".img"
		}
		if strings.HasPrefix(mt, "video/") {
			return ".vid"
		}
		if strings.HasPrefix(mt, "audio/") {
			return ".aud"
		}
	}
	return ".bin"
}

// assetCacheHTTPClient is a dedicated client so we don't reach into the
// channel-routing provider client (which carries auth headers / proxies
// for upstream model APIs). The asset URLs returned by those APIs are
// typically public CDN links — a vanilla client is fine.
var assetCacheHTTPClient = &http.Client{
	Timeout: 70 * time.Second, // slightly above the per-request ctx deadline
}
