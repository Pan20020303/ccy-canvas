// Package application implements the skill execution engine.
//
// Two kinds are supported today:
//
//   - "http"   — render a JSON body template, POST/GET it to a URL, extract a
//                JSON path from the response. Useful for relaying to third-
//                party APIs (translation, OCR, web search, etc.).
//   - "prompt" — substitute inputs into system + user prompt templates and
//                run them through the existing model-catalog Generate service.
//
// Future "code" kind will live behind a sandbox runtime.
package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"text/template"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

// Executor runs Skill.spec definitions on demand.
// generateSvc is the model-catalog Generate service; nil-able if you only need
// http kinds.
type Executor struct {
	generateSvc *application.Service
	httpClient  *http.Client
}

func NewExecutor(generateSvc *application.Service) *Executor {
	return &Executor{
		generateSvc: generateSvc,
		// Hardened client: validates the resolved IP at dial time and re-checks
		// every redirect hop, so the assertExternalURL pre-check cannot be
		// bypassed via a redirect or DNS rebinding to an internal address.
		httpClient: safehttp.Client(60 * time.Second),
	}
}

// Result is the normalized output of a skill invocation. Content is the
// "what to show the user / what the agent reads next"; Type hints at how to
// render or chain it.
type Result struct {
	Type    string          `json:"type"`    // "text" / "url" / "json"
	Content string          `json:"content"` // primary user-visible string
	Raw     json.RawMessage `json:"raw,omitempty"`
}

// Invoke runs the skill against the given JSON input. The caller is
// responsible for ownership / scope checks before this is reached.
func (e *Executor) Invoke(ctx context.Context, skill sqlc.Skill, inputs json.RawMessage) (*Result, error) {
	if !skill.Enabled {
		return nil, apperror.New(apperror.CodeInvalidInput, "Skill is disabled")
	}
	if len(inputs) == 0 {
		inputs = []byte("{}")
	}
	switch skill.Kind {
	case "http":
		return e.invokeHTTP(ctx, skill, inputs)
	case "prompt":
		return e.invokePrompt(ctx, skill, inputs)
	case "code":
		return nil, apperror.New(apperror.CodeInvalidInput, "Code kind is not yet supported (Phase 4)")
	}
	return nil, apperror.New(apperror.CodeInvalidInput, "Unknown skill kind: "+skill.Kind)
}

// ────────────────────────── HTTP kind ──────────────────────────

type httpSpec struct {
	URL          string            `json:"url"`
	Method       string            `json:"method"`
	Headers      map[string]string `json:"headers"`
	BodyTemplate string            `json:"body_template"`
	// ResponsePath is a dotted JSON path into the response: "data.result.text".
	// Empty means return the full body verbatim.
	ResponsePath string `json:"response_path"`
	TimeoutMs    int    `json:"timeout_ms"`
}

func (e *Executor) invokeHTTP(ctx context.Context, skill sqlc.Skill, inputs json.RawMessage) (*Result, error) {
	var spec httpSpec
	if err := json.Unmarshal(skill.Spec, &spec); err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "Invalid http spec", err)
	}
	if spec.URL == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "http spec missing url")
	}
	if spec.Method == "" {
		spec.Method = "POST"
	}
	if spec.TimeoutMs == 0 {
		spec.TimeoutMs = 60000
	}

	// SSRF guard: reject private / loopback / link-local IPs unless explicitly
	// the operator's known LAN endpoints. Members must not be able to point an
	// HTTP skill at internal infra.
	if err := assertExternalURL(spec.URL); err != nil {
		return nil, err
	}

	body, err := renderTemplate(spec.BodyTemplate, inputs)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "Failed to render body template", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutMs)*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, spec.Method, spec.URL, bytes.NewReader([]byte(body)))
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to build request", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range spec.Headers {
		req.Header.Set(k, v)
	}

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Upstream request failed", err)
	}
	defer resp.Body.Close()

	// Cap response to 4 MB so a runaway upstream can't OOM us.
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode >= 400 {
		return nil, apperror.New(apperror.CodeInternal,
			fmt.Sprintf("Upstream HTTP %d: %s", resp.StatusCode, truncate(string(respBody), 400)))
	}

	if spec.ResponsePath == "" {
		return &Result{Type: "json", Content: string(respBody), Raw: respBody}, nil
	}
	extracted, err := extractJSONPath(respBody, spec.ResponsePath)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to extract response_path", err)
	}
	return &Result{Type: "text", Content: extracted, Raw: respBody}, nil
}

