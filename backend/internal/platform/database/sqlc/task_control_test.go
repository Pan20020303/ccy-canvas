package sqlc

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// Transactional in-memory fake: BEGIN holds the same row lock as worker claims;
// writes remain private until COMMIT. No database or generation service is used.
type taskTestState struct {
	row                     TaskControlRow
	owner                   pgtype.UUID
	personal                int32
	project, consumed, used int64
	ledgers                 int
}
type taskTestDB struct {
	DBTX
	mu    sync.Mutex
	state taskTestState
	fail  string
}
type taskTestTx struct {
	pgx.Tx
	db     *taskTestDB
	state  taskTestState
	closed bool
}
type taskTestRow struct {
	values []any
	err    error
}

func (r taskTestRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("unexpected projection")
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}
func taskTestUUID(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
func taskTestDatabase(scope string) *taskTestDB {
	return &taskTestDB{state: taskTestState{
		owner: taskTestUUID(2), personal: 10, project: 20, consumed: 9, used: 8,
		row: TaskControlRow{ID: taskTestUUID(1), NodeID: "node", ServiceType: "video", Model: "offline",
			Status: "queued", AsynqTaskID: "redis-id", BillingVerified: true,
			Payload: []byte(`{"CreditCost":7,"CreditScope":"` + scope + `","credit_reserved":true,"project_id":"03000000-0000-0000-0000-000000000000"}`)},
	}}
}
func (d *taskTestDB) Begin(context.Context) (pgx.Tx, error) {
	d.mu.Lock()
	if d.fail == "begin" {
		d.mu.Unlock()
		return nil, errors.New("begin unavailable")
	}
	return &taskTestTx{db: d, state: d.state}, nil
}
func (d *taskTestDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.fail == "claim" {
		return pgconn.CommandTag{}, errors.New("claim unavailable")
	}
	if !strings.Contains(sql, "status IN ('pending','queued','running','retrying')") {
		return pgconn.CommandTag{}, errors.New("claim must guard terminal rows")
	}
	if args[0] != d.state.row.ID || !strings.Contains("|pending|queued|running|retrying|", "|"+d.state.row.Status+"|") {
		return pgconn.NewCommandTag("UPDATE 0"), nil
	}
	d.state.row.Status, d.state.row.ExecutionStarted = "running", true
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func (tx *taskTestTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	s := &tx.state
	switch {
	case strings.Contains(sql, "FROM generation_logs"):
		if !strings.Contains(sql, "FOR UPDATE") || args[0] != s.row.ID || args[1] != s.owner {
			return taskTestRow{err: pgx.ErrNoRows}
		}
		r := s.row
		return taskTestRow{values: []any{r.ID, r.NodeID, r.ProjectID, r.ServiceType, r.Model, r.Status, r.ResultURL, r.ResultURLs, r.ErrorMsg, r.DurationMs, r.CreatedAt, r.AsynqTaskID, r.ExecutionStarted, r.BillingVerified, r.Payload}}
	case strings.Contains(sql, "UPDATE credit_accounts"):
		if tx.db.fail == "balance" {
			return taskTestRow{err: errors.New("account unavailable")}
		}
		if args[0] != s.owner {
			return taskTestRow{err: errors.New("wrong account owner")}
		}
		s.personal += args[1].(int32)
		return taskTestRow{values: []any{taskTestUUID(4), s.owner, int32(10), s.personal, "UTC", pgtype.Date{}, "active", pgtype.Timestamptz{}}}
	case strings.Contains(sql, "UPDATE project_credit_accounts"):
		if tx.db.fail == "balance" {
			return taskTestRow{err: errors.New("project account unavailable")}
		}
		if args[0] != taskTestUUID(3) {
			return taskTestRow{err: errors.New("wrong project account")}
		}
		s.project += int64(args[1].(int32))
		s.consumed -= int64(args[1].(int32))
		return taskTestRow{values: []any{s.project}}
	case strings.Contains(sql, "SELECT used FROM project_credit_member_limits"):
		return taskTestRow{values: []any{s.used}}
	}
	return taskTestRow{err: errors.New("unexpected SQL query")}
}
func (tx *taskTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	s := &tx.state
	switch {
	case strings.Contains(sql, "INSERT INTO credit_ledger_entries"), strings.Contains(sql, "INSERT INTO project_credit_ledger_entries"):
		if tx.db.fail == "ledger" {
			return pgconn.CommandTag{}, errors.New("ledger unavailable")
		}
		s.ledgers++
	case strings.Contains(sql, "INSERT INTO project_credit_member_limits"):
		if args[0] != taskTestUUID(3) || args[1] != s.owner {
			return pgconn.CommandTag{}, errors.New("wrong member quota")
		}
		s.used -= int64(args[2].(int32))
		if s.used < 0 {
			s.used = 0
		}
	case strings.Contains(sql, "UPDATE generation_logs"):
		if tx.db.fail == "transition" {
			return pgconn.CommandTag{}, errors.New("transition unavailable")
		}
		if args[0] != s.row.ID || args[1] != s.owner || s.row.Status != "queued" || s.row.ExecutionStarted {
			return pgconn.NewCommandTag("UPDATE 0"), nil
		}
		s.row.Status = "cancelled"
	default:
		return pgconn.CommandTag{}, errors.New("unexpected SQL exec")
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func (tx *taskTestTx) Commit(context.Context) error {
	if tx.db.fail == "commit" {
		return errors.New("commit failed")
	}
	tx.db.state = tx.state
	tx.closed = true
	tx.db.mu.Unlock()
	if tx.db.fail == "commit_ack" {
		return errors.New("commit acknowledgement lost")
	}
	return nil
}
func (tx *taskTestTx) Rollback(context.Context) error {
	if !tx.closed {
		tx.closed = true
		tx.db.mu.Unlock()
	}
	return nil
}

func TestCancelQueuedTaskRefundsOriginalAccountOnce(t *testing.T) {
	for _, scope := range []string{"personal", "project"} {
		t.Run(scope, func(t *testing.T) {
			db := taskTestDatabase(scope)
			q := New(db)
			result, err := q.CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
			if err != nil || !result.Cancelled || result.Reason != "cancelled" {
				t.Fatalf("cancel: %+v %v", result, err)
			}
			replay, err := q.CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
			if err != nil || !replay.Cancelled || replay.Reason != "already_cancelled" {
				t.Fatalf("replay: %+v %v", replay, err)
			}
			if db.state.ledgers != 1 {
				t.Fatalf("ledger entries = %d", db.state.ledgers)
			}
			if scope == "personal" && (db.state.personal != 17 || db.state.project != 20) {
				t.Fatalf("wrong personal refund: %+v", db.state)
			}
			if scope == "project" && (db.state.personal != 10 || db.state.project != 27 || db.state.consumed != 2 || db.state.used != 1) {
				t.Fatalf("wrong project refund: %+v", db.state)
			}
		})
	}
}

func TestCancellationFailuresRollBackTaskBalanceAndLedger(t *testing.T) {
	for _, scope := range []string{"personal", "project"} {
		for _, stage := range []string{"begin", "balance", "ledger", "transition", "commit"} {
			t.Run(scope+"/"+stage, func(t *testing.T) {
				db := taskTestDatabase(scope)
				db.fail = stage
				_, err := New(db).CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
				if err == nil {
					t.Fatal("expected failure")
				}
				if db.state.row.Status != "queued" || db.state.personal != 10 || db.state.project != 20 || db.state.ledgers != 0 {
					t.Fatalf("partial transaction leaked: %+v", db.state)
				}
			})
		}
	}
}

func TestCancellationCommitUncertaintyIsSafeToRetry(t *testing.T) {
	db := taskTestDatabase("personal")
	db.fail = "commit_ack"
	q := New(db)
	if _, err := q.CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2)); err == nil {
		t.Fatal("expected uncertain response")
	}
	db.fail = ""
	result, err := q.CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
	if err != nil || result.Reason != "already_cancelled" || db.state.personal != 17 || db.state.ledgers != 1 {
		t.Fatalf("unsafe retry: %+v %+v %v", result, db.state, err)
	}
}

func TestCancellationDoesNotTouchStartedTerminalLegacyOrUnownedTasks(t *testing.T) {
	for _, status := range []string{"running", "persisting", "success", "error", "retrying", "pending"} {
		t.Run(status, func(t *testing.T) {
			db := taskTestDatabase("personal")
			db.state.row.Status = status
			r, err := New(db).CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
			if err != nil || r.Cancelled || r.Task.Status != status || db.state.ledgers != 0 {
				t.Fatalf("changed unsupported task: %+v %v", r, err)
			}
		})
	}
	for _, field := range []string{"execution", "queue", "billing", "owner"} {
		t.Run(field, func(t *testing.T) {
			db := taskTestDatabase("personal")
			owner := taskTestUUID(2)
			switch field {
			case "execution":
				db.state.row.ExecutionStarted = true
			case "queue":
				db.state.row.AsynqTaskID = ""
			case "billing":
				db.state.row.BillingVerified = false
			case "owner":
				owner = taskTestUUID(9)
			}
			r, err := New(db).CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), owner)
			if field == "owner" && !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("ownership not enforced: %v", err)
			}
			if r.Cancelled || db.state.row.Status != "queued" || db.state.ledgers != 0 {
				t.Fatal("unsupported task mutated")
			}
		})
	}
}

