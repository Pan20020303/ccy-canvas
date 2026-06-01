// Package authn provides a huma middleware for per-operation authentication and
// authorization based on the session cookie security scheme.
package authn

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
)

// ScopeAdmin is the scope value used in Operation.Security to require admin role.
const ScopeAdmin = "admin"

type claimsKey struct{}

// Middleware returns a huma middleware that enforces per-operation auth.
//
//   - Operations with no Security declaration are passed through unchanged.
//   - Operations declaring sessionCookie Security require a valid session cookie (401 otherwise).
//   - If the operation's scope list includes ScopeAdmin, the session role must be "admin" (403 otherwise).
//   - On success, Claims are stored in the context via huma.WithValue and can be
//     retrieved inside handlers with ClaimsFromContext.
func Middleware(api huma.API, sessions session.Manager) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		// Determine whether this operation requires auth and what scopes.
		var requiredScopes []string
		authRequired := false
		for _, scheme := range ctx.Operation().Security {
			if scopes, ok := scheme[httpapi.SecuritySchemeName]; ok {
				authRequired = true
				requiredScopes = scopes
				break
			}
		}

		if !authRequired {
			next(ctx)
			return
		}

		// Parse the session cookie.
		cookie, err := huma.ReadCookie(ctx, session.CookieName)
		if err != nil || cookie == nil || cookie.Value == "" {
			huma.WriteErr(api, ctx, http.StatusUnauthorized, "Authentication required")
			return
		}
		claims, err := sessions.Parse(cookie.Value)
		if err != nil {
			huma.WriteErr(api, ctx, http.StatusUnauthorized, "Authentication required")
			return
		}

		// Enforce admin scope when declared.
		for _, scope := range requiredScopes {
			if scope == ScopeAdmin && claims.Role != "admin" {
				huma.WriteErr(api, ctx, http.StatusForbidden, "Admin access required")
				return
			}
		}

		// Inject claims into context and continue.
		next(huma.WithValue(ctx, claimsKey{}, claims))
	}
}

// ClaimsFromContext retrieves the session Claims stored by Middleware.
// Returns (zero-value, false) if not present (operation did not require auth).
func ClaimsFromContext(ctx context.Context) (session.Claims, bool) {
	claims, ok := ctx.Value(claimsKey{}).(session.Claims)
	return claims, ok
}
