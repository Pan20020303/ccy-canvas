package application

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
