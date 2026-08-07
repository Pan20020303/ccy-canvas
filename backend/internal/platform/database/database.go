package database

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Open creates a tuned pgx pool suitable for ~20 concurrent users.
// Defaults are conservative (4 max conns) — bump them so generation requests,
// canvas auto-saves, and admin queries can run in parallel without queueing.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 50
	cfg.MinConns = 5
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = 1 * time.Hour
	cfg.HealthCheckPeriod = 1 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}
