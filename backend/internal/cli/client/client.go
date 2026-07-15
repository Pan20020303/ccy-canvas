// Package client is a thin HTTP client for the CCY Canvas backend used by the
// ccy CLI. It carries the ccy_session cookie, unwraps the { data, request_id }
// success envelope, normalizes errors, and NEVER logs or prints the cookie.
//
// It depends only on the standard library (plus google/uuid via callers) — it
// must not import the backend service/DB layer, so `go build ./cmd/ccy` stays a
// lightweight single binary.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const sessionCookieName = "ccy_session"

// Client talks to one backend base URL with one session.
type Client struct {
	BaseURL string
	Session string // ccy_session cookie value; "" if unauthenticated
	HTTP    *http.Client
}

// New builds a client. Timeout is 0 (no overall deadline) because the inline
// (non-Redis) generate path can block for minutes; callers bound long waits
// with a context deadline instead.
func New(baseURL, session string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Session: session,
		HTTP:    &http.Client{Timeout: 0},
	}
}

func (c *Client) resolve(p string) string {
	if strings.HasPrefix(p, "http://") || strings.HasPrefix(p, "https://") {
		return p
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return c.BaseURL + p
}

func (c *Client) newRequest(ctx context.Context, method, p string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.resolve(p), body)
	if err != nil {
		return nil, err
	}
	if c.Session != "" {
		req.Header.Set("Cookie", sessionCookieName+"="+c.Session)
	}
	return req, nil
}

func networkErr(base string, err error) string {
	return fmt.Sprintf("无法连接后端 %s(%v)。确认后端在运行、--base-url 正确,或设置 CCY_BASE_URL。", base, err)
}

