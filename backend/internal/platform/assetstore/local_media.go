package assetstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/singleflight"
)

const (
	maxThumbSourceBytes     = 32 << 20
	maxThumbSourcePixels    = 24_000_000
	maxThumbSourceDimension = 16384
)

var errThumbnailUnavailable = errors.New("thumbnail unavailable")

// LocalMediaHandler serves the existing /uploads/* namespace. Its cache is a
// sibling directory outside that public namespace, never a new public route.
type LocalMediaHandler struct {
	root     string
	cacheDir string
	slots    chan struct{}
	flights  singleflight.Group
	// promotedURL repairs legacy canvas snapshots that still reference the
	// short-lived staging path after the object was moved to cloud storage.
	promotedURL func(string) (string, bool)
}

// NewLocalMediaHandler expects the FULL /uploads/... request path; do not use
// StripPrefix. Empty root follows SaveLocal's default directory. No network
// fetches, background scanning, generation tasks, or database writes occur.
func NewLocalMediaHandler(root string) http.Handler {
	if strings.TrimSpace(root) == "" {
		root = "uploads"
	}
	absolute, err := filepath.Abs(root)
	if err == nil {
		root = absolute
	}
	return &LocalMediaHandler{
		root:        root,
		cacheDir:    filepath.Join(filepath.Dir(root), "."+filepath.Base(root)+"-thumb-cache"),
		slots:       make(chan struct{}, 2),
		promotedURL: promotedStagingURL,
	}
}

type publicURLStore interface {
	PublicURL(string) string
}

func promotedStagingURL(key string) (string, bool) {
	if !strings.HasPrefix(key, "staging/generated/") {
		return "", false
	}
	store, err := Default()
	if err != nil {
		return "", false
	}
	builder, ok := store.(publicURLStore)
	if !ok {
		return "", false
	}
	target := builder.PublicURL(strings.TrimPrefix(key, "staging/"))
	return target, target != ""
}

func localMediaKey(path string) (string, bool) {
	if !strings.HasPrefix(path, "/uploads/") {
		return "", false
	}
	key := strings.TrimPrefix(path, "/uploads/")
	if key == "" || strings.ContainsAny(key, "\\\x00:<>|\"*?") {
		return "", false
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return "", false
		}
	}
	return key, filepath.IsLocal(filepath.FromSlash(key))
}

func thumbnailWidth(raw string) (int, bool) {
	requested, err := strconv.Atoi(raw)
	if err != nil || requested <= 0 {
		return 0, false
	}
	for _, width := range []int{256, 512, 768, 1280} {
		if requested <= width {
			return width, true
		}
	}
	return 1280, true
}

func thumbnailVersion(key string, info os.FileInfo, width int) string {
	// UUID-backed upload names are immutable in normal use. Size and nanosecond
	// modification time also invalidate derivatives if a local file is replaced.
	hash := sha256.Sum256([]byte(fmt.Sprintf("thumb-v1\x00%s\x00%d\x00%d\x00%d", key, info.Size(), info.ModTime().UnixNano(), width)))
	return hex.EncodeToString(hash[:16])
}

