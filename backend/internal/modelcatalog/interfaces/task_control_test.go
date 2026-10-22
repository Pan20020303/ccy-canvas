package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/session"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const controlOwner = "02000000-0000-0000-0000-000000000000"
const controlID = "01000000-0000-0000-0000-000000000000"

type controlsFake struct {
	result sqlc.TaskCancellation
	err    error
	calls  int
	user   string
	limit  int32
}

func (f *controlsFake) ListRecentTasksForUser(_ context.Context, user pgtype.UUID, limit int32) ([]sqlc.TaskControlRow, error) {
	f.calls++
	f.user = formatPgUUID(user)
	f.limit = limit
	return []sqlc.TaskControlRow{f.result.Task}, f.err
}
func (f *controlsFake) CancelQueuedTaskForUser(_ context.Context, id, user pgtype.UUID) (sqlc.TaskCancellation, error) {
	f.calls++
	f.user = formatPgUUID(user)
	if formatPgUUID(id) != controlID || f.user != controlOwner {
		return sqlc.TaskCancellation{}, pgx.ErrNoRows
	}
	return f.result, f.err
}

type cleanupFake struct {
	calls int
	err   error
}

func (*cleanupFake) Enabled() bool { return true }
func (*cleanupFake) Enqueue(context.Context, TaskGenerationPayload) (string, error) {
	panic("test must never generate")
}
func (f *cleanupFake) RemoveCancelledTask(context.Context, string, string) error {
	f.calls++
	return f.err
}

func controlFixture(t *testing.T, fake *controlsFake, queue *cleanupFake) (http.Handler, session.Manager) {
	t.Helper()
	router := chi.NewMux()
	api := httpapi.New(router)
	manager := session.NewManager("01234567890123456789012345678901", false)
	api.UseMiddleware(authn.Middleware(api, manager))
	h := NewHandler(application.NewService(nil, nil), nil)
	h.taskControls = fake
	h.tasks = queue
	h.RegisterRoutes(api)
	return router, manager
}
func controlRequest(t *testing.T, router http.Handler, manager session.Manager, method, path, user string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if user != "" {
		cookie, err := manager.NewCookie(user, "member")
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
func controlRow(status string) sqlc.TaskControlRow {
	var id pgtype.UUID
	_ = id.Scan(controlID)
	return sqlc.TaskControlRow{ID: id, NodeID: "n1", ProjectID: "p1", ProjectName: "Test project", ServiceType: "video", Model: "offline-model", Status: status, AsynqTaskID: "redis-task", BillingVerified: true, Payload: []byte(`{"secret":"never expose"}`)}
}

func TestTaskControlRoutesRequireOwnershipAndDoNotGenerate(t *testing.T) {
	fake := &controlsFake{result: sqlc.TaskCancellation{Task: controlRow("queued")}}
	queue := &cleanupFake{}
	router, manager := controlFixture(t, fake, queue)
	if got := controlRequest(t, router, manager, http.MethodPost, "/api/app/tasks/"+controlID+"/cancel", "").Code; got != 401 {
		t.Fatalf("anonymous=%d", got)
	}
	if fake.calls != 0 {
		t.Fatal("unauthenticated request reached persistence")
	}
	if got := controlRequest(t, router, manager, http.MethodPost, "/api/app/tasks/"+controlID+"/cancel", "03000000-0000-0000-0000-000000000000").Code; got != 404 {
		t.Fatalf("unowned=%d", got)
	}
	if queue.calls != 0 {
		t.Fatal("unowned request cleaned queue")
	}
}

func TestCancelReturnsActualRunningStateAndKeepsQueueUntouched(t *testing.T) {
	fake := &controlsFake{result: sqlc.TaskCancellation{Task: controlRow("running"), Reason: "already_started"}}
	queue := &cleanupFake{}
	router, manager := controlFixture(t, fake, queue)
	response := controlRequest(t, router, manager, http.MethodPost, "/api/app/tasks/"+controlID+"/cancel", controlOwner)
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var body cancelTaskOutput
	if err := json.Unmarshal(response.Body.Bytes(), &body.Body); err != nil {
		t.Fatal(err)
	}
	if body.Body.Data.Cancelled || body.Body.Data.Task.Status != "running" || body.Body.Data.Task.ID != controlID || body.Body.Data.Task.CanCancel || queue.calls != 0 {
		t.Fatalf("running task changed: %+v", body.Body.Data)
	}
}

func TestCancelCommitAndQueueCleanupFailureStillReturnConfirmedCancellation(t *testing.T) {
	fake := &controlsFake{result: sqlc.TaskCancellation{Task: controlRow("cancelled"), Cancelled: true, Reason: "cancelled"}}
	queue := &cleanupFake{err: errors.New("leased task cannot be deleted")}
	router, manager := controlFixture(t, fake, queue)
	response := controlRequest(t, router, manager, http.MethodPost, "/api/app/tasks/"+controlID+"/cancel", controlOwner)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"cancelled":true`) || queue.calls != 1 {
		t.Fatalf("cancellation lost: %d %s", response.Code, response.Body.String())
	}
}

func TestCancelTransactionFailureDoesNotPretendSuccessOrCleanQueue(t *testing.T) {
	fake := &controlsFake{err: errors.New("refund transaction unavailable")}
	queue := &cleanupFake{}
	router, manager := controlFixture(t, fake, queue)
	response := controlRequest(t, router, manager, http.MethodPost, "/api/app/tasks/"+controlID+"/cancel", controlOwner)
	if response.Code != 503 || queue.calls != 0 {
		t.Fatalf("unsafe cancellation: %d", response.Code)
	}
}

func TestRecentTasksUsesDurableProjectionWithoutPayload(t *testing.T) {
	fake := &controlsFake{result: sqlc.TaskCancellation{Task: controlRow("queued")}}
	router, manager := controlFixture(t, fake, &cleanupFake{})
	response := controlRequest(t, router, manager, http.MethodGet, "/api/app/tasks/recent?limit=50", controlOwner)
	if response.Code != 200 || fake.user != controlOwner || fake.limit != 50 {
		t.Fatalf("recent: %d %s", response.Code, response.Body.String())
	}
	text := response.Body.String()
	if strings.Contains(text, "never expose") || strings.Contains(text, "redis-task") || strings.Contains(text, "Payload") {
		t.Fatal("private task internals leaked")
	}
	if !strings.Contains(text, `"can_cancel":true`) || !strings.Contains(text, `"project_name":"Test project"`) {
		t.Fatal("missing real task metadata")
	}
}
