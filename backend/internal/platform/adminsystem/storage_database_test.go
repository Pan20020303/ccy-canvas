package adminsystem

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// All writes are confined to a fresh test schema, never application settings.
func TestStoragePostgresCAS(t *testing.T) {
	dsn := os.Getenv("CCY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CCY_TEST_DATABASE_URL for isolated PostgreSQL tests")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	schema := "storage_settings_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = root.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if !strings.HasPrefix(schema, "storage_settings_test_") || len(schema) != len("storage_settings_test_")+32 {
			t.Fatal("unsafe schema")
		}
		if _, err := root.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	migration, err := os.ReadFile("../../../db/migrations/047_media_storage_settings.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	r := postgresStorage{pool}
	if _, err = r.Write(ctx, 4, "must-not-create"); !errors.Is(err, ErrConflict) {
		t.Fatal("nonzero revision created missing row")
	}
	for _, revision := range []int64{0, 1} {
		var wg sync.WaitGroup
		results := make(chan error, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); _, err := r.Write(ctx, revision, "test-ciphertext"); results <- err }()
		}
		wg.Wait()
		close(results)
		success := 0
		for err := range results {
			if err == nil {
				success++
			} else if !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
		}
		if success != 1 {
			t.Fatalf("revision %d accepted %d writers", revision, success)
		}
	}
	row, err := r.Read(ctx)
	if err != nil || row.Revision != 2 {
		t.Fatalf("bad persisted revision: %+v, %v", row, err)
	}
	// Two independent managers use the database revision, not process-local state.
	t.Setenv("STORAGE_BACKEND", "local")
	if _, err = pool.Exec(ctx, "DELETE FROM media_storage_settings"); err != nil {
		t.Fatal(err)
	}
	key := []byte(strings.Repeat("k", 32))
	first, second := NewStorageManager(pool, key), NewStorageManager(pool, key)
	if _, err = first.Save(ctx, StorageInput{Backend: "local"}); err != nil {
		t.Fatal(err)
	}
	if err = second.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	v, err := second.View(ctx)
	if err != nil || v.Revision != 1 || v.Source != "database" {
		t.Fatal("restart did not load database settings")
	}
	if _, err = second.Save(ctx, StorageInput{Backend: "local"}); !errors.Is(err, ErrConflict) {
		t.Fatal("second manager accepted stale revision")
	}
}
