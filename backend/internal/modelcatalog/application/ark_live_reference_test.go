package application

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

// Opt-in deployment check: transfers exactly one caller-selected reference to
// the configured store, verifies its signed GET and the real Ark serializer.
// The model endpoint is mocked; this NEVER starts a paid video generation.
func TestArkLiveStorageReference(t *testing.T) {
	raw := os.Getenv("CCY_VERIFY_ARK_REFERENCE")
	if raw == "" {
		t.Skip("opt-in deployment storage check")
	}
	if os.Getenv("STORAGE_BACKEND") != "oss" {
		t.Fatal("live verification requires the explicitly configured OSS backend")
	}
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1") // This test process only, for mock Ark.
	verified := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			var body struct {
				Content []struct {
					Type     string `json:"type"`
					Role     string `json:"role"`
					ImageURL struct {
						URL string `json:"url"`
					} `json:"image_url"`
				} `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error("could not decode Ark request")
				w.WriteHeader(400)
				return
			}
			for _, item := range body.Content {
				if item.Type != "image_url" {
					continue
				}
				u, err := url.Parse(item.ImageURL.URL)
				if err != nil || u.Hostname() != os.Getenv("OSS_BUCKET")+".oss-"+os.Getenv("OSS_REGION")+".aliyuncs.com" || u.Query().Get("x-oss-signature") == "" || item.Role != "first_frame" {
					t.Error("Ark input is not the expected signed OSS first frame")
					w.WriteHeader(400)
					return
				}
				data, err := fetchRemoteReferenceBytes(r.Context(), item.ImageURL.URL)
				if err != nil {
					t.Error("signed OSS image could not be downloaded")
					w.WriteHeader(400)
					return
				}
				cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
				if err != nil || cfg.Width < 300 || cfg.Height < 300 {
					t.Error("downloaded OSS image is not valid")
					w.WriteHeader(400)
					return
				}
				t.Logf("Verified signed OSS GET: host=%s bytes=%d dimensions=%dx%d role=%s", u.Hostname(), len(data), cfg.Width, cfg.Height, item.Role)
				verified = true
			}
			w.Write([]byte(`{"id":"storage-verification-only"}`))
		} else {
			w.Write([]byte(`{"status":"succeeded","content":{"video_url":"https://example.com/verification-only"}}`))
		}
	}))
	defer provider.Close()
	svc := &Service{}
	_, err := svc.generateVideoArk(context.Background(), &domain.ProviderConfig{APISpec: "ark", BaseURL: provider.URL}, provider.URL, "mock-only", GenerateRequest{
		Model: "doubao-seedance-2-0-260128", Prompt: "reference transport verification", Duration: 5, AspectRatio: "9:16",
		Resolution: "720p", ReferenceMode: "start_end", ReferenceImages: []string{strings.TrimSpace(raw)},
	})
	if err != nil {
		t.Fatal(apperror.PublicMessage(err))
	}
	if !verified {
		t.Fatal("no reference reached the Ark serializer")
	}
}
