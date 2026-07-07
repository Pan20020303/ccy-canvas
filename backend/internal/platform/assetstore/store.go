package assetstore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"github.com/tencentyun/cos-go-sdk-v5"
)

type Store interface {
	Save(ctx context.Context, key string, body io.Reader, contentType string) (string, error)
	UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error)
	// PresignGet returns a short-lived, signed GET URL for an object this store
	// owns (matched by its public base URL), so private objects can be fetched
	// server-side. Returns "" when rawURL isn't one of this store's objects.
	PresignGet(ctx context.Context, rawURL string, expiry time.Duration) (string, error)
}

var (
	defaultOnce  sync.Once
	defaultStore Store
	defaultErr   error
)

func Save(ctx context.Context, key string, body io.Reader, contentType string) (string, error) {
	store, err := Default()
	if err != nil {
		return "", err
	}
	return store.Save(ctx, key, body, contentType)
}

func UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error) {
	store, err := Default()
	if err != nil {
		return "", err
	}
	return store.UploadFile(ctx, key, localPath, contentType)
}

func PresignGet(ctx context.Context, rawURL string, expiry time.Duration) (string, error) {
	store, err := Default()
	if err != nil {
		return "", err
	}
	return store.PresignGet(ctx, rawURL, expiry)
}

func Default() (Store, error) {
	defaultOnce.Do(func() {
		defaultStore, defaultErr = fromEnv()
	})
	return defaultStore, defaultErr
}

func fromEnv() (Store, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	if backend == "" || backend == "local" {
		return localStore{root: envOrDefault("UPLOAD_DIR", "uploads")}, nil
	}
	if backend == "oss" {
		return newOSSStore()
	}
	if backend != "cos" {
		return nil, fmt.Errorf("unsupported STORAGE_BACKEND %q", backend)
	}

	bucket := strings.TrimSpace(os.Getenv("COS_BUCKET"))
	region := strings.TrimSpace(os.Getenv("COS_REGION"))
	secretID := strings.TrimSpace(os.Getenv("COS_SECRET_ID"))
	secretKey := strings.TrimSpace(os.Getenv("COS_SECRET_KEY"))
	if bucket == "" || region == "" || secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("COS storage requires COS_BUCKET, COS_REGION, COS_SECRET_ID, and COS_SECRET_KEY")
	}

	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("COS_ENDPOINT")), "/")
	if endpoint == "" {
		endpoint = fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region)
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse COS_ENDPOINT: %w", err)
	}
	publicBase := strings.TrimRight(strings.TrimSpace(os.Getenv("COS_PUBLIC_BASE_URL")), "/")
	if publicBase == "" {
		publicBase = endpoint
	}

	client := cos.NewClient(&cos.BaseURL{BucketURL: u}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  secretID,
			SecretKey: secretKey,
		},
	})
	return cosStore{
		client:     client,
		publicBase: publicBase,
		keyPrefix:  cleanObjectKey(os.Getenv("COS_KEY_PREFIX")),
		secretID:   secretID,
		secretKey:  secretKey,
	}, nil
}

type localStore struct {
	root string
}

func (s localStore) Save(_ context.Context, key string, body io.Reader, _ string) (string, error) {
	key = cleanObjectKey(key)
	if key == "" {
		return "", fmt.Errorf("empty asset key")
	}
	diskPath := filepath.Join(s.root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(diskPath), 0o755); err != nil {
		return "", err
	}
	dst, err := os.Create(diskPath)
	if err != nil {
		return "", err
	}
	written, copyErr := io.Copy(dst, body)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(diskPath)
		if copyErr != nil {
			return "", copyErr
		}
		return "", closeErr
	}
	if written == 0 {
		_ = os.Remove(diskPath)
		return "", fmt.Errorf("asset body was empty")
	}
	return "/uploads/" + key, nil
}

func (s localStore) UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return s.Save(ctx, key, file, contentType)
}

// PresignGet is a no-op for local storage: objects are served by the app's own
// /uploads route, so there's nothing to sign.
func (s localStore) PresignGet(_ context.Context, _ string, _ time.Duration) (string, error) {
	return "", nil
}

