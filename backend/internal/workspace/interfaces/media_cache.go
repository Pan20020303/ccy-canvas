package interfaces

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mediaCache is an OPTIONAL on-disk cache for the media proxy, meant for
// LAN / self-hosted deployments where every image/video is fetched through
// /api/app/proxy-media on the local backend. It is enabled only when
// MEDIA_CACHE_DIR is set — default deployments keep the pure streaming path
// and are byte-for-byte unaffected.
//
// Cached objects are our own assets, keyed by their STABLE public URL (not the
// short-lived presigned URL), and their keys are content-addressed uuids that
// never change — so entries need no invalidation, only size-based eviction
// (LRU by mtime). Range/seek is served from the cached file via
// http.ServeContent.
type mediaCache struct {
	dir     string
	maxSize int64
	evictMu sync.Mutex
}

// newMediaCache returns nil (disabled) unless MEDIA_CACHE_DIR is set.
// MEDIA_CACHE_MAX_BYTES caps total size (default 5 GiB).
func newMediaCache() *mediaCache {
	dir := strings.TrimSpace(os.Getenv("MEDIA_CACHE_DIR"))
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil // can't create → stay disabled rather than crash the route
	}
	max := int64(5) << 30
	if v := strings.TrimSpace(os.Getenv("MEDIA_CACHE_MAX_BYTES")); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			max = n
		}
	}
	return &mediaCache{dir: dir, maxSize: max}
}

func (c *mediaCache) paths(key string) (body, meta string) {
	sum := sha256.Sum256([]byte(key))
	h := hex.EncodeToString(sum[:])
	body = filepath.Join(c.dir, h)
	return body, body + ".ct"
}

// lookup returns the cached body path + content-type, or ok=false on a miss.
func (c *mediaCache) lookup(key string) (bodyPath, contentType string, ok bool) {
	body, meta := c.paths(key)
	fi, err := os.Stat(body)
	if err != nil || fi.Size() == 0 {
		return "", "", false
	}
	ct, err := os.ReadFile(meta)
	if err != nil {
		return "", "", false
	}
	now := time.Now()
	_ = os.Chtimes(body, now, now) // bump for LRU (best-effort)
	return body, strings.TrimSpace(string(ct)), true
}

// store writes the body (atomically via a temp file) plus a content-type
// sidecar, then evicts if the cache is over its size cap. Returns the body path.
func (c *mediaCache) store(key, contentType string, r io.Reader) (string, error) {
	body, meta := c.paths(key)
	tmp := body + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, body); err != nil {
		os.Remove(tmp)
		return "", err
	}
	_ = os.WriteFile(meta, []byte(contentType), 0o644)
	c.evictIfNeeded()
	return body, nil
}

func (c *mediaCache) evictIfNeeded() {
	c.evictMu.Lock()
	defer c.evictMu.Unlock()

	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type ent struct {
		path string
		size int64
		mod  int64
	}
	var files []ent
	var total int64
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasSuffix(name, ".ct") || strings.HasSuffix(name, ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		total += info.Size()
		files = append(files, ent{filepath.Join(c.dir, name), info.Size(), info.ModTime().UnixNano()})
	}
	if total <= c.maxSize {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod < files[j].mod }) // oldest first
	target := c.maxSize * 9 / 10
	for _, f := range files {
		if total <= target {
			break
		}
		os.Remove(f.path)
		os.Remove(f.path + ".ct")
		total -= f.size
	}
}

// serveCachedFile streams a cached body with full Range/seek support and the
// immutable long-cache header (bodies are content-addressed and never change).
func serveCachedFile(w http.ResponseWriter, r *http.Request, path, contentType string) {
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "cache read error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.Error(w, "cache stat error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.Contains(contentType, "svg") {
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Cache-Control", cacheControlOwnObject)
	http.ServeContent(w, r, filepath.Base(path), fi.ModTime(), f)
}

const (
	// Our assets are content-addressed (uuid keys) → safe to cache forever.
	cacheControlOwnObject = "public, max-age=31536000, immutable"
	// Third-party / passthrough URLs may rotate; keep the original 1-day cache.
	cacheControlOther = "public, max-age=86400"
)

// cacheControlFor picks the immutable long cache for our own content-addressed
// assets, and the conservative 1-day cache for anything proxied through.
func cacheControlFor(ourObject bool) string {
	if ourObject {
		return cacheControlOwnObject
	}
	return cacheControlOther
}

// parseThumbWidth reads a clamped thumbnail width from the proxy `w` param.
// 0 means "no resize".
func parseThumbWidth(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 0
	}
	if n > 4096 {
		n = 4096
	}
	return n
}

// isAliyunOSSURL reports whether the URL points at Alibaba Cloud OSS (which
// supports the x-oss-process image pipeline). COS/other hosts do not.
func isAliyunOSSURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(u.Host), "aliyuncs.com")
}

// ossResizeURL appends an OSS image-resize pipeline (WebP, no upscaling) so the
// proxy fetches a small thumbnail variant instead of the multi-MB original.
func ossResizeURL(raw string, width int) string {
	proc := "x-oss-process=image/resize,w_" + strconv.Itoa(width) + ",limit_1/format,webp"
	if strings.Contains(raw, "?") {
		return raw + "&" + proc
	}
	return raw + "?" + proc
}
