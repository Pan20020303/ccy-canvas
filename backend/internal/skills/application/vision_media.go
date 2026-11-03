package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/shared/safehttp"
	_ "golang.org/x/image/webp"
)

// These media tools do not honor the deployment-wide internal-fetch escape
// hatch: model-controlled URLs must never access the LAN or cloud metadata.
func visionBlockedIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
	}
	return false
}

func validateVisionPublicURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.Hostname() == "" {
		return fmt.Errorf("请提供有效的公开 HTTP(S) 素材地址")
	}
	if err := safehttp.ValidatePublicURL(raw); err != nil {
		return fmt.Errorf("素材地址必须是公网 HTTP(S) 地址或本站 /uploads/ 路径")
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") || (net.ParseIP(parsed.Hostname()) != nil && visionBlockedIP(net.ParseIP(parsed.Hostname()))) {
		return fmt.Errorf("不允许读取本机、内网或云元数据地址")
	}
	return nil
}

func visionMediaHTTPClient(timeout time.Duration) *http.Client {
	client := safehttp.Client(timeout)
	transport := client.Transport.(*http.Transport).Clone()
	transport.Proxy = nil
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("无效的素材服务地址")
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("无法解析素材服务地址")
		}
		for _, address := range addresses {
			if visionBlockedIP(address.IP) {
				return nil, fmt.Errorf("不允许素材连接到内网地址")
			}
		}
		var lastErr error
		for _, address := range addresses {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
			if err == nil {
				return connection, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}
	client.Transport = transport
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("素材地址重定向次数过多")
		}
		return validateVisionPublicURL(req.URL.String())
	}
	return client
}

func visionUploadKey(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" || !strings.HasPrefix(parsed.Path, "/uploads/") {
		return "", fmt.Errorf("只允许读取本站上传目录的素材")
	}
	key := strings.TrimPrefix(parsed.Path, "/uploads/")
	if key == "" || strings.ContainsAny(key, "\\\x00:<>|\"*?") || !filepath.IsLocal(filepath.FromSlash(key)) {
		return "", fmt.Errorf("无效的上传素材路径")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return "", fmt.Errorf("无效的上传素材路径")
		}
	}
	return filepath.FromSlash(key), nil
}

func unwrapVisionMediaURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	for depth := 0; depth < 3; depth++ {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "", fmt.Errorf("无效的素材地址")
		}
		// Historical canvas data may contain this machine's absolute origin.
		// Normalize only the fixed upload/proxy namespaces; never make an HTTP
		// request to an internal host, and never trust a foreign /uploads path.
		if parsed.User == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
			(strings.HasPrefix(parsed.Path, "/uploads/") || parsed.Path == "/api/app/proxy-media") && visionOwnOrigin(parsed) {
			parsed.Scheme, parsed.Host = "", ""
			raw = parsed.String()
		}
		// Unwrap only our relative proxy route; never fetch an internal proxy.
		if parsed.Scheme == "" && parsed.Host == "" && parsed.Path == "/api/app/proxy-media" {
			raw = strings.TrimSpace(parsed.Query().Get("url"))
			if raw == "" {
				return "", fmt.Errorf("素材代理缺少原始地址")
			}
			continue
		}
		return raw, nil
	}
	return "", fmt.Errorf("素材代理嵌套过多")
}

func visionOwnOrigin(parsed *url.URL) bool {
	if configured, err := url.Parse(strings.TrimSpace(os.Getenv("PUBLIC_API_BASE"))); err == nil && configured.Host != "" &&
		strings.EqualFold(configured.Host, parsed.Host) && configured.Scheme == parsed.Scheme {
		return true
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") {
		return true
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, address := range addresses {
		if ifaceIP, _, err := net.ParseCIDR(address.String()); err == nil && ifaceIP.Equal(ip) {
			return true
		}
	}
	return false
}

func openVisionMedia(ctx context.Context, raw string, maxBytes int64) (io.ReadCloser, error) {
	raw, err := unwrapVisionMediaURL(raw)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(raw, "/uploads/") {
		key, err := visionUploadKey(raw)
		if err != nil {
			return nil, err
		}
		root, err := os.OpenRoot(assetstore.LocalRoot())
		if err != nil {
			return nil, fmt.Errorf("本站上传目录不可用")
		}
		defer root.Close()
		file, err := root.Open(key)
		if err != nil {
			return nil, fmt.Errorf("上传素材不存在或路径不允许访问，请重新选择素材")
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxBytes {
			file.Close()
			return nil, fmt.Errorf("素材为空、不是普通文件或超过大小限制")
		}
		return file, nil
	}
	if err := validateVisionPublicURL(raw); err != nil {
		return nil, err
	}
	if signed, err := assetstore.PresignGet(ctx, raw, 5*time.Minute); err != nil {
		return nil, fmt.Errorf("素材授权失败，请重新选择素材")
	} else if signed != "" {
		raw = signed
	}
	return openVisionPublicMedia(ctx, raw, maxBytes, visionMediaHTTPClient(90*time.Second))
}

func openVisionPublicMedia(ctx context.Context, raw string, maxBytes int64, client *http.Client) (io.ReadCloser, error) {
	if err := validateVisionPublicURL(raw); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, fmt.Errorf("无效的素材下载请求")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("素材下载失败或地址不允许访问，请检查链接是否过期")
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > maxBytes {
		response.Body.Close()
		return nil, fmt.Errorf("素材下载失败（HTTP %d）或超过大小限制", response.StatusCode)
	}
	return response.Body, nil
}

func readVisionBytes(ctx context.Context, raw string, limit int64) ([]byte, error) {
	reader, err := openVisionMedia(ctx, raw, limit)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, fmt.Errorf("素材读取中断，请重试")
	}
	if len(content) == 0 || int64(len(content)) > limit {
		return nil, fmt.Errorf("素材为空或超过大小限制")
	}
	return content, nil
}

func validatedVisionImage(raw []byte) (string, error) {
	if len(raw) == 0 || len(raw) > visionImageMaxBytes {
		return "", fmt.Errorf("图片为空或超过 7MB 限制")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "gif" && format != "webp") {
		return "", fmt.Errorf("素材不是有效的 PNG、JPEG、WebP 或 GIF 图片，视频请使用视频分析工具")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 16384 || config.Height > 16384 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return "", fmt.Errorf("图片尺寸过大，请使用不超过 4000 万像素的参考图")
	}
	return "data:image/" + format + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func fetchImageAsDataURL(ctx context.Context, rawURL string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	if strings.HasPrefix(rawURL, "data:") {
		if len(rawURL) > base64.StdEncoding.EncodedLen(visionImageMaxBytes)+64 {
			return "", fmt.Errorf("图片超过 7MB 限制")
		}
		header, encoded, found := strings.Cut(rawURL, ",")
		if !found || !strings.HasSuffix(header, ";base64") || !strings.HasPrefix(header, "data:image/") {
			return "", fmt.Errorf("图片数据格式不受支持")
		}
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", fmt.Errorf("图片编码无效")
		}
		validated, err := validatedVisionImage(raw)
		if err != nil {
			return "", err
		}
		if !strings.HasPrefix(validated, header+",") {
			return "", fmt.Errorf("图片声明类型与实际内容不一致")
		}
		return validated, nil
	}
	raw, err := readVisionBytes(ctx, rawURL, visionImageMaxBytes)
	if err != nil {
		return "", err
	}
	return validatedVisionImage(raw)
}
