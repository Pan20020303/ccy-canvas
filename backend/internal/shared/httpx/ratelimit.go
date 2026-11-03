package httpx

import (
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"

	"golang.org/x/time/rate"
)

// ipRateLimiter throttles requests per client IP. It exists mainly to blunt
// scripted signup abuse: open registration + credited free daily quota means a
// bot farm could mint accounts to harvest free credits (real money on the
// upstream bill). Process-local and best-effort — good enough as a first gate;
// a multi-instance deployment would want a shared store.
type ipRateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*ipVisitor
	rate     rate.Limit
	burst    int
	ttl      time.Duration
	now      func() time.Time
}

type ipVisitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPRateLimiter(r rate.Limit, burst int, ttl time.Duration) *ipRateLimiter {
	l := &ipRateLimiter{
		visitors: make(map[string]*ipVisitor),
		rate:     r,
		burst:    burst,
		ttl:      ttl,
		now:      time.Now,
	}
	return l
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	v, ok := l.visitors[ip]
	if !ok {
		v = &ipVisitor{limiter: rate.NewLimiter(l.rate, l.burst)}
		l.visitors[ip] = v
	}
	v.lastSeen = now
	// Opportunistic GC: sweep stale entries so the map can't grow unbounded
	// under a churn of distinct IPs. Cheap since it only runs while we hold the
	// lock we already took, and the map is small in practice.
	if len(l.visitors) > 1024 {
		for k, vis := range l.visitors {
			if now.Sub(vis.lastSeen) > l.ttl {
				delete(l.visitors, k)
			}
		}
	}
	return v.limiter.Allow()
}

// clientIP extracts the best-effort client address. We intentionally do NOT
// trust X-Forwarded-For by default (spoofable); the reverse proxy in front is
// expected to strip/set it, but for a self-hosted deployment RemoteAddr is the
// safe source. When TRUST_PROXY_IP=1 the left-most XFF hop is honored instead.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := indexByte(xff, ','); i >= 0 {
				return trimSpace(xff[:i])
			}
			return trimSpace(xff)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RateLimitMiddleware returns middleware that rejects a client IP exceeding
// ratePerMin requests/minute (with a small burst) to the wrapped routes.
func RateLimitMiddleware(ratePerMin float64, burst int, trustProxy bool) func(http.Handler) http.Handler {
	limiter := newIPRateLimiter(rate.Limit(ratePerMin/60.0), burst, 30*time.Minute)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !limiter.allow(clientIP(r, trustProxy)) {
				writeTooManyRequests(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeTooManyRequests(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "60")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(envelope{
		Error: errorBody{
			Code:    apperror.CodeInvalidInput,
			Message: "操作过于频繁，请稍后再试",
		},
		RequestID: RequestIDFrom(r.Context()),
	})
}

// small stdlib-free helpers to avoid importing strings just for two calls
func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
