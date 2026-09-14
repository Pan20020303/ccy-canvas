package interfaces

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	"context"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"net/http"
	"time"
)

func (rt *AgentRunRouter) cancelAgentJob(w http.ResponseWriter, r *http.Request) {
	user, ok := rt.authenticatedAgentUser(w, r)
	if !ok {
		return
	}
	id, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeInvalidInput, "任务 ID 不正确"))
		return
	}
	job, err := rt.q.GetOwnedAgentRunJob(r.Context(), id, user)
	if err != nil {
		httpx.WriteError(w, r, apperror.New(apperror.CodeNotFound, "任务不存在"))
		return
	}
	if !isTerminalAgentJobStatus(job.Status) {
		err = rt.q.RequestAgentRunCancellation(r.Context(), id)
		if err != nil {
			httpx.WriteError(w, r, apperror.New(apperror.CodeInternal, "取消失败，请重试"))
			return
		}
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

func (rt *AgentRunRouter) watchAgentCancellation(ctx context.Context, cancel context.CancelFunc, id pgtype.UUID) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			job, err := rt.q.GetAgentRunJob(ctx, id)
			if err == nil && (job.Status == "cancelled" || job.Status == "waiting" && job.ErrorMsg == "用户请求停止") {
				cancel()
				return
			}
		}
	}
}
