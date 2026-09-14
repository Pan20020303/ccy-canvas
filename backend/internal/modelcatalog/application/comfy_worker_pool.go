package application

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const comfyWorkerProbeTimeout = 2500 * time.Millisecond

// comfyWorkerPoolMetadata lives at the top level of parameter_schema.  It is
// intentionally metadata rather than a database migration so existing admins
// can duplicate a ComfyUI provider row and opt it into a pool immediately.
type comfyWorkerPoolMetadata struct {
	ComputePool   string `json:"compute_pool"`
	WorkerName    string `json:"worker_name"`
	MaxConcurrent int    `json:"max_concurrency"`
}

func comfyWorkerMetadata(pc *domain.ProviderConfig) comfyWorkerPoolMetadata {
	if pc == nil || !strings.EqualFold(strings.TrimSpace(pc.Vendor), "ComfyUI") {
		return comfyWorkerPoolMetadata{}
	}
	var metadata comfyWorkerPoolMetadata
	if len(pc.ParameterSchema) > 0 {
		_ = json.Unmarshal(pc.ParameterSchema, &metadata)
	}
	metadata.ComputePool = strings.TrimSpace(metadata.ComputePool)
	metadata.WorkerName = strings.TrimSpace(metadata.WorkerName)
	if metadata.MaxConcurrent < 1 {
		// ComfyUI executes one prompt at a time on a normal single-GPU worker.
		metadata.MaxConcurrent = 1
	}
	return metadata
}

func comfyWorkerPoolID(pc *domain.ProviderConfig) string {
	return comfyWorkerMetadata(pc).ComputePool
}

func comfyWorkerName(pc *domain.ProviderConfig) string {
	metadata := comfyWorkerMetadata(pc)
	if metadata.WorkerName != "" {
		return metadata.WorkerName
	}
	if pc != nil && strings.TrimSpace(pc.Name) != "" {
		return strings.TrimSpace(pc.Name)
	}
	return "ComfyUI worker"
}

type comfyWorkerPoolScheduler struct {
	mu     sync.Mutex
	active map[string]int
	client *http.Client
	redis  *redis.Client
	prefix string
}

func newComfyWorkerPoolScheduler() *comfyWorkerPoolScheduler {
	return &comfyWorkerPoolScheduler{
		active: make(map[string]int),
		client: &http.Client{Timeout: comfyWorkerProbeTimeout},
	}
}

func newRedisComfyWorkerPoolScheduler(redisAddr, redisPassword string, redisDB int) *comfyWorkerPoolScheduler {
	scheduler := newComfyWorkerPoolScheduler()
	scheduler.redis = redis.NewClient(&redis.Options{Addr: redisAddr, Password: redisPassword, DB: redisDB})
	scheduler.prefix = "ccy:comfy-worker:v1:"
	return scheduler
}

// WithComfyWorkerRedis makes the reservation window atomic across multiple
// CCY API replicas. Live ComfyUI /queue data remains the source of truth; the
// Redis lease only covers jobs this CCY cluster has assigned but that may not
// yet be visible from a worker's /queue endpoint.
func (s *Service) WithComfyWorkerRedis(redisAddr, redisPassword string, redisDB int) *Service {
	if s != nil && strings.TrimSpace(redisAddr) != "" {
		s.comfyWorkers = newRedisComfyWorkerPoolScheduler(redisAddr, redisPassword, redisDB)
	}
	return s
}

type comfyWorkerLoad struct {
	candidate candidateChannel
	running   int
	pending   int
	active    int
	limit     int
	index     int
	err       error
}

// selectWorker chooses the least-loaded healthy member.  It only switches
// workers before POST /prompt; after selection, the caller stays pinned to the
// same host through upload, generation, polling and result retrieval.
func (s *comfyWorkerPoolScheduler) selectWorker(ctx context.Context, candidates []candidateChannel) (candidateChannel, func(), error) {
	noop := func() {}
	if len(candidates) == 0 {
		return candidateChannel{}, noop, apperror.New(apperror.CodeInvalidInput, "No provider candidate available")
	}
	poolID := comfyWorkerPoolID(candidates[0].cfg)
	if poolID == "" || len(candidates) == 1 {
		return candidates[0], noop, nil
	}

	type probeResult struct {
		index   int
		running int
		pending int
		err     error
	}
	results := make(chan probeResult, len(candidates))
	for i := range candidates {
		candidate := candidates[i]
		go func(index int) {
			running, pending, err := s.probeQueue(ctx, candidate.baseURL)
			results <- probeResult{index: index, running: running, pending: pending, err: err}
		}(i)
	}

	loads := make([]comfyWorkerLoad, len(candidates))
	healthy := 0
	for range candidates {
		result := <-results
		candidate := candidates[result.index]
		metadata := comfyWorkerMetadata(candidate.cfg)
		loads[result.index] = comfyWorkerLoad{
			candidate: candidate,
			running:   result.running,
			pending:   result.pending,
			limit:     metadata.MaxConcurrent,
			index:     result.index,
			err:       result.err,
		}
		if result.err == nil {
			healthy++
		}
	}
	if healthy == 0 {
		details := make([]string, 0, len(loads))
		for _, load := range loads {
			details = append(details, fmt.Sprintf("%s: %v", comfyWorkerName(load.candidate.cfg), load.err))
		}
		return candidateChannel{}, noop, apperror.New(
			apperror.CodeInternal,
			"局域网 ComfyUI 算力池没有可连接的节点："+strings.Join(details, "; "),
		)
	}

	if s.redis != nil {
		best, token, reserveErr := s.reserveDistributed(ctx, loads)
		if reserveErr != nil {
			return candidateChannel{}, noop, apperror.Wrap(apperror.CodeInternal, "局域网 ComfyUI 算力池调度存储不可用", reserveErr)
		}
		chosen := loads[best].candidate
		var once sync.Once
		release := func() {
			once.Do(func() { s.releaseDistributed(chosen.cfg.ID, token) })
		}
		return chosen, release, nil
	}

	// Development fallback without Redis: read reservations, choose, and
	// reserve under one lock so concurrent requests in this process cannot both
	// claim the same just-observed-idle worker.
	s.mu.Lock()
	for i := range loads {
		loads[i].active = s.active[loads[i].candidate.cfg.ID]
	}
	best := -1
	for i := range loads {
		if loads[i].err != nil {
			continue
		}
		if best < 0 || comfyWorkerLess(loads[i], loads[best]) {
			best = i
		}
	}
	chosen := loads[best].candidate
	s.active[chosen.cfg.ID]++
	s.mu.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() { s.release(chosen.cfg.ID) })
	}
	return chosen, release, nil
}

