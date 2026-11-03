package adminsystem

import (
	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/platform/authn"
	crypt "ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type memoryStorage struct {
	mu   sync.Mutex
	row  storageRecord
	fail bool
}

func (r *memoryStorage) Read(context.Context) (storageRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.row, nil
}
func (r *memoryStorage) Write(_ context.Context, revision int64, value string) (storageRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return storageRecord{}, errors.New("private database detail")
	}
	if revision != r.row.Revision {
		return storageRecord{}, ErrConflict
	}
	r.row = storageRecord{revision + 1, value, time.Now()}
	return r.row, nil
}
func managerForTest(t *testing.T) (*StorageManager, *memoryStorage) {
	t.Helper()
	t.Setenv("STORAGE_BACKEND", "local")
	for _, name := range []string{"OSS_BUCKET", "OSS_REGION", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY"} {
		t.Setenv(name, "")
	}
	r := &memoryStorage{}
	return &StorageManager{repo: r, key: []byte(strings.Repeat("k", 32))}, r
}
func validCloud() *CloudInput {
	return &CloudInput{Bucket: "media-test", Region: "cn-beijing", AccessKeyID: "test-access-id", AccessKeySecret: "test-super-secret"}
}
func TestStorageEncryptionRedactionAndBlankPreservation(t *testing.T) {
	m, r := managerForTest(t)
	ctx := context.Background()
	v, err := m.Save(ctx, StorageInput{Backend: "oss", Cloud: validCloud()})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.row.Encrypted, "test-super-secret") {
		t.Fatal("plaintext persisted")
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "test-access-id") || strings.Contains(string(b), "test-super-secret") {
		t.Fatal("credential echoed")
	}
	if !v.OSS.HasAccessKeySecret || v.Revision != 1 {
		t.Fatal("missing safe state")
	}
	c := validCloud()
	c.AccessKeyID = ""
	c.AccessKeySecret = ""
	c.KeyPrefix = "new-media"
	_, err = m.Save(ctx, StorageInput{Backend: "oss", Revision: 1, Cloud: c})
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Config.OSS.AccessKeySecret != "test-super-secret" {
		t.Fatal("blank input erased secret")
	}
	plain, err := crypt.Decrypt(m.key, r.row.Encrypted)
	if err != nil || !strings.Contains(plain, "new-media") {
		t.Fatal("encrypted snapshot did not round-trip")
	}
}
func TestStorageConflictInvalidAndFailedSaveDoNotActivate(t *testing.T) {
	m, r := managerForTest(t)
	ctx := context.Background()
	_, err := m.Save(ctx, StorageInput{Backend: "local"})
	if err != nil {
		t.Fatal(err)
	}
	active, _ := assetstore.Default()
	_, err = m.Save(ctx, StorageInput{Backend: "oss", Cloud: validCloud()})
	if !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision accepted")
	}
	bad := validCloud()
	bad.Endpoint = "https://example.org"
	_, err = m.Save(ctx, StorageInput{Revision: 1, Backend: "oss", Cloud: bad})
	if err == nil {
		t.Fatal("untrusted endpoint accepted")
	}
	r.fail = true
	_, err = m.Save(ctx, StorageInput{Revision: 1, Backend: "oss", Cloud: validCloud()})
	if err == nil || strings.Contains(err.Error(), "private database") {
		t.Fatal("unsafe persistence error")
	}
	now, _ := assetstore.Default()
	if now != active || r.row.Revision != 1 {
		t.Fatal("failed save changed runtime or database")
	}
}
func TestStorageRestartAndOldBucketSigning(t *testing.T) {
	m, r := managerForTest(t)
	ctx := context.Background()
	_, err := m.Save(ctx, StorageInput{Backend: "oss", Cloud: validCloud()})
	if err != nil {
		t.Fatal(err)
	}
	c := validCloud()
	c.Bucket = "new-media-bucket"
	_, err = m.Save(ctx, StorageInput{Revision: 1, Backend: "oss", Cloud: c})
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.Save(ctx, StorageInput{Revision: 2, Backend: "local"})
	if err != nil {
		t.Fatal(err)
	}
	restarted := &StorageManager{repo: r, key: m.key}
	if err = restarted.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	for _, bucket := range []string{"media-test", "new-media-bucket"} {
		signed, err := assetstore.PresignGet(ctx, "https://"+bucket+".oss-cn-beijing.aliyuncs.com/image.png", time.Minute)
		if err != nil || signed == "" || !strings.Contains(strings.ToLower(signed), "signature") {
			t.Fatal("historical reader lost")
		}
	}
}
func TestStorageBadEncryptionKeyDoesNotOverwrite(t *testing.T) {
	m, r := managerForTest(t)
	ctx := context.Background()
	_, err := m.Save(ctx, StorageInput{Backend: "local"})
	if err != nil {
		t.Fatal(err)
	}
	wrong := &StorageManager{repo: r, key: []byte(strings.Repeat("x", 32))}
	if _, err = wrong.View(ctx); err == nil {
		t.Fatal("decryption failed open")
	}
	if _, err = wrong.Save(ctx, StorageInput{Backend: "local", Revision: 1}); err == nil || r.row.Revision != 1 {
		t.Fatal("corrupt config overwritten")
	}
}
func TestAdminSystemRoutesRequireAdmin(t *testing.T) {
	m, _ := managerForTest(t)
	router := chi.NewMux()
	api := httpapi.New(router)
	sessions := session.NewManager(strings.Repeat("s", 32), false)
	api.UseMiddleware(authn.Middleware(api, sessions))
	NewHandler(m).RegisterRoutes(api)
	for _, path := range []string{"/api/admin/storage", "/api/admin/system/resources"} {
		for _, role := range []string{"", "member", "admin"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			if role != "" {
				cookie, _ := sessions.NewCookie("user-id", role)
				req.AddCookie(cookie)
			}
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)
			want := 200
			if role == "" {
				want = 401
			} else if role == "member" {
				want = 403
			}
			if rr.Code != want {
				t.Fatalf("%s %s: got %d want %d: %s", role, path, rr.Code, want, rr.Body.String())
			}
			if role == "admin" && rr.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("admin data cacheable")
			}
		}
	}
	for _, role := range []string{"", "member"} {
		req := httptest.NewRequest(http.MethodPut, "/api/admin/storage", strings.NewReader(`{"backend":"local","revision":0}`))
		req.Header.Set("Content-Type", "application/json")
		if role != "" {
			cookie, _ := sessions.NewCookie("id", role)
			req.AddCookie(cookie)
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		if rr.Code != 401 && rr.Code != 403 {
			t.Fatal("unauthorized storage write")
		}
	}
}
func TestRealResourceSamplingAndCache(t *testing.T) {
	m := NewMetrics()
	s := m.Snapshot(context.Background())
	if s.CPUCores < 1 || s.HeapBytes == 0 || s.SampledAt.IsZero() || s.OS == "" {
		t.Fatal("missing runtime metrics")
	}
	if s.CPUPercent != nil && (*s.CPUPercent < 0 || *s.CPUPercent > 100) {
		t.Fatal("invalid CPU percentage")
	}
	for _, usage := range []*Usage{s.Memory, s.Disk} {
		if usage != nil && (usage.Total == 0 || usage.Percent < 0 || usage.Percent > 100) {
			t.Fatal("invalid system usage")
		}
	}
	if !m.Snapshot(context.Background()).SampledAt.Equal(s.SampledAt) {
		t.Fatal("metrics cache not shared")
	}
}