// doJSON sends an optional JSON body and unmarshals the envelope's data into
// out (may be nil). Non-2xx becomes an *APIError.
func (c *Client) doJSON(ctx context.Context, method, p string, payload, out any) error {
	var reader io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := c.newRequest(ctx, method, p, reader)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return &APIError{Status: 0, Message: networkErr(c.BaseURL, err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseAPIError(resp.StatusCode, raw)
	}
	if out == nil {
		return nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return &APIError{Status: resp.StatusCode, Message: "无法解析响应: " + err.Error()}
	}
	if len(env.Data) == 0 {
		return &APIError{Status: resp.StatusCode, Message: "响应缺少 data 字段"}
	}
	return json.Unmarshal(env.Data, out)
}

// ─── Auth ────────────────────────────────────────────────────────────────────

// authenticate posts credentials and captures the ccy_session cookie from
// Set-Cookie. It returns the user and the raw cookie value.
func (c *Client) authenticate(ctx context.Context, p string, payload any) (User, string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return User{}, "", err
	}
	req, err := c.newRequest(ctx, http.MethodPost, p, bytes.NewReader(b))
	if err != nil {
		return User{}, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return User{}, "", &APIError{Status: 0, Message: networkErr(c.BaseURL, err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return User{}, "", parseAPIError(resp.StatusCode, raw)
	}
	var cookie string
	for _, ck := range resp.Cookies() {
		if ck.Name == sessionCookieName {
			cookie = ck.Value
		}
	}
	var env struct {
		Data authData `json:"data"`
	}
	_ = json.Unmarshal(raw, &env)
	if cookie == "" {
		return env.Data.User, "", &APIError{Status: resp.StatusCode, Message: "登录成功但未收到会话 Cookie(检查后端 Set-Cookie 与 COOKIE_SECURE 配置)"}
	}
	return env.Data.User, cookie, nil
}

// Login authenticates with email + password.
func (c *Client) Login(ctx context.Context, email, password string) (User, string, error) {
	return c.authenticate(ctx, "/api/auth/login", map[string]string{"email": email, "password": password})
}

// Register creates an account (invite optional).
func (c *Client) Register(ctx context.Context, email, password, name, invite string) (User, string, error) {
	payload := map[string]string{"email": email, "password": password, "name": name}
	if strings.TrimSpace(invite) != "" {
		payload["invitation_code"] = invite
	}
	return c.authenticate(ctx, "/api/auth/register", payload)
}

// Logout best-effort clears the server session (backend ignores the body).
func (c *Client) Logout(ctx context.Context) error {
	return c.doJSON(ctx, http.MethodPost, "/api/auth/logout", map[string]any{}, nil)
}

// Me returns the current user + credit summary.
func (c *Client) Me(ctx context.Context) (MeData, error) {
	var d MeData
	return d, c.doJSON(ctx, http.MethodGet, "/api/auth/me", nil, &d)
}

// ─── Projects ────────────────────────────────────────────────────────────────

func (c *Client) ListProjects(ctx context.Context) ([]Project, error) {
	var out []Project
	return out, c.doJSON(ctx, http.MethodGet, "/api/app/projects", nil, &out)
}

func (c *Client) CreateProject(ctx context.Context, name string) (Project, error) {
	var out Project
	return out, c.doJSON(ctx, http.MethodPost, "/api/app/projects", map[string]string{"name": name}, &out)
}

func (c *Client) DeleteProject(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/app/projects/"+url.PathEscape(id), nil, nil)
}

// ─── Models / providers ──────────────────────────────────────────────────────

func (c *Client) ListModels(ctx context.Context) ([]UserModel, error) {
	var out []UserModel
	return out, c.doJSON(ctx, http.MethodGet, "/api/app/models", nil, &out)
}

func (c *Client) ListProviders(ctx context.Context) ([]ProviderConfig, error) {
	var out []ProviderConfig
	return out, c.doJSON(ctx, http.MethodGet, "/api/app/provider-configs", nil, &out)
}

// ─── Generate / tasks ────────────────────────────────────────────────────────

func (c *Client) Generate(ctx context.Context, req GenerateRequest) (GenerateResult, error) {
	var out GenerateResult
	return out, c.doJSON(ctx, http.MethodPost, "/api/app/generate", req, &out)
}

func (c *Client) GetTask(ctx context.Context, id string) (TaskItem, error) {
	var out TaskItem
	return out, c.doJSON(ctx, http.MethodGet, "/api/app/tasks/"+url.PathEscape(id), nil, &out)
}

func (c *Client) ActiveTasks(ctx context.Context) ([]TaskItem, error) {
	var out []TaskItem
	return out, c.doJSON(ctx, http.MethodGet, "/api/app/tasks/active", nil, &out)
}

func (c *Client) BatchTasks(ctx context.Context, nodeIDs []string) ([]TaskItem, error) {
	var out []TaskItem
	return out, c.doJSON(ctx, http.MethodPost, "/api/app/tasks/batch", map[string]any{"node_ids": nodeIDs}, &out)
}

// ─── Upload ──────────────────────────────────────────────────────────────────

// Upload posts a local file to /api/app/upload (multipart field "file") and
// returns its hosted URL. The response is BARE JSON (not enveloped).
func (c *Client) Upload(ctx context.Context, filePath string) (UploadResponse, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return UploadResponse{}, err
	}
	defer f.Close()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return UploadResponse{}, err
	}
	if _, err := io.Copy(fw, f); err != nil {
		return UploadResponse{}, err
	}
	if err := mw.Close(); err != nil {
		return UploadResponse{}, err
	}

	req, err := c.newRequest(ctx, http.MethodPost, "/api/app/upload", &buf)
	if err != nil {
		return UploadResponse{}, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return UploadResponse{}, &APIError{Status: 0, Message: networkErr(c.BaseURL, err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UploadResponse{}, parseAPIError(resp.StatusCode, raw)
	}
	var ur UploadResponse
	if err := json.Unmarshal(raw, &ur); err != nil {
		return UploadResponse{}, &APIError{Status: resp.StatusCode, Message: "无法解析上传响应: " + err.Error()}
	}
	if ur.URL == "" {
		return UploadResponse{}, &APIError{Status: resp.StatusCode, Message: "上传返回缺少 url"}
	}
	return ur, nil
}

// ─── Download ────────────────────────────────────────────────────────────────

// Download fetches a media URL to dest (a file or directory) and returns the
// written path. Strategy:
//   - our own backend host (e.g. local /uploads): GET directly WITH cookie;
//   - third-party host: anonymous GET; on 403 or an expiring signed URL, retry
//     through the authenticated /api/app/proxy-media endpoint (which presigns
//     private COS objects). The proxy SSRF-guards loopback/private hosts, so a
//     local result_url is handled by the same-host branch above, not the proxy.
func (c *Client) Download(ctx context.Context, mediaURL, dest string) (string, error) {
	final, err := resolveDestPath(mediaURL, dest)
	if err != nil {
		return "", err
	}

	sameHost := c.isBackendURL(mediaURL)
	body, ctype, status, ferr := c.fetch(ctx, mediaURL, sameHost)
	if ferr == nil && status >= 200 && status < 300 {
		defer body.Close()
		return writeStream(final, ctype, body)
	}
	if body != nil {
		body.Close()
	}
	if sameHost {
		// Own host already tried with auth; proxy won't help (and would be
		// SSRF-rejected for loopback). Surface the real failure.
		if ferr != nil {
			return "", &APIError{Status: 0, Message: fmt.Sprintf("下载失败: %v", ferr)}
		}
		return "", &APIError{Status: status, Message: fmt.Sprintf("下载失败 (HTTP %d)", status)}
	}

	// Fallback: authenticated media proxy for third-party/private URLs.
	proxyPath := "/api/app/proxy-media?url=" + url.QueryEscape(mediaURL)
	body2, ctype2, status2, ferr2 := c.fetch(ctx, proxyPath, true)
	if ferr2 != nil {
		return "", &APIError{Status: 0, Message: fmt.Sprintf("下载失败: %v", ferr2)}
	}
	defer body2.Close()
	if status2 < 200 || status2 >= 300 {
		raw, _ := io.ReadAll(body2)
		return "", parseAPIError(status2, raw)
	}
	return writeStream(final, ctype2, body2)
}

func (c *Client) fetch(ctx context.Context, rawurl string, withCookie bool) (io.ReadCloser, string, int, error) {
	var (
		req *http.Request
		err error
	)
	if withCookie {
		req, err = c.newRequest(ctx, http.MethodGet, rawurl, nil)
	} else {
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, c.resolve(rawurl), nil)
	}
	if err != nil {
		return nil, "", 0, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", 0, err
	}
	return resp.Body, resp.Header.Get("Content-Type"), resp.StatusCode, nil
}

func (c *Client) isBackendURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	b, err := url.Parse(c.BaseURL)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, b.Host)
}

