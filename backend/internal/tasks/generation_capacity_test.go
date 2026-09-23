package tasks

import (
	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGenerationCapacityPolicy(t *testing.T) {
	tests := []struct {
		model, service, family string
		count, limit, weight   int
	}{
		{"doubao-seedream-5-0-260128", "image", "seedream", 0, 10, 1},
		{"seedream-4.5", "image", "seedream", 6, 10, 6},
		{"gpt-image-2", "image", "other-image", 1, 3, 1},
		{"z-image-turbo-local", "image", "local-image", 1, 1, 1},
		{"seedance", "video", "", 1, 0, 0},
	}
	for _, test := range tests {
		family, limit, weight := generationCapacityPolicy(modelapp.GenerateRequest{Model: test.model, ServiceType: test.service, OutputCount: test.count})
		if family != test.family || limit != test.limit || weight != test.weight {
			t.Errorf("%s got %s %d %d", test.model, family, limit, weight)
		}
	}
	if generationIsFailure(errGenerationCapacity) {
		t.Fatal("waiting must not consume retry budget")
	}
	if generationRetryDelay(99, errGenerationCapacity, nil) != 3*time.Second {
		t.Fatal("waiting must not exponentially back off")
	}
	if !generationIsFailure(errors.New("upstream failed")) {
		t.Fatal("real failures must remain failures")
	}
	var limiter *generationCapacity
	if _, err := limiter.acquire(context.Background(), modelapp.GenerateRequest{ServiceType: "image", Model: "seedream", OutputCount: 11}); err == nil {
		t.Fatal("oversized output count must be rejected")
	}
	if _, err := limiter.acquire(context.Background(), modelapp.GenerateRequest{ServiceType: "image", Model: "seedream"}); !errors.Is(err, errGenerationCapacity) {
		t.Fatal("unavailable scheduler must fail closed")
	}
}

func capacityTestRedis(t *testing.T) *generationCapacity {
	t.Helper()
	addr := os.Getenv("CCY_CAPACITY_TEST_REDIS")
	if addr == "" {
		t.Skip("set CCY_CAPACITY_TEST_REDIS for isolated Redis integration tests")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	prefix := "ccy:test-generation-capacity:" + uuid.NewString() + ":"
	limiter := &generationCapacity{client: client, prefix: prefix}
	t.Cleanup(func() {
		// Exact test-owned keys only; never touch production scheduler or queues.
		client.Del(context.Background(), prefix+"seedream", prefix+"other-image", prefix+"local-image")
		client.Close()
	})
	return limiter
}

func TestGenerationCapacityRedisFiftyAcrossReplicas(t *testing.T) {
	first := capacityTestRedis(t)
	second := &generationCapacity{client: first.client, prefix: first.prefix}
	var peak, active, finished atomic.Int32
	var wait sync.WaitGroup
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for n := 0; n < 50; n++ {
		wait.Add(1)
		go func(n int) {
			defer wait.Done()
			limiter := first
			if n%2 == 0 {
				limiter = second
			}
			for {
				release, err := limiter.acquire(ctx, modelapp.GenerateRequest{ServiceType: "image", Model: "seedream-5"})
				if errors.Is(err, errGenerationCapacity) {
					select {
					case <-ctx.Done():
						t.Error(ctx.Err())
						return
					case <-time.After(2 * time.Millisecond):
						continue
					}
				}
				if err != nil {
					t.Error(err)
					return
				}
				current := active.Add(1)
				for old := peak.Load(); current > old && !peak.CompareAndSwap(old, current); old = peak.Load() {
				}
				time.Sleep(15 * time.Millisecond)
				active.Add(-1)
				release()
				finished.Add(1)
				return
			}
		}(n)
	}
	wait.Wait()
	if finished.Load() != 50 || peak.Load() > 10 || peak.Load() < 2 {
		t.Fatalf("finished=%d peak=%d", finished.Load(), peak.Load())
	}
	if count := first.client.ZCard(ctx, first.prefix+"seedream").Val(); count != 0 {
		t.Fatalf("leaked %d slots", count)
	}
}

func TestGenerationCapacityRedisWeightedAndExpiry(t *testing.T) {
	limiter := capacityTestRedis(t)
	ctx := context.Background()
	req := modelapp.GenerateRequest{ServiceType: "image", Model: "doubao-seedream", OutputCount: 6}
	release, err := limiter.acquire(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	req.OutputCount = 5
	if _, err = limiter.acquire(ctx, req); !errors.Is(err, errGenerationCapacity) {
		t.Fatal("6+5 outputs must wait")
	}
	req.OutputCount = 4
	release2, err := limiter.acquire(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	req.OutputCount = 1
	if _, err = limiter.acquire(ctx, req); !errors.Is(err, errGenerationCapacity) {
		t.Fatal("10+1 outputs must wait")
	}
	release()
	release()
	release2()
	key := limiter.prefix + "seedream"
	limiter.client.ZAdd(ctx, key, redis.Z{Score: 1, Member: "expired-worker"})
	req.OutputCount = 10
	release, err = limiter.acquire(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if limiter.client.ZCard(ctx, key).Val() != 10 {
		t.Fatal("expired lease was not removed")
	}
	if limiter.client.PTTL(ctx, key).Val() <= 0 {
		t.Fatal("lease must expire after process death")
	}
	release()
}
