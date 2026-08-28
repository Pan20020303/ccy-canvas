// Package adminaudit records privileged management actions in a dedicated,
// queryable audit trail. It intentionally stores only route-level metadata;
// request bodies and credentials never enter the log.
package adminaudit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
)

// Middleware returns a Huma middleware that persists an audit record for each
// successful or failed mutating admin operation. Read-only routes are omitted.
// A failure to create the initial record stops the mutation: an unlogged
// privileged change is more dangerous than a safely failed management action.
func Middleware(api huma.API, q *sqlc.Queries) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if q == nil || !isMutatingAdminOperation(ctx) {
			next(ctx)
			return
		}

		claims, ok := authn.ClaimsFromContext(ctx.Context())
		if !ok || claims.Role != "admin" {
			next(ctx)
			return
		}

		op := ctx.Operation()
		started := time.Now()
		auditID, err := q.CreateAdminAuditLog(ctx.Context(), sqlc.CreateAdminAuditLogParams{
			RequestID:   httpx.RequestIDFrom(ctx.Context()),
			ActorUserID: claims.UserID,
			Action:      safeOperationID(op),
			TargetType:  targetType(op),
			TargetID:    targetID(ctx),
			TargetLabel: "",
			Method:      ctx.Method(),
			Route:       safeRoute(op),
			Summary:     "",
			Metadata:    auditMetadata(op),
		})
		if err != nil {
			slog.Error("admin audit start failed", "request_id", httpx.RequestIDFrom(ctx.Context()), "operation", safeOperationID(op), "error", err)
			_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "无法记录管理操作，请稍后重试")
			return
		}

		next(ctx)

		status := ctx.Status()
		if status == 0 {
			status = defaultStatus(op)
		}
		auditStatus, errorCode := outcome(status)
		finishErr := q.FinishAdminAuditLog(context.Background(), sqlc.FinishAdminAuditLogParams{
			ID:         auditID,
			Status:     auditStatus,
			HTTPStatus: int32(status),
			ErrorCode:  errorCode,
			DurationMs: int32(time.Since(started).Milliseconds()),
		})
		if finishErr != nil {
			slog.Error("admin audit finish failed", "request_id", httpx.RequestIDFrom(ctx.Context()), "audit_id", auditID.String(), "error", finishErr)
		}
	}
}

// ChiMiddleware covers the one legacy management endpoint that remains on
// Chi (POST /api/admin/invitations). Huma operations use Middleware above.
func ChiMiddleware(q *sqlc.Queries, sessions session.Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if q == nil || r.Method != http.MethodPost || r.URL.Path != "/api/admin/invitations" {
				next.ServeHTTP(w, r)
				return
			}
			cookie, err := r.Cookie(session.CookieName)
			if err != nil || cookie == nil {
				next.ServeHTTP(w, r)
				return
			}
			claims, err := sessions.Parse(cookie.Value)
			if err != nil || claims.Role != "admin" {
				next.ServeHTTP(w, r)
				return
			}

			started := time.Now()
			auditID, err := q.CreateAdminAuditLog(r.Context(), sqlc.CreateAdminAuditLogParams{
				RequestID: httpx.RequestIDFrom(r.Context()), ActorUserID: claims.UserID,
				Action: "admin-create-invitation", TargetType: "invitations",
				Method: r.Method, Route: "/api/admin/invitations", Metadata: []byte(`{"operation_id":"admin-create-invitation"}`),
			})
			if err != nil {
				slog.Error("admin audit start failed", "request_id", httpx.RequestIDFrom(r.Context()), "operation", "admin-create-invitation", "error", err)
				httpx.WriteError(w, r, apperror.New(apperror.CodeInternal, "无法记录管理操作，请稍后重试"))
				return
			}

			recorder := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(recorder, r)
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			auditStatus, errorCode := outcome(status)
			if err := q.FinishAdminAuditLog(context.Background(), sqlc.FinishAdminAuditLogParams{
				ID: auditID, Status: auditStatus, HTTPStatus: int32(status), ErrorCode: errorCode,
				DurationMs: int32(time.Since(started).Milliseconds()),
			}); err != nil {
				slog.Error("admin audit finish failed", "request_id", httpx.RequestIDFrom(r.Context()), "audit_id", auditID.String(), "error", err)
			}
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(value []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(value)
}

func isMutatingAdminOperation(ctx huma.Context) bool {
	switch ctx.Method() {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	op := ctx.Operation()
	if op == nil || !strings.HasPrefix(op.Path, "/api/admin/") {
		return false
	}
	for _, scheme := range op.Security {
		if scopes, found := scheme[httpapi.SecuritySchemeName]; found {
			for _, scope := range scopes {
				if scope == authn.ScopeAdmin {
					return true
				}
			}
		}
	}
	return false
}

func safeOperationID(op *huma.Operation) string {
	if op == nil || strings.TrimSpace(op.OperationID) == "" {
		return "admin-operation"
	}
	return op.OperationID
}

func safeRoute(op *huma.Operation) string {
	if op == nil {
		return "/api/admin"
	}
	return op.Path
}

func targetType(op *huma.Operation) string {
	path := strings.TrimPrefix(safeRoute(op), "/api/admin/")
	if path == safeRoute(op) || path == "" {
		return "admin"
	}
	return strings.Split(path, "/")[0]
}

func targetID(ctx huma.Context) string {
	for _, key := range []string{"id", "user_id", "provider_id", "skill_id", "agent_id"} {
		if value := strings.TrimSpace(ctx.Param(key)); value != "" {
			return value
		}
	}
	return ""
}

func auditMetadata(op *huma.Operation) []byte {
	data, err := json.Marshal(map[string]string{"operation_id": safeOperationID(op)})
	if err != nil {
		return []byte(`{}`)
	}
	return data
}

func defaultStatus(op *huma.Operation) int {
	if op != nil && op.DefaultStatus > 0 {
		return op.DefaultStatus
	}
	return http.StatusOK
}

func outcome(status int) (string, string) {
	if status >= 400 {
		return "error", fmt.Sprintf("HTTP_%d", status)
	}
	return "success", ""
}