var reserveComfyWorker = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
local best = 0
local best_jobs = 0
local best_limit = 1
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ms)
  local external = tonumber(ARGV[(i - 1) * 2 + 1])
  local limit = tonumber(ARGV[(i - 1) * 2 + 2])
  local active = redis.call('ZCARD', KEYS[i])
  local jobs = external
  if active > jobs then jobs = active end
  if best == 0 or jobs * best_limit < best_jobs * limit then
    best = i
    best_jobs = jobs
    best_limit = limit
  end
end
local ttl = tonumber(ARGV[#KEYS * 2 + 1])
local token = ARGV[#KEYS * 2 + 2]
redis.call('ZADD', KEYS[best], ms + ttl, token)
local current_ttl = redis.call('PTTL', KEYS[best])
if current_ttl < ttl then redis.call('PEXPIRE', KEYS[best], ttl) end
return best
`)

func (s *comfyWorkerPoolScheduler) reserveDistributed(ctx context.Context, loads []comfyWorkerLoad) (int, string, error) {
	keys := make([]string, len(loads))
	args := make([]any, 0, len(loads)*2+2)
	for i := range loads {
		keys[i] = s.prefix + loads[i].candidate.cfg.ID
		external := loads[i].running + loads[i].pending
		// An unhealthy candidate must never win the Lua comparison. Giving it a
		// very large external queue preserves the stable candidate ordering while
		// keeping one atomic script for all replicas.
		if loads[i].err != nil {
			external = 1 << 28
		}
		args = append(args, external, loads[i].limit)
	}
	const leaseTTL = 4 * time.Hour
	token := uuid.NewString()
	args = append(args, leaseTTL.Milliseconds(), token)
	selected, err := reserveComfyWorker.Run(ctx, s.redis, keys, args...).Int()
	if err != nil {
		return 0, "", err
	}
	if selected < 1 || selected > len(loads) || loads[selected-1].err != nil {
		return 0, "", fmt.Errorf("scheduler selected invalid worker index %d", selected)
	}
	return selected - 1, token, nil
}

func (s *comfyWorkerPoolScheduler) releaseDistributed(providerID, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = s.redis.ZRem(ctx, s.prefix+providerID, token).Err()
}

func comfyWorkerLess(left, right comfyWorkerLoad) bool {
	// active bridges the race before /queue reflects a just-submitted prompt;
	// max avoids double-counting once ComfyUI reports that same job as running.
	leftJobs := max(left.running+left.pending, left.active)
	rightJobs := max(right.running+right.pending, right.active)
	leftUtilization := float64(leftJobs) / float64(left.limit)
	rightUtilization := float64(rightJobs) / float64(right.limit)
	if leftUtilization != rightUtilization {
		return leftUtilization < rightUtilization
	}
	if left.pending != right.pending {
		return left.pending < right.pending
	}
	if left.candidate.cfg.Priority != right.candidate.cfg.Priority {
		return left.candidate.cfg.Priority < right.candidate.cfg.Priority
	}
	return left.index < right.index
}

func (s *comfyWorkerPoolScheduler) probeQueue(parent context.Context, baseURL string) (int, int, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return 0, 0, fmt.Errorf("base URL is empty")
	}
	ctx, cancel := context.WithTimeout(parent, comfyWorkerProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/queue", nil)
	if err != nil {
		return 0, 0, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, 0, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var queue struct {
		Running []json.RawMessage `json:"queue_running"`
		Pending []json.RawMessage `json:"queue_pending"`
	}
	if err := json.Unmarshal(body, &queue); err != nil {
		return 0, 0, fmt.Errorf("invalid /queue response: %w", err)
	}
	return len(queue.Running), len(queue.Pending), nil
}

func (s *comfyWorkerPoolScheduler) release(providerID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[providerID] <= 1 {
		delete(s.active, providerID)
		return
	}
	s.active[providerID]--
}
