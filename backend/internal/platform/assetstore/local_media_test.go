package assetstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixtureMedia(t *testing.T, name string, width, height int) (string, []byte) {
	t.Helper()
	dir := t.TempDir()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x*11 + y), uint8(y*7 + x), uint8(x * y), 255})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, data.Bytes()
}

func requestMedia(handler http.Handler, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func TestLocalThumbnailVersionedCacheAndOriginalUnchanged(t *testing.T) {
	dir, original := fixtureMedia(t, "photo.png", 1600, 900)
	handler := NewLocalMediaHandler(dir).(*LocalMediaHandler)
	lookup := requestMedia(handler, "/uploads/photo.png?w=640")
	if lookup.Code != 307 || lookup.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("lookup=%d %v", lookup.Code, lookup.Header())
	}
	versioned := lookup.Header().Get("Location")
	if !strings.Contains(versioned, "w=768") || !strings.Contains(versioned, "v=") {
		t.Fatalf("location=%s", versioned)
	}
	preview := requestMedia(handler, versioned)
	if preview.Code != 200 {
		t.Fatalf("preview=%d %s", preview.Code, preview.Body.String())
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(preview.Body.Bytes()))
	if err != nil || config.Width != 768 || config.Height != 432 {
		t.Fatalf("dimensions=%v err=%v", config, err)
	}
	if preview.Body.Len() >= len(original) {
		t.Fatalf("thumbnail bytes=%d, original=%d", preview.Body.Len(), len(original))
	}
	if !strings.Contains(preview.Header().Get("Cache-Control"), "immutable") || preview.Header().Get("ETag") == "" {
		t.Fatal("missing immutable cache headers")
	}
	if preview.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("type=%q", preview.Header().Get("Content-Type"))
	}
	// A cached derivative is still served when both decode slots are occupied.
	handler.slots <- struct{}{}
	handler.slots <- struct{}{}
	cached := requestMedia(handler, versioned)
	<-handler.slots
	<-handler.slots
	if !bytes.Equal(cached.Body.Bytes(), preview.Body.Bytes()) {
		t.Fatal("cache hit changed bytes")
	}
	req := httptest.NewRequest(http.MethodGet, versioned, nil)
	req.Header.Set("If-None-Match", preview.Header().Get("ETag"))
	revalidated := httptest.NewRecorder()
	handler.ServeHTTP(revalidated, req)
	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("conditional=%d", revalidated.Code)
	}
	disk, _ := os.ReadFile(filepath.Join(dir, "photo.png"))
	if sha256.Sum256(disk) != sha256.Sum256(original) {
		t.Fatal("original was modified")
	}
	if !bytes.Equal(requestMedia(handler, "/uploads/photo.png").Body.Bytes(), original) {
		t.Fatal("original route changed")
	}
	if err = os.Chtimes(filepath.Join(dir, "photo.png"), time.Now(), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	newVersion := requestMedia(handler, "/uploads/photo.png?w=768").Header().Get("Location")
	if newVersion == versioned {
		t.Fatal("source version change did not invalidate cache")
	}
}

func TestLocalThumbnailRejectsTraversalAndEscapingSymlinks(t *testing.T) {
	dir, _ := fixtureMedia(t, "photo.png", 4, 4)
	handler := NewLocalMediaHandler(dir)
	for _, path := range []string{"/uploads/../secret.png?w=256", "/uploads/%2e%2e/secret.png?w=256", "/uploads/..%5csecret.png?w=256", "/uploads/C:%5csecret.png?w=256", "/uploads//photo.png?w=256", "/uploads/photo.png:stream?w=256", "/uploads/"} {
		if result := requestMedia(handler, path); result.Code != http.StatusNotFound {
			t.Errorf("%s => %d", path, result.Code)
		}
	}
	outside := filepath.Join(t.TempDir(), "private.png")
	if err := os.WriteFile(outside, []byte("private data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape.png")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if result := requestMedia(handler, "/uploads/escape.png?w=256"); result.Code != http.StatusNotFound {
		t.Fatalf("escaping symlink status=%d", result.Code)
	}
}

func TestLocalThumbnailUnsupportedAndBusyFallBackWithoutCaching(t *testing.T) {
	dir, original := fixtureMedia(t, "photo.png", 80, 40)
	handler := NewLocalMediaHandler(dir).(*LocalMediaHandler)
	if err := os.WriteFile(filepath.Join(dir, "audio.wav"), []byte("RIFF-not-an-image"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"audio.wav", "photo.png"} {
		if name == "photo.png" {
			handler.slots <- struct{}{}
			handler.slots <- struct{}{}
		}
		location := requestMedia(handler, "/uploads/"+name+"?w=256").Header().Get("Location")
		result := requestMedia(handler, location)
		if name == "photo.png" {
			<-handler.slots
			<-handler.slots
			if !bytes.Equal(result.Body.Bytes(), original) {
				t.Fatal("busy fallback changed original")
			}
		}
		if result.Header().Get("X-Thumbnail-Fallback") != "original" || result.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("fallback headers=%v", result.Header())
		}
	}
}

func TestLocalThumbnailCoalescesConcurrentRequestsForOneDerivative(t *testing.T) {
	dir, _ := fixtureMedia(t, "shared.png", 2200, 1400)
	handler := NewLocalMediaHandler(dir).(*LocalMediaHandler)
	location := requestMedia(handler, "/uploads/shared.png?w=768").Header().Get("Location")
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() { defer workers.Done(); <-start; results <- requestMedia(handler, location) }()
	}
	close(start)
	workers.Wait()
	close(results)
	var first []byte
	for response := range results {
		if response.Code != 200 || response.Header().Get("X-Thumbnail-Fallback") != "" {
			t.Fatalf("identical in-flight request was not coalesced: %d %v", response.Code, response.Header())
		}
		if first == nil {
			first = append([]byte(nil), response.Body.Bytes()...)
		}
		if !bytes.Equal(first, response.Body.Bytes()) {
			t.Fatal("same-version responses differ")
		}
	}
	files, err := filepath.Glob(filepath.Join(handler.cacheDir, "*.thumb"))
	if err != nil || len(files) != 1 {
		t.Fatalf("cache files=%v err=%v", files, err)
	}
}

