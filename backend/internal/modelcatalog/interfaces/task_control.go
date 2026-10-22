package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/httpx"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type taskControlQueries interface {
	ListRecentTasksForUser(context.Context, pgtype.UUID, int32) ([]sqlc.TaskControlRow, error)
	CancelQueuedTaskForUser(context.Context, pgtype.UUID, pgtype.UUID) (sqlc.TaskCancellation, error)
}

type cancelledTaskRemover interface {
	RemoveCancelledTask(context.Context, string, string) error
}

type recentTasksInput struct {
	Limit int `query:"limit" minimum:"1" maximum:"200" default:"50"`
}

// Huma shares a schema registry across handlers. An anonymous nested Data
// struct becomes the global "DataStruct" and collides with skill responses.
type TaskCancellationResult struct {
	Task      TaskItem `json:"task"`
	Cancelled bool     `json:"cancelled"`
	Reason    string   `json:"reason"`
}

type cancelTaskOutput struct {
	Body struct {
		Data      TaskCancellationResult `json:"data"`
		RequestID string                 `json:"request_id"`
	}
}

func (h *Handler) taskControlStore() taskControlQueries {
	if h.taskControls != nil {
		return h.taskControls
	}
	if h.q != nil {
		return h.q
	}
	return nil
}

func taskControlUser(ctx context.Context) (pgtype.UUID, error) {
	var userID pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = userID.Scan(claims.UserID)
	}
	if !userID.Valid {
		return userID, huma.Error401Unauthorized("Authentication required")
	}
	return userID, nil
}

func controlTaskItem(row sqlc.TaskControlRow) TaskItem {
	item := TaskItem{ID: formatPgUUID(row.ID), NodeID: row.NodeID, ProjectID: row.ProjectID,
		ProjectName: row.ProjectName, ServiceType: row.ServiceType, Model: row.Model,
		Status: row.Status, ResultURL: row.ResultURL, ErrorMsg: row.ErrorMsg,
		DurationMs: int(row.DurationMs), CanCancel: row.CancellationReason() == ""}
	if row.CreatedAt.Valid {
		item.CreatedAt = row.CreatedAt.Time.UTC().Format(time.RFC3339)
	}
	if row.ResultURLs != "" {
		_ = json.Unmarshal([]byte(row.ResultURLs), &item.ResultURLs)
	}
	switch row.CancellationReason() {
	case "already_started":
		item.CancelReason = "任务已开始执行，当前不能取消；结果将继续返回。"
	case "already_cancelled":
		item.CancelReason = "任务已取消。"
	case "already_finished":
		item.CancelReason = "任务已结束。"
	case "unsupported":
		item.CancelReason = "当前任务不支持安全取消，任务将继续执行并返回结果。"
	}
	return item
}

func (h *Handler) listRecentTasks(ctx context.Context, input *recentTasksInput) (*batchTasksOutput, error) {
	userID, err := taskControlUser(ctx)
	if err != nil {
		return nil, err
	}
	q := h.taskControlStore()
	if q == nil {
		return nil, huma.Error503ServiceUnavailable("Task service unavailable")
	}
	limit := input.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := q.ListRecentTasksForUser(ctx, userID, int32(limit))
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("任务列表暂不可用，请稍后重试")
	}
	out := &batchTasksOutput{}
	out.Body.Data = make([]TaskItem, 0, len(rows))
	for _, row := range rows {
		out.Body.Data = append(out.Body.Data, controlTaskItem(row))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) cancelTask(ctx context.Context, input *getTaskByIDInput) (*cancelTaskOutput, error) {
	userID, err := taskControlUser(ctx)
	if err != nil {
		return nil, err
	}
	var taskID pgtype.UUID
	if taskID.Scan(input.ID) != nil || !taskID.Valid {
		return nil, huma.Error400BadRequest("Invalid task id")
	}
	q := h.taskControlStore()
	if q == nil {
		return nil, huma.Error503ServiceUnavailable("Task service unavailable")
	}
	result, err := q.CancelQueuedTaskForUser(ctx, taskID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("Task not found")
	}
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("未能确认取消，请保留任务跟踪并重试")
	}
	if result.Cancelled {
		// Database cancellation is authoritative. A leased Redis item cannot be
		// removed, but the worker's atomic claim prevents any provider execution.
		if remover, ok := h.tasks.(cancelledTaskRemover); ok && result.Task.AsynqTaskID != "" {
			if err := remover.RemoveCancelledTask(ctx, result.Task.ServiceType, result.Task.AsynqTaskID); err != nil {
				log.Printf("[tasks] cancelled %s; queue cleanup deferred: %v", input.ID, err)
			}
		}
		if h.cache != nil {
			h.cache.Delete(ctx, taskCacheKey(formatPgUUID(userID), input.ID))
		}
		if result.Reason == "cancelled" {
			h.svc.PublishTaskCancellation(formatPgUUID(userID), input.ID, result.Task.NodeID, result.Task.ProjectID, result.Task.ServiceType)
		}
	}
	out := &cancelTaskOutput{}
	out.Body.Data.Task, out.Body.Data.Cancelled, out.Body.Data.Reason = controlTaskItem(result.Task), result.Cancelled, result.Reason
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}
