package application

import "testing"

func TestExtensionFor(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		ctype   string
		want    string
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
