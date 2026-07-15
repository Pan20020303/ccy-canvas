package interfaces

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	creditapp "ccy-canvas/backend/internal/credits/application"
	identityapp "ccy-canvas/backend/internal/identity/application"
	"ccy-canvas/backend/internal/identity/domain"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type Handler struct {
	service     identityapp.Service
	credits     creditapp.AccountCreator
	sessions    session.Manager
	googleOAuth GoogleOAuthConfig
}

type HandlerOption func(*Handler)

type GoogleOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	FrontendBaseURL string
	CookieSecure    bool
}

func (c GoogleOAuthConfig) Enabled() bool {
	return strings.TrimSpace(c.ClientID) != "" && strings.TrimSpace(c.ClientSecret) != ""
}

func WithGoogleOAuth(config GoogleOAuthConfig) HandlerOption {
	return func(h *Handler) {
		h.googleOAuth = config
	}
}

func NewHandler(service identityapp.Service, credits creditapp.AccountCreator, sessions session.Manager, opts ...HandlerOption) Handler {
	h := Handler{service: service, credits: credits, sessions: sessions}
	for _, opt := range opts {
		opt(&h)
	}
	return h
}

func (h Handler) Routes(r chi.Router) {
	trustProxy := os.Getenv("TRUST_PROXY_IP") == "1"
	// Registration mints a credited account, so throttle it hard per IP to blunt
	// scripted credit-farming; login is looser but still rate-limited to slow
	// credential stuffing.
	signupLimit := httpx.RateLimitMiddleware(5, 5, trustProxy)  // 5/min per IP
	loginLimit := httpx.RateLimitMiddleware(10, 10, trustProxy) // 10/min per IP
	r.With(signupLimit).Post("/api/auth/register", h.Register)
	r.With(signupLimit).Post("/api/auth/register-by-invite", h.RegisterByInvite)
	r.With(loginLimit).Post("/api/auth/login", h.Login)
	r.Get("/api/auth/google/start", h.GoogleStart)
	r.Get("/api/auth/google/callback", h.GoogleCallback)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/auth/me", h.Me)
	r.Post("/api/admin/invitations", h.RequireAdmin(h.CreateInvitation))
}

const googleOAuthStateCookie = "ccy_oauth_state"