func TestLocalThumbnailDecodeLimitsAndFixedTiers(t *testing.T) {
	for raw, want := range map[string]int{"1": 256, "300": 512, "640": 768, "720": 768, "1280": 1280, "99999": 1280} {
		if width, ok := thumbnailWidth(raw); !ok || width != want {
			t.Fatalf("%s => %d", raw, width)
		}
	}
	for _, raw := range []string{"0", "-1", "abc", "720.5"} {
		if _, ok := thumbnailWidth(raw); ok {
			t.Fatalf("accepted %s", raw)
		}
	}
	dir, original := fixtureMedia(t, "bomb.png", 4, 4)
	// Rewrite a valid PNG IHDR to enormous dimensions; full decode must never run.
	binary.BigEndian.PutUint32(original[16:20], 40000)
	binary.BigEndian.PutUint32(original[20:24], 40000)
	binary.BigEndian.PutUint32(original[29:33], crc32.ChecksumIEEE(original[12:29]))
	if err := os.WriteFile(filepath.Join(dir, "bomb.png"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewLocalMediaHandler(dir).(*LocalMediaHandler)
	location := requestMedia(handler, "/uploads/bomb.png?w=256").Header().Get("Location")
	if response := requestMedia(handler, location); response.Header().Get("X-Thumbnail-Fallback") != "original" {
		t.Fatal("pixel bomb not rejected")
	}
	large, err := os.Create(filepath.Join(dir, "large.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err = large.Truncate(maxThumbSourceBytes + 1); err != nil {
		t.Fatal(err)
	}
	large.Close()
	info, _ := os.Stat(filepath.Join(dir, "large.png"))
	err = handler.buildThumbnail(context.Background(), "large.png", 256, thumbnailVersion("large.png", info, 256), filepath.Join(handler.cacheDir, "test.thumb"))
	if err == nil {
		t.Fatal("oversized source accepted")
	}
}

func TestLocalThumbnailDoesNotUpscaleAndPreservesTransparency(t *testing.T) {
	dir := t.TempDir()
	img := image.NewNRGBA(image.Rect(0, 0, 20, 40))
	img.SetNRGBA(0, 0, color.NRGBA{255, 0, 0, 128})
	f, _ := os.Create(filepath.Join(dir, "alpha.png"))
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()
	handler := NewLocalMediaHandler(dir)
	location := requestMedia(handler, "/uploads/alpha.png?w=1280").Header().Get("Location")
	response := requestMedia(handler, location)
	decoded, _, err := image.Decode(bytes.NewReader(response.Body.Bytes()))
	if err != nil || decoded.Bounds().Dx() != 20 || decoded.Bounds().Dy() != 40 {
		t.Fatalf("bounds/error %v %v", decoded, err)
	}
	_, _, _, alpha := decoded.At(0, 0).RGBA()
	if alpha >= 65535 || alpha == 0 {
		t.Fatalf("alpha=%d", alpha)
	}
}

func TestLocalJPEGOrientationMatchesBrowserAndKeepsOriginal(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, img, nil); err != nil {
		t.Fatal(err)
	}
	// Little-endian TIFF IFD0 with Orientation=6 (90 degrees clockwise).
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	app := append([]byte("Exif\x00\x00"), tiff...)
	withExif := append([]byte{0xff, 0xd8, 0xff, 0xe1, byte((len(app) + 2) >> 8), byte(len(app) + 2)}, app...)
	withExif = append(withExif, encoded.Bytes()[2:]...)
	if orientation := jpegOrientation(bytes.NewReader(withExif)); orientation != 6 {
		t.Fatalf("orientation=%d", orientation)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "portrait.jpg"), withExif, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewLocalMediaHandler(dir)
	location := requestMedia(handler, "/uploads/portrait.jpg?w=256").Header().Get("Location")
	response := requestMedia(handler, location)
	config, _, err := image.DecodeConfig(bytes.NewReader(response.Body.Bytes()))
	if err != nil || config.Width != 20 || config.Height != 40 {
		t.Fatalf("orientation dimensions=%v err=%v", config, err)
	}
	if !bytes.Equal(requestMedia(handler, "/uploads/portrait.jpg").Body.Bytes(), withExif) {
		t.Fatal("EXIF original changed")
	}
}
