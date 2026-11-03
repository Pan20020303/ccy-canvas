package application

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStageRemoteAssetRetriesTruncatedBody(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	const complete = "complete paid video bytes"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodGet {
			t.Error("must only download existing result")
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", fmt.Sprint(len(complete)))
		if calls == 1 {
			fmt.Fprint(w, "partial")
			return
		}
		fmt.Fprint(w, complete)
	}))
	defer server.Close()
	staged, err := StageRemoteAsset(context.Background(), server.URL+"/video.mp4")
	if err != nil || calls != 2 {
		t.Fatalf("attempts=%d err=%v", calls, err)
	}
	body, err := os.ReadFile(staged.LocalPath)
	if err != nil || string(body) != complete {
		t.Fatalf("incomplete staged file: %q %v", body, err)
	}
	files := 0
	filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			files++
		}
		return err
	})
	if files != 1 {
		t.Fatalf("partial downloads were not removed: %d files", files)
	}
}

func TestStageRemoteAssetReadRetryBound(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	t.Setenv("UPLOAD_DIR", t.TempDir())
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Length", "100")
		fmt.Fprint(w, "partial")
	}))
	defer server.Close()
	staged, err := StageRemoteAsset(context.Background(), server.URL+"/video.mp4")
	if err == nil || calls != 3 || staged.LocalPath != "" {
		t.Fatalf("attempts=%d staged=%+v err=%v", calls, staged, err)
	}
}

func TestAssetReadRetryDoesNotRetryDiskFailures(t *testing.T) {
	if retryableAssetReadError(&os.PathError{Op: "write", Path: "local", Err: io.ErrUnexpectedEOF}) {
		t.Fatal("local disk failures are not retryable")
	}
	if !retryableAssetReadError(context.DeadlineExceeded) {
		t.Fatal("download timeout must retry")
	}
}

func TestExtensionFor(t *testing.T) {
	cases := []struct {
		name  string
		url   string
		ctype string
		want  string
	}{
		// URL path wins when it has a recognizable suffix.
		{"png from url", "https://cdn.x/abc.png?token=z", "application/octet-stream", ".png"},
		{"mp4 from url", "https://cdn.x/clip.mp4", "", ".mp4"},
		{"jpg from url with query", "https://cdn.x/img.JPG?sig=1", "", ".jpg"},

		// Content-Type fills in when URL has no extension (signed S3-style).
		{"content-type png", "https://cdn.x/12345?signature=zz", "image/png", ".png"},
		{"content-type mp4 with charset", "https://cdn.x/v/abc", "video/mp4; codecs=avc1", ".mp4"},
		{"content-type webp", "https://cdn.x/v/abc", "image/webp", ".webp"},
		{"content-type wav alt", "https://cdn.x/v/abc", "audio/x-wav", ".wav"},

		// Unknown content-type but known primary type falls back to category placeholder.
		{"unknown image subtype", "https://cdn.x/v/abc", "image/heif", ".img"},
		{"unknown video subtype", "https://cdn.x/v/abc", "video/x-matroska", ".vid"},

		// Nothing at all — final fallback.
		{"no hints", "https://cdn.x/v/abc", "", ".bin"},
		{"empty url + ctype", "", "", ".bin"},

		// Path with overlong suffix (e.g. /file.somethinglong?...) gets discarded
		// so it never trumps content-type parsing.
		{"overlong path suffix falls back to ctype", "https://cdn.x/file.something/abc", "image/png", ".png"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extensionFor(tc.url, tc.ctype); got != tc.want {
				t.Errorf("extensionFor(%q, %q) = %q, want %q", tc.url, tc.ctype, got, tc.want)
			}
		})
	}
}

func TestPersistRemoteAssetUsesBrowserLikeHeaders(t *testing.T) {
	// stageRemoteAsset now dials via safehttp, which blocks loopback by default;
	// httptest serves from 127.0.0.1, so open the documented test escape hatch.
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	const body = "stable image bytes"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("User-Agent"), "Mozilla/5.0") {
			http.Error(w, "missing browser user agent", http.StatusForbidden)
			return
		}
		if !strings.Contains(r.Header.Get("Accept"), "image/") {
			http.Error(w, "missing media accept header", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	got, err := PersistRemoteAsset(context.Background(), server.URL+"/signed-result?X-Tos-Expires=86400")
	if err != nil {
		t.Fatalf("PersistRemoteAsset returned error: %v", err)
	}
	if !strings.HasPrefix(got, "/uploads/generated/") || !strings.HasSuffix(got, ".png") {
		t.Fatalf("PersistRemoteAsset returned %q, want /uploads/generated/...png", got)
	}
}

func TestAssetURLMatchesProviderHostAllowsKnownProviderSiblingDomains(t *testing.T) {
	if !assetURLMatchesProviderHost("https://assets.relaybases.com/generated/result.png", "https://image-2.relaybases.com") {
		t.Fatal("expected RelayBases sibling asset host to match provider host")
	}
}

func TestAssetURLMatchesProviderHostRejectsUnknownSiblingDomains(t *testing.T) {
	if assetURLMatchesProviderHost("https://assets.example.com/generated/result.png", "https://api.example.com") {
		t.Fatal("expected unknown sibling asset host to be rejected")
	}
}

func TestValidateGeneratedAssetRejectsTaskJSONEvenWhenDeclaredAsImage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay-result.png")
	if err := os.WriteFile(path, []byte(`{"status":"processing","task_id":"task-123"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	err := validateGeneratedAsset(StagedAsset{
		LocalPath:   path,
		ContentType: "image/png",
	}, "image")
	if err == nil || !strings.Contains(err.Error(), "JSON/HTML") {
		t.Fatalf("validateGeneratedAsset error = %v, want JSON/HTML rejection", err)
	}
}
