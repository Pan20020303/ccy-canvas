package interfaces

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"testing"

	"ccy-canvas/backend/internal/platform/session"

	"github.com/go-chi/chi/v5"
)

func TestUploadReturnsStandardEnvelopeShape(t *testing.T) {
	tempDir := t.TempDir()
	previousWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(previousWD)
	})

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", `form-data; name="file"; filename="sample.png"`)
	partHeader.Set("Content-Type", "image/png")
	fileWriter, err := writer.CreatePart(partHeader)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fileWriter.Write([]byte("fake-image-content")); err != nil {
		t.Fatalf("write file content: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	manager := session.NewManager("01234567890123456789012345678901", false)
	cookie, err := manager.NewCookie("user-1", "member")
	if err != nil {
		t.Fatalf("new cookie: %v", err)
	}

	router := chi.NewRouter()
	RegisterUploadRoutes(router, manager)

	req := httptest.NewRequest(http.MethodPost, "/api/app/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(cookie)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		Data struct {
			URL         string `json:"url"`
			Filename    string `json:"filename"`
			ContentType string `json:"content_type"`
		} `json:"data"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if response.Data.URL == "" {
		t.Fatalf("expected data.url, got body %s", recorder.Body.String())
	}
	if response.Data.Filename != "sample.png" {
		t.Fatalf("filename = %q, want sample.png", response.Data.Filename)
	}
	if len(response.Data.URL) < len("/uploads/") || response.Data.URL[:9] != "/uploads/" {
		t.Fatalf("url = %q, want /uploads/... path", response.Data.URL)
	}
}