func (h *LocalMediaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key, valid := localMediaKey(r.URL.Path)
	if !valid {
		http.NotFound(w, r)
		return
	}
	// os.Root constrains opens against traversal AND escaping symlinks, including
	// a link swapped between path validation and opening (not just lexical checks).
	root, err := os.OpenRoot(h.root)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	source, err := root.Open(filepath.FromSlash(key))
	if err != nil {
		if target, ok := h.promotedURL(key); ok {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, target, http.StatusTemporaryRedirect)
			return
		}
		http.NotFound(w, r)
		return
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if _, requested := r.URL.Query()["w"]; !requested {
		w.Header().Set("Cache-Control", "public, max-age=31536000")
		http.ServeContent(w, r, filepath.Base(key), info.ModTime(), source)
		return
	}
	width, valid := thumbnailWidth(r.URL.Query().Get("w"))
	if !valid {
		http.Error(w, "Invalid thumbnail size", http.StatusBadRequest)
		return
	}
	version := thumbnailVersion(key, info, width)
	if r.URL.Query().Get("v") != version || r.URL.Query().Get("w") != strconv.Itoa(width) {
		next := *r.URL
		query := next.Query()
		query.Set("w", strconv.Itoa(width))
		query.Set("v", version)
		next.RawQuery = query.Encode()
		// This lookup URL must revalidate; only its versioned derivative is immutable.
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, next.String(), http.StatusTemporaryRedirect)
		return
	}
	cachePath := filepath.Join(h.cacheDir, version+".thumb")
	if !h.serveCached(w, r, cachePath, version) {
		result := h.flights.DoChan(version, func() (any, error) {
			if _, err := os.Stat(cachePath); err == nil {
				return nil, nil
			}
			select {
			case h.slots <- struct{}{}:
				defer func() { <-h.slots }()
			default:
				return nil, errThumbnailUnavailable
			}
			return nil, h.buildThumbnail(r.Context(), key, width, version, cachePath)
		})
		select {
		case <-r.Context().Done():
			return
		case completed := <-result:
			if completed.Err == nil && h.serveCached(w, r, cachePath, version) {
				return
			}
		}
		// A format/limit/cache failure is not asset loss. Return the unchanged
		// original through its existing route, and never cache this fallback as an
		// immutable thumbnail. The frontend also supports exact-URL retry.
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Thumbnail-Fallback", "original")
		http.ServeContent(w, r, filepath.Base(key), info.ModTime(), source)
	}
}

func (h *LocalMediaHandler) serveCached(w http.ResponseWriter, r *http.Request, path, version string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return false
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+version+`"`)
	// ServeContent detects the actual PNG/JPEG bytes, independent of source suffix.
	http.ServeContent(w, r, "thumbnail", info.ModTime(), f)
	return true
}

func (h *LocalMediaHandler) buildThumbnail(ctx context.Context, key string, width int, version, cachePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(h.root)
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := root.Open(filepath.FromSlash(key))
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxThumbSourceBytes {
		return errThumbnailUnavailable
	}
	if thumbnailVersion(key, info, width) != version {
		return errThumbnailUnavailable
	}
	// DecodeConfig and Decode must inspect the same bounded bytes even if a
	// local writer replaces the source while this request is in flight.
	payload, err := io.ReadAll(io.LimitReader(f, maxThumbSourceBytes+1))
	if err != nil || len(payload) > maxThumbSourceBytes {
		return errThumbnailUnavailable
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(payload))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return errThumbnailUnavailable
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > maxThumbSourceDimension || config.Height > maxThumbSourceDimension || int64(config.Width)*int64(config.Height) > maxThumbSourcePixels {
		return errThumbnailUnavailable
	}
	orientation := 1
	if format == "jpeg" {
		orientation = jpegOrientation(bytes.NewReader(payload))
	}
	decoded, _, err := image.Decode(bytes.NewReader(payload))
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// DecodeConfig checked allocation bounds before any full image decode.
	var oriented image.Image = decoded
	if orientation != 1 {
		oriented = orientedImage{Image: decoded, orientation: orientation}
	}
	bounds := oriented.Bounds()
	w, height := bounds.Dx(), bounds.Dy()
	if w > width || height > width {
		if w >= height {
			height = max(1, height*width/w)
			w = width
		} else {
			w = max(1, w*width/height)
			height = width
		}
	}
	thumb := image.NewNRGBA(image.Rect(0, 0, w, height))
	draw.ApproxBiLinear.Scale(thumb, thumb.Bounds(), oriented, bounds, draw.Src, nil)
	if err := ctx.Err(); err != nil {
		return err
	}
	// A replaced/changed source must not populate the previous version's cache.
	after, err := root.Stat(filepath.FromSlash(key))
	if err != nil || thumbnailVersion(key, after, width) != version {
		return errThumbnailUnavailable
	}
	if err = os.MkdirAll(h.cacheDir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(h.cacheDir, ".thumb-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if thumb.Opaque() {
		err = jpeg.Encode(temp, thumb, &jpeg.Options{Quality: 82})
	} else {
		err = png.Encode(temp, thumb)
	}
	closeErr := temp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(tempName, cachePath); err != nil {
		// Multiple backend instances may finish the same immutable derivative.
		if stat, existing := os.Stat(cachePath); existing == nil && stat.Size() > 0 {
			return nil
		}
		return err
	}
	return nil
}
