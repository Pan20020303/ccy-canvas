package sqlctx

import (
	"context"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

type queriesKey struct{}

func WithQueries(ctx context.Context, queries *sqlc.Queries) context.Context {
	return context.WithValue(ctx, queriesKey{}, queries)
}

func FromContext(ctx context.Context) (*sqlc.Queries, bool) {
	queries, ok := ctx.Value(queriesKey{}).(*sqlc.Queries)
	return queries, ok
}
