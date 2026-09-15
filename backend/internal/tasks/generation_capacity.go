package tasks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

// Capacity contention is scheduling, not an upstream failure. No provider
// request, refund, retry budget or running-state transition occurs here.
var errGenerationCapacity = errors.New("generation capacity busy: waiting in queue")

func generationRetryDelay(n int, err error, task *asynq.Task) time.Duration {
	if errors.Is(err, errGenerationCapacity) {
		return 3 * time.Second
	}
	return asynq.DefaultRetryDelayFunc(n, err, task)
}

func generationIsFailure(err error) bool { return err != nil && !errors.Is(err, errGenerationCapacity) }

type generationCapacity struct {
	client *redis.Client
	prefix string
}

// A single shared Seedream pool across model versions, providers and API
// replicas. Counting requested outputs (not HTTP calls) also bounds n>1.
// Other remote image jobs use a conservative request cap; local GPUs serialize.
func generationCapacityPolicy(req modelapp.GenerateRequest) (family string, limit, weight int) {
	if req.ServiceType != "image" {
		return "", 0, 0
	}
	model := strings.ToLower(strings.TrimSpace(req.Model))
	if modelapp.IsSeedreamImageModel(model) {
		return "seedream", 10, modelapp.ClampOutputCount(req.OutputCount)
	}
	if strings.HasSuffix(model, "-local") {
		return "local-image", 1, 1
	}
	return "other-image", 3, 1
}

// Redis time avoids clock skew across replicas. A lease outlives the hard
// worker deadline, so a crashed/aborted worker cannot instantly free capacity
// while its remote non-idempotent generation may still be running. It expires
// automatically even if the process never gets a chance to release it.
var acquireGenerationCapacity = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
local weight = tonumber(ARGV[2])
if redis.call('ZCARD', KEYS[1]) + weight > tonumber(ARGV[1]) then return 0 end
for i = 1, weight do
 redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[3]), ARGV[4] .. ':' .. i)
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 1
`)

func (g *generationCapacity) acquire(ctx context.Context, req modelapp.GenerateRequest) (func(), error) {
	family, limit, weight := generationCapacityPolicy(req)
	if family == "" {
		return func() {}, nil
	}
	if weight > limit {
		return nil, fmt.Errorf("豆包单个任务最多生成 10 张图片，请拆分节点后排队生成")
	}
	if g == nil || g.client == nil {
		return nil, fmt.Errorf("%w: scheduler unavailable", errGenerationCapacity)
	}
	key, token := g.prefix+family, uuid.NewString()
	ttl := timeoutForServiceType(req.ServiceType) + time.Minute
	if deadline, ok := ctx.Deadline(); ok {
		ttl = time.Until(deadline) + time.Minute
	}
	if ttl <= time.Minute {
		return nil, context.DeadlineExceeded
	}
	acquired, err := acquireGenerationCapacity.Run(ctx, g.client, []string{key}, limit, weight, ttl.Milliseconds(), token).Int()
	if err != nil {
		return nil, fmt.Errorf("%w: scheduling store unavailable", errGenerationCapacity)
	}
	if acquired == 0 {
		return nil, errGenerationCapacity
	}
	return func() {
		members := make([]interface{}, weight)
		for i := range members {
			members[i] = fmt.Sprintf("%s:%d", token, i+1)
		}
		releaseCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		// Failed release is safe: the finite lease eventually expires.
		_ = g.client.ZRem(releaseCtx, key, members...).Err()
	}, nil
}
