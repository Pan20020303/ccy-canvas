package httpapi

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
)

// SecuritySchemeName is the cookie security scheme name referenced in per-operation Security declarations.
const SecuritySchemeName = "sessionCookie"

// New creates a huma API mounted on the given chi router.
// OpenAPI 3.1 spec is served at /api/openapi.json and /api/openapi.yaml.
func New(router *chi.Mux) huma.API {
	configureErrorFactory()
	cfg := huma.DefaultConfig("CCY Canvas API", "0.1.0")
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "" // disable built-in Stoplight renderer
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		SecuritySchemeName: {
			Type: "apiKey",
			In:   "cookie",
			Name: session.CookieName,
		},
	}
	return humachi.New(router, cfg)
}

// HumaError keeps Huma routes on the same public error envelope as Chi
// routes. Huma's default RFC-9457 object can echo rejected field values, so we
// intentionally omit raw validation values and internal causes.
type HumaError struct {
	StatusCode int `json:"-"`
	ErrorBody  struct {
		Code      apperror.Code `json:"code"`
		Message   string        `json:"message"`
		Retryable bool          `json:"retryable"`
	} `json:"error"`
	RequestID string `json:"request_id,omitempty"`
}

func (e *HumaError) Error() string  { return e.ErrorBody.Message }
func (e *HumaError) GetStatus() int { return e.StatusCode }

func newHumaError(status int, message, requestID string) huma.StatusError {
	code := apperror.CodeForHTTPStatus(status)
	publicMessage := message
	if code == apperror.CodeInternal || publicMessage == "" {
		publicMessage = apperror.PublicMessage(apperror.New(code, message))
	}
	if publicMessage == "" {
		publicMessage = "请求失败，请稍后重试"
	}
	err := &HumaError{StatusCode: status, RequestID: requestID}
	err.ErrorBody.Code = code
	err.ErrorBody.Message = publicMessage
	err.ErrorBody.Retryable = status == 0 || status >= 500 || status == 429
	return err
}

func configureErrorFactory() {
	huma.NewError = func(status int, message string, _ ...error) huma.StatusError {
		return newHumaError(status, message, "")
	}
	huma.NewErrorWithContext = func(ctx huma.Context, status int, message string, _ ...error) huma.StatusError {
		return newHumaError(status, message, httpx.RequestIDFrom(ctx.Context()))
	}
}
