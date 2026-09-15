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
	"strings"
	"time"
)

type localVideoTrimInput struct {
	Body struct {
		MediaURL string  `json:"media_url" minLength:"1" maxLength:"8192"`
		Start    float64 `json:"start" minimum:"0" maximum:"3600"`
		End      float64 `json:"end" minimum:"0.1" maximum:"3600"`
		Mute     bool    `json:"mute"`
		NodeID   string  `json:"node_id" minLength:"1" maxLength:"200"`
	}
}
type localVideoTrimOutput struct {
	Body struct {
		Data      application.LocalVideoTrimResult `json:"data"`
		RequestID string                           `json:"request_id"`
	}
}

func (h *Handler) localVideoTrim(ctx context.Context, input *localVideoTrimInput) (*localVideoTrimOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, toHTTPError(apperror.New(apperror.CodeUnauthenticated, "请先登录"))
	}
	var userID pgtype.UUID
	if err := userID.Scan(claims.UserID); err != nil || !userID.Valid {
		return nil, toHTTPError(apperror.New(apperror.CodeUnauthenticated, "登录状态无效"))
	}
	// No provider lookup, generation queue, or credit charge. Logs remain available
	// to the existing node recovery poller if the browser disconnects.
	started := time.Now()
	if h.q == nil {
		return nil, toHTTPError(apperror.New(apperror.CodeInternal, "剪辑日志服务不可用"))
	}
	row, err := h.q.InsertGenerationLog(ctx, sqlc.InsertGenerationLogParams{
		UserID: userID, NodeID: strings.TrimSpace(input.Body.NodeID), ServiceType: "video", Model: "ffmpeg-local-trim",
		Prompt: fmt.Sprintf("FFmpeg 本地剪辑 %.3f–%.3f 秒；静音=%t", input.Body.Start, input.Body.End, input.Body.Mute),
		Status: "pending",
	})
	if err != nil {
		return nil, toHTTPError(err)
	}
	_ = h.q.MarkGenerationLogRunning(ctx, row.ID)
	result, trimErr := h.svc.TrimLocalVideo(ctx, application.LocalVideoTrimRequest{
		MediaURL: input.Body.MediaURL, Start: input.Body.Start, End: input.Body.End, Mute: input.Body.Mute,
	})
	status, resultURL, message := "success", "", ""
	if trimErr != nil {
		status, message = "error", apperror.PublicMessage(trimErr)
	} else {
		resultURL = result.URL
	}
	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = h.q.UpdateGenerationLogResult(logCtx, sqlc.UpdateGenerationLogResultParams{
		ID: row.ID, Status: status, ResultUrl: resultURL, ErrorMsg: message, DurationMs: int32(min(time.Since(started).Milliseconds(), int64(2147483647))),
	})
	if trimErr != nil {
		appErr := apperror.Normalize(trimErr)
		return nil, huma.NewError(apperror.HTTPStatus(appErr.Code), apperror.PublicMessage(appErr))
	}
	out := &localVideoTrimOutput{}
	out.Body.Data = *result
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}
