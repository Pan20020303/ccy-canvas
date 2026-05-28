package interfaces

import (
	"net/http"
	"time"

	creditapp "ccy-canvas/backend/internal/credits/application"
	identityapp "ccy-canvas/backend/internal/identity/application"
	"ccy-canvas/backend/internal/identity/domain"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service  identityapp.Service
	credits  creditapp.AccountCreator
	sessions session.Manager
}

func NewHandler(service identityapp.Service, credits creditapp.AccountCreator, sessions session.Manager) Handler {
	return Handler{service: service, credits: credits, sessions: sessions}
}

func (h Handler) Routes(r chi.Router) {
	r.Post("/api/auth/register-by-invite", h.RegisterByInvite)
	r.Post("/api/auth/login", h.Login)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/auth/me", h.Me)
	r.Post("/api/admin/invitations", h.RequireAdmin(h.CreateInvitation))
}

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

func (h Handler) RegisterByInvite(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	user, err := h.service.RegisterByInvite(r.Context(), req.Email, req.Password, req.Name, req.InvitationCode)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}

	h.writeSessionAndUser(w, r, user)
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
