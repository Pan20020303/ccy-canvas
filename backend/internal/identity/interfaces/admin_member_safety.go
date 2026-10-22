package interfaces

import (
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"context"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"strings"
)

// Serialize permission changes across replicas and recheck the acting admin
// inside the transaction. Two admins cannot concurrently remove one another.
func (h *AdminHandler) beginMemberChange(ctx context.Context, target string, protectSelf bool) (pgx.Tx, *sqlc.Queries, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok || claims.Role != "admin" {
		return nil, nil, huma.Error403Forbidden("需要管理员权限")
	}
	if protectSelf && strings.EqualFold(claims.UserID, target) {
		return nil, nil, huma.Error400BadRequest("不能在成员管理中更改自己的角色、停用或删除自己的账号")
	}
	if h.pool == nil {
		return nil, nil, huma.Error503ServiceUnavailable("成员管理事务暂不可用")
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, nil, huma.Error503ServiceUnavailable("数据库暂不可用")
	}
	ok = false
	defer func() {
		if !ok {
			_ = tx.Rollback(ctx)
		}
	}()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(772041)`); err != nil {
		return nil, nil, huma.Error503ServiceUnavailable("无法锁定成员更改")
	}
	q := h.q.WithTx(tx)
	actorID, _ := parseUUID(claims.UserID)
	actor, err := q.GetUserByID(ctx, actorID)
	if err != nil || actor.Role != "admin" || actor.Status != "active" {
		return nil, nil, huma.Error403Forbidden("当前账号已无管理员权限，请刷新页面")
	}
	targetID, err := parseUUID(target)
	if err != nil {
		return nil, nil, huma.Error400BadRequest("无效成员 ID")
	}
	if _, err = q.GetUserByID(ctx, targetID); err != nil {
		return nil, nil, huma.Error404NotFound("成员不存在，请刷新列表")
	}
	ok = true
	return tx, q, nil
}