type cosStore struct {
	client     *cos.Client
	publicBase string
	keyPrefix  string
	secretID   string
	secretKey  string
}

func (s cosStore) PresignGet(ctx context.Context, rawURL string, expiry time.Duration) (string, error) {
	prefix := s.publicBase + "/"
	if s.publicBase == "" || !strings.HasPrefix(rawURL, prefix) {
		return "", nil // not one of our objects — caller fetches it directly
	}
	key := strings.TrimPrefix(rawURL, prefix)
	if i := strings.IndexAny(key, "?#"); i >= 0 {
		key = key[:i]
	}
	if key == "" {
		return "", nil
	}
	u, err := s.client.Object.GetPresignedURL(ctx, http.MethodGet, key, s.secretID, s.secretKey, expiry, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s cosStore) Save(ctx context.Context, key string, body io.Reader, contentType string) (string, error) {
	key = cleanObjectKey(key)
	if key == "" {
		return "", fmt.Errorf("empty asset key")
	}
	if s.keyPrefix != "" {
		key = s.keyPrefix + "/" + key
	}
	opt := &cos.ObjectPutOptions{
		// Assets are served via public URLs (publicBase), so each object must be
		// publicly readable. Without this they inherit the bucket's (private)
		// default ACL and every generated/uploaded asset 403s on GET.
		ACLHeaderOptions: &cos.ACLHeaderOptions{XCosACL: "public-read"},
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType:  contentType,
			CacheControl: "public, max-age=31536000",
		},
	}
	if _, err := s.client.Object.Put(ctx, key, body, opt); err != nil {
		return "", err
	}
	return s.publicBase + "/" + key, nil
}

func (s cosStore) UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error) {
	key = cleanObjectKey(key)
	if key == "" {
		return "", fmt.Errorf("empty asset key")
	}
	if s.keyPrefix != "" {
		key = s.keyPrefix + "/" + key
	}
	opt := &cos.MultiUploadOptions{
		PartSize:       16,
		ThreadPoolSize: 3,
		CheckPoint:     true,
		OptIni: &cos.InitiateMultipartUploadOptions{
			// Publicly readable — see the note in Save(). Generated videos use
			// the multipart path, so they need the same ACL or they 403.
			ACLHeaderOptions: &cos.ACLHeaderOptions{XCosACL: "public-read"},
			ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
				ContentType:        contentType,
				CacheControl:       "public, max-age=31536000",
				ContentDisposition: "inline",
				XCosMetaXXX: &http.Header{
					"x-cos-meta-source": []string{"ccy-canvas-generated"},
				},
			},
		},
	}
	_, _, err := s.client.Object.Upload(ctx, key, localPath, opt)
	if err != nil {
		return "", err
	}
	_ = os.Remove(localPath + ".cp")
	return s.publicBase + "/" + key, nil
}

// newOSSStore builds an Alibaba Cloud OSS-backed store. Mirrors cosStore's
// contract exactly (public-read objects, long cache, same key layout) so the
// migration is a drop-in backend swap plus a host-prefix URL rewrite.
func newOSSStore() (Store, error) {
	bucket := strings.TrimSpace(os.Getenv("OSS_BUCKET"))
	region := strings.TrimSpace(os.Getenv("OSS_REGION"))
	keyID := strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_ID"))
	keySecret := strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_SECRET"))
	if bucket == "" || region == "" || keyID == "" || keySecret == "" {
		return nil, fmt.Errorf("OSS storage requires OSS_BUCKET, OSS_REGION, OSS_ACCESS_KEY_ID, and OSS_ACCESS_KEY_SECRET")
	}

	// Default public host is the standard virtual-hosted OSS domain. Override
	// OSS_PUBLIC_BASE_URL when serving via a bound custom domain / CDN.
	publicBase := strings.TrimRight(strings.TrimSpace(os.Getenv("OSS_PUBLIC_BASE_URL")), "/")
	if publicBase == "" {
		publicBase = fmt.Sprintf("https://%s.oss-%s.aliyuncs.com", bucket, region)
	}

	cfg := oss.LoadDefaultConfig().
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(keyID, keySecret)).
		WithRegion(region)
	// OSS_ENDPOINT is optional: set it for a custom/internal endpoint, else the
	// SDK derives the public endpoint from the region.
	if endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("OSS_ENDPOINT")), "/"); endpoint != "" {
		cfg = cfg.WithEndpoint(endpoint)
	}

	return ossStore{
		client:     oss.NewClient(cfg),
		bucket:     bucket,
		publicBase: publicBase,
		keyPrefix:  cleanObjectKey(os.Getenv("OSS_KEY_PREFIX")),
	}, nil
}

