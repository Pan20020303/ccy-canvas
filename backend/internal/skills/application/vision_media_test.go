package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func visionTestPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestVisionMediaLocalUploadConfinement(t *testing.T) {
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	raw := visionTestPNG(t)
	if err := os.WriteFile(filepath.Join(root, "safe.png"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	expected := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	for _, source := range []string{
		"/uploads/safe.png", "http://127.0.0.1/uploads/safe.png", "http://localhost:80/uploads/safe.png",
		"/api/app/proxy-media?url=%2Fuploads%2Fsafe.png", "http://127.0.0.1/api/app/proxy-media?url=%2Fuploads%2Fsafe.png",
	} {
		actual, err := fetchImageAsDataURL(context.Background(), source)
		if err != nil || actual != expected {
			t.Fatalf("valid own upload %s failed: %v", source, err)
		}
	}
	for _, source := range []string{
		"/uploads/../outside.png", "/uploads/%2e%2e/outside.png", "/uploads/sub/%2e%2e/safe.png",
		"/uploads/safe.png:secret", "/uploads/C:/safe.png", "/uploads/sub\\safe.png", "/uploads/safe.png.",
		"/uploads//safe.png", "/uploads/%00safe.png", "file:///uploads/safe.png", "C:/Windows/win.ini",
		"http://127.0.0.1/private", "http://127.0.0.1/uploads/../outside.png", "http://192.0.2.42/uploads/safe.png",
	} {
		if strings.Contains(source, "192.0.2.42") {
			// A foreign /uploads path must not map to disk, regardless of whether
			// the URL happens to be reachable outside this test environment.
			unwrapped, err := unwrapVisionMediaURL(source)
			if err != nil || unwrapped != source {
				t.Fatalf("foreign host mapped to local: %s %v", unwrapped, err)
			}
			continue
		}
		if _, err := fetchImageAsDataURL(context.Background(), source); err == nil {
			t.Errorf("unsafe local path accepted: %s", source)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err == nil {
		if _, err := fetchImageAsDataURL(context.Background(), "/uploads/escape.png"); err == nil {
			t.Fatal("escaping symlink accepted")
		}
	} else {
		t.Logf("host cannot create symlink; lexical/root tests still executed: %v", err)
	}
}

func TestVisionMediaImageContentValidation(t *testing.T) {
	raw := visionTestPNG(t)
	encoded := base64.StdEncoding.EncodeToString(raw)
	for _, source := range []string{
		"data:image/jpeg;base64," + encoded,
		"data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("<html>not an image</html>")),
		"data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)),
		"data:image/png;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(visionImageMaxBytes)+1),
		"data:image/png,unencoded", "data:video/mp4;base64,AAAA", "data:image/png;base64,not-base64",
	} {
		if _, err := fetchImageAsDataURL(context.Background(), source); err == nil {
			t.Errorf("invalid data URL accepted: %.80s", source)
		}
	}
	if _, err := validatedVisionImage([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p'}); err == nil {
		t.Fatal("video container accepted as image")
	}
}

func TestVisionMediaPublicGuardIgnoresLANEscapeHatch(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, raw := range []string{"http://127.0.0.1/private", "http://10.0.0.1/a", "http://192.168.1.2/a", "http://100.64.0.1/a", "http://169.254.169.254/latest/meta-data/", "http://[::1]/a", "file:///secret", "https://user:pass@example.com/a", "http://localhost/a"} {
		if err := validateVisionPublicURL(raw); err == nil {
			t.Errorf("unsafe public URL accepted: %s", raw)
		}
	}
	client := visionMediaHTTPClient(time.Second)
	for _, raw := range []string{"http://127.0.0.1/private", "http://10.0.0.2/a"} {
		parsed, _ := url.Parse(raw)
		if err := client.CheckRedirect(&http.Request{URL: parsed}, nil); err == nil {
			t.Errorf("unsafe redirect accepted: %s", raw)
		}
	}
	transport := client.Transport.(*http.Transport)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if connection, err := transport.DialContext(ctx, "tcp", "localhost:80"); err == nil {
		connection.Close()
		t.Fatal("DNS-resolved loopback was dialed")
	}
	for _, raw := range []string{"0.0.0.0", "::", "ff02::1", "fc00::1", "127.0.0.1", "100.64.2.4"} {
		if !visionBlockedIP(net.ParseIP(raw)) {
			t.Errorf("unsafe IP accepted: %s", raw)
		}
	}
}

type visionTestTransport func(*http.Request) (*http.Response, error)

func (transport visionTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestVisionPublicDownloadBoundsAndMisleadingMIME(t *testing.T) {
	client := &http.Client{Transport: visionTestTransport(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(strings.NewReader("not a real image")), ContentLength: 16, Request: request}, nil
	})}
	if reader, err := openVisionPublicMedia(context.Background(), "https://example.com/fake.png", 8, client); err == nil {
		reader.Close()
		t.Fatal("oversized Content-Length accepted")
	}
	reader, err := openVisionPublicMedia(context.Background(), "https://example.com/fake.png", 1024, client)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(reader)
	reader.Close()
	if _, err := validatedVisionImage(content); err == nil {
		t.Fatal("forged image MIME accepted")
	}
}
