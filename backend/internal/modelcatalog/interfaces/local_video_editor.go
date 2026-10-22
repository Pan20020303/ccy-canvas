package interfaces

import (
	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	"context"
	"fmt"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"
	"time"
)

type localVideoEditInput struct {
	Body application.LocalVideoEditRequest
}

func (h *Handler) localVideoEdit(ctx context.Context, input *localVideoEditInput) (*localVideoTrimOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("请先登录")
	}
	var user pgtype.UUID
	if err := user.Scan(claims.UserID); err != nil || !user.Valid {
		return nil, huma.Error401Unauthorized("登录状态无效")
	}
	if h.q == nil {
		return nil, huma.Error503ServiceUnavailable("剪辑日志服务不可用")
	}
	started := time.Now()
	req := input.Body
	row, err := h.q.InsertGenerationLog(ctx, sqlc.InsertGenerationLogParams{UserID: user, NodeID: req.NodeID, ServiceType: "video", Model: "ffmpeg-local-editor",
		Prompt: fmt.Sprintf("剪辑工作台导出：%d 个画面、%d 个音轨；%dx%d；%d fps", len(req.Clips), len(req.Audio), req.Width, req.Height, req.FPS), Status: "pending"})
	if err != nil {
		return nil, toHTTPError(err)
	}
	_ = h.q.MarkGenerationLogRunning(ctx, row.ID)
	result, renderErr := h.svc.EditLocalVideo(ctx, req)
	status, resultURL, message := "success", "", ""
	if renderErr != nil {
		status, message = "error", apperror.PublicMessage(renderErr)
	} else {
		resultURL = result.URL
	}
	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = h.q.UpdateGenerationLogResult(logCtx, sqlc.UpdateGenerationLogResultParams{ID: row.ID, Status: status, ResultUrl: resultURL, ErrorMsg: message, DurationMs: int32(min(time.Since(started).Milliseconds(), int64(2147483647)))})
	if renderErr != nil {
		a := apperror.Normalize(renderErr)
		return nil, huma.NewError(apperror.HTTPStatus(a.Code), apperror.PublicMessage(a))
	}
	out := &localVideoTrimOutput{}
	out.Body.Data = *result
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}