func resolveDestPath(mediaURL, dest string) (string, error) {
	name := filenameFromURL(mediaURL)
	if strings.TrimSpace(dest) == "" {
		return name, nil
	}
	if fi, err := os.Stat(dest); err == nil && fi.IsDir() {
		return filepath.Join(dest, name), nil
	}
	if strings.HasSuffix(dest, "/") || strings.HasSuffix(dest, string(os.PathSeparator)) {
		if err := os.MkdirAll(dest, 0o755); err != nil {
			return "", err
		}
		return filepath.Join(dest, name), nil
	}
	return dest, nil
}

func filenameFromURL(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		base := path.Base(u.Path)
		if base != "" && base != "/" && base != "." {
			return base
		}
	}
	return "download.bin"
}

func writeStream(dest, contentType string, body io.Reader) (string, error) {
	if filepath.Ext(dest) == "" {
		if ext := extFromContentType(contentType); ext != "" {
			dest += ext
		}
	}
	if d := filepath.Dir(dest); d != "" {
		_ = os.MkdirAll(d, 0o755)
	}
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, body); err != nil {
		return "", err
	}
	return dest, nil
}

func extFromContentType(ct string) string {
	ct = strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	switch ct {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
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
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	case "audio/mp4", "audio/x-m4a":
		return ".m4a"
	default:
		return ""
	}
}