type registerRequest struct {
	Email          string `json:"email"`
	Password       string `json:"password"`
	Name           string `json:"name"`
	InvitationCode string `json:"invitation_code"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type createInvitationRequest struct {
	Role              string    `json:"role"`
	InitialDailyQuota int32     `json:"initial_daily_quota"`
	MaxUses           int32     `json:"max_uses"`
	ExpiresAt         time.Time `json:"expires_at"`
	Note              string    `json:"note"`
}

func (h Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	user, err := h.service.Register(r.Context(), req.Email, req.Password, req.Name, req.InvitationCode)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	h.writeSessionAndUser(w, r, user)
}

func (h Handler) RegisterByInvite(w http.ResponseWriter, r *http.Request) {
	h.Register(w, r)
}

func (h Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	user, err := h.service.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	h.writeSessionAndUser(w, r, user)
}

func (h Handler) GoogleStart(w http.ResponseWriter, r *http.Request) {
	if !h.googleOAuth.Enabled() {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "Google login is not configured"))
		return
	}
	state, err := randomOAuthState()
	if err != nil {
		httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInternal, "Could not create OAuth state", err))
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     googleOAuthStateCookie,
		Value:    state,
		Path:     "/api/auth/google",
		MaxAge:   10 * 60,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.googleOAuth.CookieSecure,
	})
	http.Redirect(w, r, h.googleOAuthConfig(r).AuthCodeURL(state, oauth2.AccessTypeOnline), http.StatusFound)
}

func (h Handler) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	clearGoogleStateCookie(w, h.googleOAuth.CookieSecure)
	if !h.googleOAuth.Enabled() {
		h.redirectAuthError(w, r, "google_not_configured")
		return
	}
	if r.URL.Query().Get("error") != "" {
		h.redirectAuthError(w, r, "google_denied")
		return
	}
	stateCookie, err := r.Cookie(googleOAuthStateCookie)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		h.redirectAuthError(w, r, "google_state_mismatch")
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		h.redirectAuthError(w, r, "google_missing_code")
		return
	}

	token, err := h.googleOAuthConfig(r).Exchange(r.Context(), code)
	if err != nil {
		h.redirectAuthError(w, r, "google_exchange_failed")
		return
	}
	profile, err := fetchGoogleProfile(r.Context(), token.AccessToken)
	if err != nil {
		h.redirectAuthError(w, r, "google_profile_failed")
		return
	}
	user, err := h.service.LoginWithOAuth(r.Context(), identityapp.OAuthLoginInput{
		Provider:       "google",
		ProviderUserID: profile.Sub,
		Email:          profile.Email,
		Name:           profile.Name,
		EmailVerified:  profile.EmailVerified,
	})
	if err != nil {
		h.redirectAuthError(w, r, "google_login_failed")
		return
	}
	cookie, err := h.sessions.NewCookie(user.ID, string(user.Role))
	if err != nil {
		h.redirectAuthError(w, r, "google_session_failed")
		return
	}
	http.SetCookie(w, cookie)
	target := "/app"
	if user.Role == domain.RoleAdmin {
		target = "/admin"
	}
	http.Redirect(w, r, h.frontendURL(target), http.StatusFound)
}

func (h Handler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, h.sessions.ClearCookie())
	httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

func (h Handler) Me(w http.ResponseWriter, r *http.Request) {
	claims, err := h.sessionClaims(r)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	user, err := h.service.CurrentUser(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	summary, err := h.credits.GetSummary(r.Context(), claims.UserID)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"user":           user,
		"credit_summary": summary,
	})
}

func (h Handler) CreateInvitation(w http.ResponseWriter, r *http.Request) {
	var req createInvitationRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	claims, err := h.sessionClaims(r)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	invitation, err := h.service.CreateInvitation(
		r.Context(),
		domain.Role(req.Role),
		req.InitialDailyQuota,
		req.MaxUses,
		req.ExpiresAt,
		claims.UserID,
		req.Note,
	)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	httpx.WriteJSON(w, r, http.StatusCreated, map[string]any{"invitation": invitation})
}

func (h Handler) RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := h.sessionClaims(r)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if claims.Role != string(domain.RoleAdmin) {
			httpx.WriteError(w, r, apperror.New(apperror.CodeForbidden, "Admin access required"))
			return
		}
		next.ServeHTTP(w, r)
	}
}

func (h Handler) sessionClaims(r *http.Request) (session.Claims, error) {
	cookie, err := r.Cookie(session.CookieName)
	if err != nil {
		return session.Claims{}, apperror.New(apperror.CodeUnauthenticated, "Authentication required")
	}
	claims, err := h.sessions.Parse(cookie.Value)
	if err != nil {
		return session.Claims{}, apperror.New(apperror.CodeUnauthenticated, "Authentication required")
	}
	return claims, nil
}

func (h Handler) writeSessionAndUser(w http.ResponseWriter, r *http.Request, user identityapp.UserDTO) {
	cookie, err := h.sessions.NewCookie(user.ID, string(user.Role))
	if err != nil {
		httpx.WriteError(w, r, apperror.Wrap(apperror.CodeInternal, "Could not create session", err))
		return
	}
	http.SetCookie(w, cookie)
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"user": user})
}

type googleProfile struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

func (h Handler) googleOAuthConfig(r *http.Request) *oauth2.Config {
	redirectURL := strings.TrimSpace(h.googleOAuth.RedirectURL)
	if redirectURL == "" {
		redirectURL = h.requestOrigin(r) + "/api/auth/google/callback"
	}
	return &oauth2.Config{
		ClientID:     h.googleOAuth.ClientID,
		ClientSecret: h.googleOAuth.ClientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint:     google.Endpoint,
	}
}

func (h Handler) requestOrigin(r *http.Request) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return fmt.Sprintf("%s://%s", proto, host)
}

func (h Handler) frontendURL(path string) string {
	base := strings.TrimRight(strings.TrimSpace(h.googleOAuth.FrontendBaseURL), "/")
	if base == "" {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

func (h Handler) redirectAuthError(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, h.frontendURL("/login?auth_error="+code), http.StatusFound)
}

func fetchGoogleProfile(ctx context.Context, accessToken string) (googleProfile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://openidconnect.googleapis.com/v1/userinfo", nil)
	if err != nil {
		return googleProfile{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return googleProfile{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return googleProfile{}, fmt.Errorf("google userinfo returned %s: %s", resp.Status, string(body))
	}
	var profile googleProfile
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		return googleProfile{}, err
	}
	if profile.Sub == "" || profile.Email == "" {
		return googleProfile{}, fmt.Errorf("google userinfo missing subject or email")
	}
	return profile, nil
}

func randomOAuthState() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func clearGoogleStateCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     googleOAuthStateCookie,
		Value:    "",
		Path:     "/api/auth/google",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}
