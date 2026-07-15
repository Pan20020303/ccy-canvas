// Text-generation token-streaming SSE handler. Lives outside the huma router
// (huma envelopes responses in JSON, which breaks SSE) and streams provider
// deltas straight through to the canvas text node.
//
// Client uses fetch()+ReadableStream (EventSource can't POST a body), but the
// wire format is the same `data: {json}\n\n` SSE the task stream uses:
//   - {"type":"token","content":"..."}  one per provider delta
//   - {"type":"done","content":"<full text>"}  terminal success
//   - {"type":"error","message":"..."}  terminal failure
// plus a `: connected` sentinel on open. Credits are reserved up-front (402
// before the stream starts) and refunded only if the stream produced nothing.

package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/shared/httpx"
)

type TextStreamRouter struct {
	svc      *modelapp.Service
	sessions session.Manager
	q        *sqlc.Queries
}

func NewTextStreamRouter(svc *modelapp.Service, sessions session.Manager, q *sqlc.Queries) *TextStreamRouter {
	return &TextStreamRouter{svc: svc, sessions: sessions, q: q}
}

// RegisterChi attaches POST /api/app/text/stream to the supplied router.
func (rt *TextStreamRouter) RegisterChi(r chi.Router) {
	r.Post("/api/app/text/stream", rt.handleStream)
}

type textStreamBody struct {
	Model     string   `json:"model"`
	Prompt    string   `json:"prompt"`
	NodeID    string   `json:"node_id"`
	ProjectID string   `json:"project_id"`
	ImageUrls []string `json:"image_urls"` // 视觉文本模型(qwen3.7-plus 等)的参考图
}

func (rt *TextStreamRouter) handleStream(w http.ResponseWriter, r *http.Request) {
	// Cookie auth — same pattern as the task stream handler.
	cookie, err := r.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	claims, err := rt.sessions.Parse(cookie.Value)
	if err != nil || claims.UserID == "" {
		httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}

	var body textStreamBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Prompt is required"})
		return
	}

	// Collab read-only: visitors can't generate (defense-in-depth mirroring the
	// regular /generate handler; the frontend also early-returns for visitors).
	// Only enforced when a project_id is supplied; unknown/lookup-error is let
	// through (canvas-write guards still apply elsewhere).
	if pid := strings.TrimSpace(body.ProjectID); pid != "" && rt.q != nil {
		if isProjectVisitor(r.Context(), rt.q, pid, claims.UserID) {
			httpx.WriteJSON(w, r, http.StatusForbidden, map[string]string{"error": "你是访问者(只读)，无法在该协作项目生成"})
			return
		}
	}

	genReq := modelapp.GenerateRequest{
		ServiceType:     "text",
		Model:           body.Model,
		Prompt:          body.Prompt,
		ReferenceImages: body.ImageUrls,
	}

	// Reserve credits up-front so we can hard-block (402) BEFORE any work and
	// before switching the response into SSE mode (after that we can't set a
	// non-200 status). A stream that produces nothing is refunded below.
	cost := rt.svc.ResolveGenerationCost(genReq)
	if cost > 0 {
		if rerr := rt.svc.ReserveCredits(r.Context(), claims.UserID, cost, "reserve: text stream node="+body.NodeID); rerr != nil {
			if errors.Is(rerr, modelapp.ErrInsufficientCredits) {
				httpx.WriteJSON(w, r, http.StatusPaymentRequired, map[string]string{"error": "积分不足，请充值或开通会员后重试"})
				return
			}
			httpx.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "Failed to reserve credits"})
			return
		}
	}

	// Panic safety: a panic in StreamText (or a delta callback) would otherwise
	// skip the refund path below and leave the reserve stuck. Refund + log.
	settled := false
	defer func() {
		if rec := recover(); rec != nil {
			if cost > 0 && !settled {
				rt.svc.RefundCredits(context.Background(), claims.UserID, cost, "refund: text stream panic node="+body.NodeID)
			}
			log.Printf("[text-stream] recovered panic for user %s node %s: %v", claims.UserID, body.NodeID, rec)
		}
	}()

	// SSE headers. X-Accel-Buffering disables nginx buffering for real-time.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	writeFrame := func(v any) error {
		payload, merr := json.Marshal(v)
		if merr != nil {
			return merr
		}
		if _, werr := fmt.Fprintf(w, "data: %s\n\n", payload); werr != nil {
			return werr
		}
		flusher.Flush()
		return nil
	}

	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	full, serr := rt.svc.StreamText(r.Context(), genReq, func(delta string) error {
		return writeFrame(map[string]string{"type": "token", "content": delta})
	})
	settled = true
	if serr != nil {
		// 退款判定:
		//  ① 客户端中断(浏览器 120s 超时 aborter.abort() / 断网 / 关页面):用户没
		//     拿到可用结果、多半会「一段时间没返回就重发一条一样的」,若此处保留扣费
		//     就会双扣。故只要是客户端取消,无论是否已产出部分 token,一律退款。
		//  ② 真实的 provider/配置失败且零产出。
		// 两者都退;只有「真实失败但已流出部分文本」才保留(用户确实拿到了内容)。
		clientGone := r.Context().Err() != nil || errors.Is(serr, context.Canceled) || errors.Is(serr, context.DeadlineExceeded)
		if cost > 0 && (clientGone || strings.TrimSpace(full) == "") {
			rt.svc.RefundCredits(context.Background(), claims.UserID, cost, "refund: text stream "+refundReasonForStream(clientGone)+" node="+body.NodeID)
		}
		_ = writeFrame(map[string]string{"type": "error", "message": serr.Error()})
		return
	}
	_ = writeFrame(map[string]string{"type": "done", "content": full})
}

func refundReasonForStream(clientGone bool) string {
	if clientGone {
		return "canceled"
	}
	return "failed"
}
