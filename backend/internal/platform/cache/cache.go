package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// JSONCache is a tiny Redis-backed cache. It is intentionally best-effort:
// callers should always be able to fall back to Postgres when Redis is down.
type JSONCache struct {
	client *redis.Client
	prefix string
}

func NewJSONCache(addr, password string, db int, prefix string) *JSONCache {
	if addr == "" {
		return nil
	}
	return &JSONCache{
		client: redis.NewClient(&redis.Options{
			Addr:     addr,
			Password: password,
			DB:       db,
		}),
		prefix: prefix,
	}
}

func (c *JSONCache) Enabled() bool {
	return c != nil && c.client != nil
}

func (c *JSONCache) Close() error {
	if !c.Enabled() {
		return nil
	}
	return c.client.Close()
}

func (c *JSONCache) key(key string) string {
	if c.prefix == "" {
		return key
	}
	return c.prefix + ":" + key
}

func (c *JSONCache) Get(ctx context.Context, key string, dst any) bool {
	if !c.Enabled() {
		return false
	}
	raw, err := c.client.Get(ctx, c.key(key)).Bytes()
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, dst) == nil
}

func (c *JSONCache) Set(ctx context.Context, key string, value any, ttl time.Duration) {
	if !c.Enabled() {
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	_ = c.client.Set(ctx, c.key(key), raw, ttl).Err()
}

func (c *JSONCache) Delete(ctx context.Context, keys ...string) {
	if !c.Enabled() || len(keys) == 0 {
		return
	}
	prefixed := make([]string, 0, len(keys))
	for _, key := range keys {
		prefixed = append(prefixed, c.key(key))
	}
	_ = c.client.Del(ctx, prefixed...).Err()
}

func (c *JSONCache) DeletePattern(ctx context.Context, pattern string) {
	if !c.Enabled() {
		return
	}
	iter := c.client.Scan(ctx, 0, c.key(pattern), 100).Iterator()
	keys := make([]string, 0, 100)
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
		if len(keys) >= 100 {
			_ = c.client.Del(ctx, keys...).Err()
			keys = keys[:0]
		}
	}
	if len(keys) > 0 {
		_ = c.client.Del(ctx, keys...).Err()
	}
}

func (c *JSONCache) Ping(ctx context.Context) error {
	if !c.Enabled() {
		return errors.New("redis cache not configured")
	}
	return c.client.Ping(ctx).Err()
}
