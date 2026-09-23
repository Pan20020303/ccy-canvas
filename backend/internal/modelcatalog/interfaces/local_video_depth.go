package interfaces

import (
	"context"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"
)

type localVideoDepthInput struct {
	Body struct {
		MediaURL  string `json:"media_url" minLength:"1" maxLength:"8192"`
		Invert    bool   `json:"invert,omitempty" doc:"Invert near/far grayscale values"`
		NodeID    string `json:"node_id" minLength:"1" maxLength:"200"`
		ProjectID string `json:"project_id,omitempty" maxLength:"64" doc:"Owning canvas project id for task recovery"`
	}
}

type localVideoDepthOutput struct {
	Body struct {
		Data      application.LocalVideoDepthResult `json:"data"`
		RequestID string                            `json:"request_id"`
		TaskID    string                            `json:"task_id,omitempty"`
	}
}

func (h *Handler) localVideoDepth(ctx context.Context, input *localVideoDepthInput) (*localVideoDepthOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, toHTTPError(apperror.New(apperror.CodeUnauthenticated, "请先登录"))
	}
	var userID pgtype.UUID
	if err := userID.Scan(claims.UserID); err != nil || !userID.Valid {
		return nil, toHTTPError(apperror.New(apperror.CodeUnauthenticated, "登录状态无效"))
	}
	if h.q == nil {
		return nil, toHTTPError(apperror.New(apperror.CodeInternal, "深度动作日志服务不可用"))
	}
	started := time.Now()
	row, err := h.q.InsertGenerationLog(ctx, sqlc.InsertGenerationLogParams{
		UserID: userID, NodeID: strings.TrimSpace(input.Body.NodeID), ServiceType: "video", Model: "video-depth-anything-small",
		Prompt: "生成时序一致的灰度深度动作参考视频", Status: "pending",
	})
	if err != nil {
		return nil, toHTTPError(err)
	}
	if projectID := strings.TrimSpace(input.Body.ProjectID); projectID != "" {
		if err := h.q.SetGenerationLogProjectID(ctx, row.ID, projectID); err != nil {
			return nil, toHTTPError(err)
		}
	}
	_ = h.q.MarkGenerationLogRunning(ctx, row.ID)

	// This task deliberately outlives the browser request. If the user refreshes
	// or switches pages, the generation log lets the normal node task poller
	// reconnect and hydrate the result by node id.
	processingCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	result, depthErr := h.svc.CreateLocalDepthVideo(processingCtx, application.LocalVideoDepthRequest{MediaURL: input.Body.MediaURL, Invert: input.Body.Invert})
	status, resultURL, message := "success", "", ""
	if depthErr != nil {
		status, message = "error", apperror.PublicMessage(depthErr)
	} else {
		resultURL = result.URL
	}
	logCtx, logCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer logCancel()
	_ = h.q.UpdateGenerationLogResult(logCtx, sqlc.UpdateGenerationLogResultParams{
		ID: row.ID, Status: status, ResultUrl: resultURL, ErrorMsg: message,
		DurationMs: int32(min(time.Since(started).Milliseconds(), int64(2147483647))),
	})
	if depthErr != nil {
		appErr := apperror.Normalize(depthErr)
		return nil, huma.NewError(apperror.HTTPStatus(appErr.Code), apperror.PublicMessage(appErr))
	}
	out := &localVideoDepthOutput{}
	out.Body.Data = *result
	out.Body.Data.TaskID = formatPgUUID(row.ID)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	out.Body.TaskID = formatPgUUID(row.ID)
	return out, nil
}
