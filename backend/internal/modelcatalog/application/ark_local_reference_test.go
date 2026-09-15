package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

func writeArkTestImage(t *testing.T, root, name string, width, height int) {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, name), buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestArkLocalReferencePublicMount(t *testing.T) {
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	t.Setenv("STORAGE_BACKEND", "local")
	t.Setenv("AUTH_FRONTEND_BASE_URL", "https://canvas.example/ccy/")
	writeArkTestImage(t, root, "picture.png", 400, 600)
	got, err := arkReferenceImageURL(context.Background(), "/uploads/picture.png")
	if err != nil || got != "https://canvas.example/ccy/uploads/picture.png" {
		t.Fatalf("local reference = %q, %v", got, err)
	}
	for _, raw := range []string{"/uploads/../.env", "/uploads/%2e%2e/secret", "/uploads/%252e%252e/secret", "/uploads/a\\..\\secret", "/uploads/picture.png?x=1", "/uploads/picture.png#secret", "/uploads//picture.png"} {
		if _, err := arkReferenceImageURL(context.Background(), raw); err == nil {
			t.Errorf("accepted invalid reference %q", raw)
		}
	}
	for _, base := range []string{"", "file:///uploads", "https://user:secret@canvas.example", "https://canvas.example?x=1"} {
		t.Setenv("AUTH_FRONTEND_BASE_URL", base)
		if _, err := arkReferenceImageURL(context.Background(), "/uploads/picture.png"); err == nil {
			t.Errorf("accepted invalid public base %q", base)
		}
	}
}

func TestArkLocalReferenceErrorsAreSafe(t *testing.T) {
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	_, err := arkReferenceImageURL(context.Background(), "/uploads/missing.png")
	message := apperror.PublicMessage(arkReferenceInputError("参考图 #1 ", err))
	if !strings.Contains(message, "不存在") || strings.Contains(message, root) {
		t.Fatalf("missing-file public message = %q", message)
	}
	if err := os.WriteFile(filepath.Join(root, "broken.png"), []byte("not an image"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = arkReferenceImageURL(context.Background(), "/uploads/broken.png")
	if !strings.Contains(apperror.PublicMessage(err), "损坏") {
		t.Fatalf("invalid image error = %v", err)
	}
	message = apperror.PublicMessage(arkReferenceInputError("参考图 #1 ", fmt.Errorf("secret-key /private/server/path")))
	if strings.Contains(message, "secret") || strings.Contains(message, "/private") {
		t.Fatalf("private error leaked: %s", message)
	}
}

// The production store is intentionally a singleton. Run the OSS scenario in
// a fresh test process so other tests' local store cannot influence it.
func TestArkOSSReferenceWorkflow(t *testing.T) {
	if os.Getenv("CCY_TEST_ARK_OSS_CHILD") != "1" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(exe, "-test.run=^TestArkOSSReferenceWorkflow$", "-test.v")
		cmd.Env = append(os.Environ(), "CCY_TEST_ARK_OSS_CHILD=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("isolated OSS test: %v\n%s", err, output)
		}
		return
	}
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	root := t.TempDir()
	t.Setenv("UPLOAD_DIR", root)
	writeArkTestImage(t, root, "picture.png", 400, 600)
	writeArkTestImage(t, root, "small.png", 150, 200)
	var mu sync.Mutex
	objects := map[string][]byte{}
	puts := 0
	objectServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			puts++
			data, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = data
			w.Header().Set("ETag", `"test"`)
		case http.MethodHead:
			data, ok := objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			w.Header().Set("ETag", `"test"`)
		case http.MethodGet:
			if r.URL.Query().Get("x-oss-signature") == "" {
				t.Error("OSS GET missing signature")
			}
			data, ok := objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(data)
		default:
			t.Errorf("unexpected OSS method: %s", r.Method)
			w.WriteHeader(400)
		}
	}))
	defer objectServer.Close()
	for key, value := range map[string]string{
		"STORAGE_BACKEND": "oss", "OSS_BUCKET": "test-assets", "OSS_REGION": "cn-beijing",
		"OSS_ACCESS_KEY_ID": "test-key", "OSS_ACCESS_KEY_SECRET": "test-secret",
		"OSS_ENDPOINT": objectServer.URL, "OSS_PUBLIC_BASE_URL": objectServer.URL + "/test-assets",
		"OSS_KEY_PREFIX": "ccy-canvas", "COS_BUCKET": "",
	} {
		t.Setenv(key, value)
	}
	for _, name := range []string{"picture.png", "small.png"} {
		got, err := arkReferenceImageURL(context.Background(), "/uploads/"+name)
		if err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(got)
		if err != nil || u.Query().Get("x-oss-signature") == "" || !strings.Contains(u.Path, "/ccy-canvas/") {
			t.Fatal("expected signed OSS reference URL")
		}
		data, err := fetchRemoteReferenceBytes(context.Background(), got)
		if err != nil {
			t.Fatal(err)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || cfg.Width < 300 || cfg.Height < 300 {
			t.Fatalf("noncompliant normalized image: %+v, %v", cfg, err)
		}
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Fatal("original image must remain available", err)
		}
	}
	mu.Lock()
	initialPuts := puts
	mu.Unlock()
	var submitted map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/contents/generations/tasks" {
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Error(err)
			}
			w.Write([]byte(`{"id":"ark-test-1"}`))
		} else if r.Method == http.MethodGet && r.URL.Path == "/contents/generations/tasks/ark-test-1" {
			w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/final.mp4"}}`))
		} else {
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	svc := &Service{}
	result, err := svc.generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark", BaseURL: provider.URL}, provider.URL, "test-key", GenerateRequest{
		Model: "doubao-seedance-2-0-260128", Prompt: "Animate the reference", Duration: 5,
		AspectRatio: "9:16", Resolution: "720p", ReferenceMode: "start_end", ReferenceImages: []string{"/uploads/picture.png"},
	})
	if err != nil || result.Content != "https://example.com/final.mp4" {
		t.Fatalf("Ark submit/poll failed: %+v %v", result, err)
	}
	content := submitted["content"].([]any)
	ref := content[1].(map[string]any)
	refURL := ref["image_url"].(map[string]any)["url"].(string)
	if ref["role"] != "first_frame" || !strings.Contains(refURL, "x-oss-signature=") {
		t.Fatal("Ark must receive first_frame with a signed OSS URL")
	}
	mu.Lock()
	defer mu.Unlock()
	if puts != initialPuts {
		t.Fatal("unchanged OSS reference was uploaded again")
	}
}