type ossStore struct {
	client     *oss.Client
	bucket     string
	publicBase string
	keyPrefix  string
}

func (s ossStore) objectKey(key string) (string, error) {
	key = cleanObjectKey(key)
	if key == "" {
		return "", fmt.Errorf("empty asset key")
	}
	if s.keyPrefix != "" {
		key = s.keyPrefix + "/" + key
	}
	return key, nil
}

func (s ossStore) Save(ctx context.Context, key string, body io.Reader, contentType string) (string, error) {
	objKey, err := s.objectKey(key)
	if err != nil {
		return "", err
	}
	// public-read + long cache — assets are served straight from publicBase, so
	// each object must be publicly readable (mirrors the cosStore note).
	if _, err := s.client.PutObject(ctx, &oss.PutObjectRequest{
		Bucket:       oss.Ptr(s.bucket),
		Key:          oss.Ptr(objKey),
		Body:         body,
		Acl:          oss.ObjectACLPublicRead,
		ContentType:  ptrOrNil(contentType),
		CacheControl: oss.Ptr("public, max-age=31536000"),
	}); err != nil {
		return "", err
	}
	return s.publicBase + "/" + objKey, nil
}

func (s ossStore) UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error) {
	objKey, err := s.objectKey(key)
	if err != nil {
		return "", err
	}
	// Large assets (generated videos) go through the multipart uploader.
	uploader := s.client.NewUploader(func(o *oss.UploaderOptions) {
		o.PartSize = 16 * 1024 * 1024
		o.ParallelNum = 3
	})
	if _, err := uploader.UploadFile(ctx, &oss.PutObjectRequest{
		Bucket:             oss.Ptr(s.bucket),
		Key:                oss.Ptr(objKey),
		Acl:                oss.ObjectACLPublicRead,
		ContentType:        ptrOrNil(contentType),
		CacheControl:       oss.Ptr("public, max-age=31536000"),
		ContentDisposition: oss.Ptr("inline"),
		Metadata:           map[string]string{"source": "ccy-canvas-generated"},
	}, localPath); err != nil {
		return "", err
	}
	return s.publicBase + "/" + objKey, nil
}

func (s ossStore) PresignGet(ctx context.Context, rawURL string, expiry time.Duration) (string, error) {
	prefix := s.publicBase + "/"
	if s.publicBase == "" || !strings.HasPrefix(rawURL, prefix) {
		return "", nil // not one of our objects — caller fetches it directly
	}
	key := strings.TrimPrefix(rawURL, prefix)
	if i := strings.IndexAny(key, "?#"); i >= 0 {
		key = key[:i]
	}
	if key == "" {
		return "", nil
	}
	res, err := s.client.Presign(ctx, &oss.GetObjectRequest{
		Bucket: oss.Ptr(s.bucket),
		Key:    oss.Ptr(key),
	}, func(o *oss.PresignOptions) {
		o.Expires = expiry
	})
	if err != nil {
		return "", err
	}
	return res.URL, nil
}

func ptrOrNil(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return oss.Ptr(s)
}

func cleanObjectKey(key string) string {
	key = strings.TrimSpace(key)
	key = strings.TrimPrefix(key, "/")
	key = strings.ReplaceAll(key, "\\", "/")
	key = filepath.ToSlash(filepath.Clean(key))
	if key == "." || key == ".." || strings.HasPrefix(key, "../") {
		return ""
	}
	return strings.Trim(key, "/")
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
