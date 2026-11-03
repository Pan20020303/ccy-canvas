// Package events provides a Redis Pub/Sub implementation of the model
// catalog's EventTransport, used to fan task-completion events across
// multiple backend replicas (F7). Single-process deployments don't need
// it — the in-process bus delivers directly.
package events

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// RedisTransport bridges task events between backend replicas over a Redis
// Pub/Sub channel. It satisfies application.EventTransport.
type RedisTransport struct {
	client *redis.Client
}

// NewRedisTransport builds a transport from a Redis address. Returns nil
// when addr is empty so callers can treat "no Redis" as "no transport".
func NewRedisTransport(addr, password string, db int) *RedisTransport {
	if addr == "" {
		return nil
	}
	return &RedisTransport{
		client: redis.NewClient(&redis.Options{
			Addr:     addr,
			Password: password,
			DB:       db,
		}),
	}
}

// Publish broadcasts payload to all subscribers of channel.
func (t *RedisTransport) Publish(ctx context.Context, channel string, payload []byte) error {
	return t.client.Publish(ctx, channel, payload).Err()
}

// Subscribe returns a stream of payloads published to channel. A goroutine
// pumps Redis messages into the returned channel and closes it when ctx is
// done (or the subscription drops). go-redis transparently reconnects the
// underlying PubSub, so the stream survives brief Redis blips.
func (t *RedisTransport) Subscribe(ctx context.Context, channel string) (<-chan []byte, error) {
	pubsub := t.client.Subscribe(ctx, channel)
	// Wait for the subscription to be established so an immediate publish
	// isn't missed.
	if _, err := pubsub.Receive(ctx); err != nil {
		_ = pubsub.Close()
		return nil, err
	}
	out := make(chan []byte, 64)
	go func() {
		defer close(out)
		defer func() { _ = pubsub.Close() }()
		ch := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				select {
				case out <- []byte(msg.Payload):
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

// Close releases the underlying Redis connection.
func (t *RedisTransport) Close() error {
	if t == nil || t.client == nil {
		return nil
	}
	return t.client.Close()
}
