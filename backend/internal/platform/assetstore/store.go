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

	"github.com/tencentyun/cos-go-sdk-v5"
)

type Store interface {
	Save(ctx context.Context, key string, body io.Reader, contentType string) (string, error)
	UploadFile(ctx context.Context, key string, localPath string, contentType string) (string, error)
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

type cosStore struct {
	client     *cos.Client
	publicBase string
	keyPrefix  string
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
