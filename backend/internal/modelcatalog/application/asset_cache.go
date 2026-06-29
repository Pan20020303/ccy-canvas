package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"

	"github.com/google/uuid"
)

type StagedAsset struct {
	LocalPath   string
	StagingURL  string
	COSKey      string
	ContentType string
}

// PersistRemoteAsset keeps the legacy "give me a durable URL" contract while
// internally using the newer two-step path: stage locally, then promote to the
// configured asset store.
func PersistRemoteAsset(ctx context.Context, remoteURL string) (string, error) {
	staged, err := StageRemoteAsset(ctx, remoteURL)
	if err != nil {
		return remoteURL, err
	}
	if staged.LocalPath == "" {
		return staged.StagingURL, nil
	}
	storedURL, err := PromoteStagedAssetToStore(ctx, staged)
	if err != nil {
		return staged.StagingURL, err
	}
	return storedURL, nil
}

type remoteAssetAuth struct {
	providerBaseURL string
	bearerToken     string
}

// StageRemoteAsset downloads a provider result into a persistent local staging
// file under uploads/staging/..., so the paid generation is no longer dependent
// on the provider's expiring URL.
func StageRemoteAsset(ctx context.Context, remoteURL string) (StagedAsset, error) {
	return stageRemoteAsset(ctx, remoteURL, remoteAssetAuth{})
}

func StageRemoteAssetWithProviderAuth(ctx context.Context, remoteURL, providerBaseURL, apiKey string) (StagedAsset, error) {
	return stageRemoteAsset(ctx, remoteURL, remoteAssetAuth{
		providerBaseURL: providerBaseURL,
		bearerToken:     apiKey,
	})
}

func stageRemoteAsset(ctx context.Context, remoteURL string, auth remoteAssetAuth) (StagedAsset, error) {
	trimmed := strings.TrimSpace(remoteURL)
	if trimmed == "" {
		return StagedAsset{StagingURL: remoteURL}, nil
	}
	if strings.HasPrefix(trimmed, "data:") {
		return stageDataURI(trimmed)
	}
	if strings.HasPrefix(trimmed, "blob:") ||
		strings.HasPrefix(trimmed, "/uploads/") ||
		(!strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://")) {
		return StagedAsset{StagingURL: remoteURL}, nil
	}

	dlCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, trimmed, nil)
	if err != nil {
		return StagedAsset{StagingURL: remoteURL}, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; CCYCanvasAssetCache/1.0)")
	req.Header.Set("Accept", "image/*,video/*,*/*;q=0.8")
	attachedBearer := false
	if auth.shouldAttachBearer(trimmed) {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(auth.bearerToken))
		attachedBearer = true
	}
	resp, err := assetCacheHTTPClient.Do(req)
	if err != nil {
		return StagedAsset{StagingURL: remoteURL}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return StagedAsset{StagingURL: remoteURL}, fmt.Errorf("upstream host %s returned HTTP %d while staging asset (auth=%t)", safeURLHost(trimmed), resp.StatusCode, attachedBearer)
	}

	ext := extensionFor(trimmed, resp.Header.Get("Content-Type"))
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = mime.TypeByExtension(ext)
	}
	return writeStagedAsset(resp.Body, ext, contentType)
}

func safeURLHost(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || strings.TrimSpace(u.Host) == "" {
		return "unknown"
	}
	return strings.ToLower(u.Host)
}

func (a remoteAssetAuth) shouldAttachBearer(remoteURL string) bool {
	if strings.TrimSpace(a.bearerToken) == "" || strings.TrimSpace(a.providerBaseURL) == "" {
		return false
	}
	return assetURLMatchesProviderHost(remoteURL, a.providerBaseURL)
}

func assetURLMatchesProviderHost(remoteURL, providerBaseURL string) bool {
	asset, err := url.Parse(strings.TrimSpace(remoteURL))
	if err != nil {
		return false
	}
	provider, err := url.Parse(strings.TrimSpace(providerBaseURL))
	if err != nil {
		return false
	}
	assetHost := strings.ToLower(strings.TrimSpace(asset.Hostname()))
	providerHost := strings.ToLower(strings.TrimSpace(provider.Hostname()))
	if assetHost == "" || providerHost == "" {
		return false
	}
	hostMatches := assetHost == providerHost ||
		strings.HasSuffix(assetHost, "."+providerHost) ||
		knownProviderSiblingAssetHost(assetHost, providerHost)
	if !hostMatches {
		return false
	}
	providerPort := provider.Port()
	assetPort := asset.Port()
	if providerPort != "" {
		return assetPort == providerPort
	}
	return assetPort == "" || isDefaultURLPort(asset.Scheme, assetPort)
}

func knownProviderSiblingAssetHost(assetHost, providerHost string) bool {
	for _, domain := range []string{"relaybases.com"} {
		if hostWithinDomain(assetHost, domain) && hostWithinDomain(providerHost, domain) {
			return true
		}
	}
	return false
}

func hostWithinDomain(host, domain string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	domain = strings.ToLower(strings.TrimSpace(domain))
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func isDefaultURLPort(scheme, port string) bool {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "http":
		return port == "80"
	case "https":
		return port == "443"
	default:
		return false
	}
}

