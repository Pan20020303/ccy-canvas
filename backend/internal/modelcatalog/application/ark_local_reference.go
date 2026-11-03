package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

// Existing canvases retain /uploads paths after switching storage backends.
// Copy only the requested reference into the configured store; leave originals
// and canvas snapshots untouched. URL-only relays can use this same helper.
func arkLocalReferenceURL(ctx context.Context, raw string) (string, error) {
	u, err := arkLocalUploadPath(raw)
	if err != nil {
		return "", err
	}
	diskPath, err := resolveUploadDiskPath(u.Path)
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInvalidInput, "参考素材在服务器上不存在，请重新上传后重试", err)
	}
	return publishArkLocalReference(ctx, u, diskPath)
}

func arkLocalUploadPath(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.RawQuery != "" || u.Fragment != "" ||
		!strings.HasPrefix(u.Path, "/uploads/") || strings.ContainsAny(u.Path, "\\%") {
		return nil, apperror.New(apperror.CodeInvalidInput, "参考素材路径无效，请重新选择素材")
	}
	for _, part := range strings.Split(strings.TrimPrefix(u.Path, "/uploads/"), "/") {
		if part == "" || part == "." || part == ".." {
			return nil, apperror.New(apperror.CodeInvalidInput, "参考素材路径无效，请重新选择素材")
		}
	}
	return u, nil
}

func publishArkLocalReference(ctx context.Context, u *url.URL, diskPath string) (string, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	if backend != "" && backend != "local" {
		file, err := os.Open(diskPath)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考素材无法读取，请重新上传后重试", err)
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考素材读取失败，请重试", err)
		}
		ext := strings.ToLower(filepath.Ext(diskPath))
		contentType := mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		key := "references/" + hex.EncodeToString(hash.Sum(nil)) + ext
		remoteURL, err := assetstore.UploadContentAddressedFile(ctx, key, diskPath, contentType)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeUpstreamUnavailable, "参考素材转存对象存储失败，请检查 OSS/COS 配置或稍后重试", err)
		}
		// Do not recurse on a local fallback: it is not an object-store URL.
		if !strings.HasPrefix(remoteURL, "https://") && !strings.HasPrefix(remoteURL, "http://") {
			return "", apperror.New(apperror.CodeInvalidInput, "对象存储未返回可访问地址，请检查存储配置")
		}
		return arkReferenceMediaURL(ctx, remoteURL)
	}
	// Pure local installations must explicitly configure their public mount.
	// Never construct a provider URL from untrusted request Host headers.
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(os.Getenv("AUTH_FRONTEND_BASE_URL")), "/"))
	if err != nil || base.User != nil || base.RawQuery != "" || base.Fragment != "" || safehttp.ValidatePublicURL(base.String()) != nil {
		return "", apperror.New(apperror.CodeInvalidInput, "本地参考素材缺少公网地址，请配置对象存储或 AUTH_FRONTEND_BASE_URL 后重试")
	}
	base.Path = strings.TrimRight(base.Path, "/") + u.Path
	base.RawPath = ""
	return base.String(), nil
}

func arkReferenceInputError(label string, err error) error {
	public := apperror.Normalize(err)
	message := label + "处理失败"
	if public.Code != apperror.CodeInternal {
		message += "：" + apperror.PublicMessage(err)
	} else {
		message += "，请检查素材是否完整且符合尺寸要求"
	}
	return apperror.Wrap(apperror.CodeInvalidInput, message, err)
}

func readArkLocalImage(raw string) ([]byte, error) {
	u, err := arkLocalUploadPath(raw)
	if err != nil {
		return nil, err
	}
	diskPath, err := resolveUploadDiskPath(u.Path)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考图片在服务器上不存在，请重新上传后重试", err)
	}
	file, err := os.Open(diskPath)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考图片无法读取，请重新上传后重试", err)
	}
	defer file.Close()
	const maxBytes = 64 << 20
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "参考图片读取失败，请重试", err)
	}
	if len(data) > maxBytes {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("参考图片超过 %d MB，请压缩后重试", maxBytes>>20))
	}
	return data, nil
}