func TestCancellationAndWorkerClaimCompeteOnTheSameRow(t *testing.T) {
	for i := 0; i < 100; i++ {
		db := taskTestDatabase("personal")
		q := New(db)
		start := make(chan struct{})
		var wg sync.WaitGroup
		var result TaskCancellation
		var claimed bool
		var cancelErr, claimErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			result, cancelErr = q.CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
		}()
		go func() {
			defer wg.Done()
			<-start
			claimed, claimErr = q.ClaimGenerationExecution(context.Background(), taskTestUUID(1))
		}()
		close(start)
		wg.Wait()
		if cancelErr != nil || claimErr != nil {
			t.Fatalf("race errors: %v %v", cancelErr, claimErr)
		}
		if result.Cancelled == claimed {
			t.Fatalf("exactly one may win: cancel=%t claim=%t", result.Cancelled, claimed)
		}
		if result.Cancelled && (db.state.personal != 17 || db.state.row.Status != "cancelled") {
			t.Fatal("cancel winner lost refund or state")
		}
		if claimed && (db.state.personal != 10 || db.state.row.Status != "running") {
			t.Fatal("execution winner was refunded or cancelled")
		}
	}
}

func TestWorkerClaimRequiresDatabaseConfirmation(t *testing.T) {
	db := taskTestDatabase("personal")
	db.fail = "claim"
	claimed, err := New(db).ClaimGenerationExecution(context.Background(), taskTestUUID(1))
	if err == nil || claimed {
		t.Fatal("database failure cannot authorize provider execution")
	}
	db.fail = ""
	db.state.row.Status = "cancelled"
	claimed, err = New(db).ClaimGenerationExecution(context.Background(), taskTestUUID(1))
	if err != nil || claimed {
		t.Fatal("cancelled task cannot execute on redelivery")
	}
}

func TestZeroCostQueuedTaskCancelsWithoutAnyCreditMutation(t *testing.T) {
	db := taskTestDatabase("personal")
	db.state.row.Payload = []byte(`{"CreditCost":0,"CreditScope":"personal"}`)
	result, err := New(db).CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
	if err != nil || !result.Cancelled || db.state.personal != 10 || db.state.project != 20 || db.state.ledgers != 0 {
		t.Fatalf("zero-cost cancellation: %+v %+v %v", result, db.state, err)
	}
}

func TestPaidCancellationNeverGuessesWhetherAReserveOccurred(t *testing.T) {
	db := taskTestDatabase("personal")
	// Even if the initial projection is stale, absence of the durable reserve
	// flag is checked again inside the locked transaction before any credit write.
	db.state.row.Payload = []byte(`{"CreditCost":7,"CreditScope":"personal"}`)
	result, err := New(db).CancelQueuedTaskForUser(context.Background(), taskTestUUID(1), taskTestUUID(2))
	if err == nil || result.Cancelled || db.state.personal != 10 || db.state.ledgers != 0 || db.state.row.Status != "queued" {
		t.Fatalf("unproven reserve was refunded: %+v %v", db.state, err)
	}
}