func PromoteStagedAssetToStore(ctx context.Context, staged StagedAsset) (string, error) {
	if strings.TrimSpace(staged.LocalPath) == "" {
		return staged.StagingURL, nil
	}
	if strings.TrimSpace(staged.COSKey) == "" {
		return "", fmt.Errorf("missing object key for staged asset")
	}
	storedURL, err := assetstore.UploadFile(ctx, staged.COSKey, staged.LocalPath, staged.ContentType)
	if err != nil {
		return "", err
	}
	if storedURL != staged.StagingURL {
		_ = os.Remove(staged.LocalPath)
	}
	return storedURL, nil
}

func persistDataURI(uri string) (string, error) {
	staged, err := stageDataURI(uri)
	if err != nil {
		return uri, err
	}
	storedURL, err := PromoteStagedAssetToStore(context.Background(), staged)
	if err != nil {
		return staged.StagingURL, err
	}
	return storedURL, nil
}

func stageDataURI(uri string) (StagedAsset, error) {
	const prefix = "data:"
	if !strings.HasPrefix(uri, prefix) {
		return StagedAsset{StagingURL: uri}, fmt.Errorf("not a data URI")
	}
	commaIdx := strings.IndexByte(uri, ',')
	if commaIdx <= len(prefix) {
		return StagedAsset{StagingURL: uri}, fmt.Errorf("malformed data URI: missing payload")
	}
	header := uri[len(prefix):commaIdx]
	payload := uri[commaIdx+1:]
	mimeType := header
	isBase64 := false
	if idx := strings.IndexByte(header, ';'); idx >= 0 {
		mimeType = header[:idx]
		for _, attr := range strings.Split(header[idx+1:], ";") {
			if strings.EqualFold(strings.TrimSpace(attr), "base64") {
				isBase64 = true
			}
		}
	}

	var payloadBytes []byte
	if isBase64 {
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(payload)
			if err != nil {
				return StagedAsset{StagingURL: uri}, err
			}
		}
		payloadBytes = decoded
	} else {
		unescaped, err := url.QueryUnescape(payload)
		if err != nil {
			return StagedAsset{StagingURL: uri}, err
		}
		payloadBytes = []byte(unescaped)
	}
	if len(payloadBytes) == 0 {
		return StagedAsset{StagingURL: uri}, fmt.Errorf("decoded data URI was empty")
	}

	return writeStagedAsset(bytes.NewReader(payloadBytes), extensionFor("", mimeType), mimeType)
}

func writeStagedAsset(body io.Reader, ext, contentType string) (StagedAsset, error) {
	dateDir := time.Now().Format("2006-01")
	filename := uuid.New().String() + ext
	rel := filepath.ToSlash(filepath.Join("staging", "generated", dateDir, filename))
	localPath := filepath.Join(uploadRoot(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return StagedAsset{}, err
	}
	dst, err := os.Create(localPath)
	if err != nil {
		return StagedAsset{}, err
	}
	const maxBytes = 200 * 1024 * 1024
	written, copyErr := io.Copy(dst, io.LimitReader(body, maxBytes))
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(localPath)
		if copyErr != nil {
			return StagedAsset{}, copyErr
		}
		return StagedAsset{}, closeErr
	}
	if written == 0 {
		_ = os.Remove(localPath)
		return StagedAsset{}, fmt.Errorf("asset body was empty")
	}
	if contentType == "" {
		contentType = mime.TypeByExtension(ext)
	}
	return StagedAsset{
		LocalPath:   localPath,
		StagingURL:  "/uploads/" + rel,
		COSKey:      fmt.Sprintf("generated/%s/%s", dateDir, filename),
		ContentType: contentType,
	}, nil
}

func uploadRoot() string {
	root := strings.TrimSpace(os.Getenv("UPLOAD_DIR"))
	if root == "" {
		return "uploads"
	}
	return root
}

func extensionFor(urlStr, contentType string) string {
	if u, err := url.Parse(urlStr); err == nil {
		if ext := strings.ToLower(filepath.Ext(u.Path)); ext != "" && len(ext) <= 6 {
			return ext
		}
	}
	if contentType != "" {
		mt, _, _ := mime.ParseMediaType(contentType)
		switch mt {
		case "image/png":
			return ".png"
		case "image/jpeg":
			return ".jpg"
		case "image/webp":
			return ".webp"
		case "image/gif":
			return ".gif"
		case "video/mp4":
			return ".mp4"
		case "video/quicktime":
			return ".mov"
		case "video/webm":
			return ".webm"
		case "audio/mpeg":
			return ".mp3"
		case "audio/wav", "audio/x-wav":
			return ".wav"
		case "audio/ogg":
			return ".ogg"
		case "audio/aac":
			return ".aac"
		}
		if strings.HasPrefix(mt, "image/") {
			return ".img"
		}
		if strings.HasPrefix(mt, "video/") {
			return ".vid"
		}
		if strings.HasPrefix(mt, "audio/") {
			return ".aud"
		}
	}
	return ".bin"
}

var assetCacheHTTPClient = &http.Client{
	Timeout: 70 * time.Second,
}