// ────────────────────────── Prompt kind ──────────────────────────

type promptSpec struct {
	SystemPrompt string `json:"system_prompt"`
	UserTemplate string `json:"user_template"`
	ModelHint    string `json:"model_hint"`
}

func (e *Executor) invokePrompt(ctx context.Context, skill sqlc.Skill, inputs json.RawMessage) (*Result, error) {
	if e.generateSvc == nil {
		return nil, apperror.New(apperror.CodeInternal, "Prompt kind requires generateSvc; not wired")
	}
	var spec promptSpec
	if err := json.Unmarshal(skill.Spec, &spec); err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "Invalid prompt spec", err)
	}
	userPrompt, err := renderTemplate(spec.UserTemplate, inputs)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "Failed to render user template", err)
	}
	// Compose system+user; the Generate service takes only a single prompt
	// field today so we prefix the system prompt manually.
	composed := userPrompt
	if spec.SystemPrompt != "" {
		composed = spec.SystemPrompt + "\n\n" + userPrompt
	}
	model := spec.ModelHint
	if model == "" {
		model = "gpt-4o-mini"
	}
	gen, err := e.generateSvc.Generate(ctx, application.GenerateRequest{
		ServiceType: "text",
		Model:       model,
		Prompt:      composed,
	})
	if err != nil {
		return nil, err
	}
	return &Result{Type: gen.Type, Content: gen.Content}, nil
}

// ────────────────────────── helpers ──────────────────────────

// renderTemplate uses text/template with the json-decoded inputs as `.input`.
// Example: "{{.input.text}}" or "{{index .input.items 0}}".
func renderTemplate(tmpl string, inputs json.RawMessage) (string, error) {
	if tmpl == "" {
		return "", nil
	}
	var data map[string]any
	if err := json.Unmarshal(inputs, &data); err != nil {
		return "", err
	}
	t, err := template.New("skill").Option("missingkey=zero").Parse(tmpl)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, map[string]any{"input": data}); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// extractJSONPath supports dotted paths into nested objects/arrays, e.g.
//   data.result.text
//   choices.0.message.content
func extractJSONPath(body []byte, path string) (string, error) {
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", err
	}
	parts := strings.Split(path, ".")
	cur := doc
	for _, p := range parts {
		switch v := cur.(type) {
		case map[string]any:
			cur = v[p]
		case []any:
			var idx int
			if _, err := fmt.Sscanf(p, "%d", &idx); err != nil {
				return "", fmt.Errorf("array index expected at %q", p)
			}
			if idx < 0 || idx >= len(v) {
				return "", fmt.Errorf("index %d out of range", idx)
			}
			cur = v[idx]
		default:
			return "", fmt.Errorf("cannot descend into non-object at %q", p)
		}
	}
	switch v := cur.(type) {
	case string:
		return v, nil
	case nil:
		return "", nil
	default:
		raw, _ := json.Marshal(v)
		return string(raw), nil
	}
}

// assertExternalURL fails if the URL host resolves to a private / loopback /
// link-local address. This is a defense against members embedding SSRF URLs
// pointing at internal services (postgres, admin API, cloud metadata, etc.).
// Admin-created global skills bypass this check at config time only via the
// allowlist — for now we apply it uniformly.
func assertExternalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return apperror.Wrap(apperror.CodeInvalidInput, "Invalid url", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return apperror.New(apperror.CodeInvalidInput, "Only http(s) urls are allowed")
	}
	host := u.Hostname()
	// Resolve and check each address. DNS rebinding can defeat this; for a
	// LAN deployment we accept that risk.
	addrs, err := net.LookupIP(host)
	if err != nil {
		// If resolution fails, let the request itself fail later with a clearer
		// error. We don't want to block legitimate hostnames that aren't yet
		// in the DNS cache during config time.
		return nil
	}
	for _, ip := range addrs {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return apperror.New(apperror.CodeInvalidInput,
				"URL host resolves to a private/internal address; only public endpoints are allowed for http skills")
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
