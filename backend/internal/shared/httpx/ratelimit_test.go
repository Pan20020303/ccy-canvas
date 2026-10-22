package httpx

import (
	"net/http/httptest"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestIPRateLimiterBurstThenBlock(t *testing.T) {
	// 1 token/sec, burst 3 → first 3 immediate calls pass, 4th is blocked.
	l := newIPRateLimiter(rate.Limit(1), 3, time.Minute)
	for i := 0; i < 3; i++ {
		if !l.allow("1.1.1.1") {
			t.Fatalf("call %d should be allowed within burst", i+1)
		}
	}
	if l.allow("1.1.1.1") {
		t.Fatal("4th call over burst should be blocked")
	}
}

func TestIPRateLimiterPerIPIsolation(t *testing.T) {
	l := newIPRateLimiter(rate.Limit(1), 1, time.Minute)
	if !l.allow("1.1.1.1") {
		t.Fatal("first IP first call should pass")
	}
	if l.allow("1.1.1.1") {
		t.Fatal("first IP second call should be blocked")
	}
	// A different IP has its own bucket and must not be affected.
	if !l.allow("2.2.2.2") {
		t.Fatal("second IP should have an independent bucket")
	}
}

func TestIPRateLimiterRecoversOverTime(t *testing.T) {
	l := newIPRateLimiter(rate.Limit(1), 1, time.Minute)
	base := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return base } // only affects GC bookkeeping
	if !l.allow("9.9.9.9") {
		t.Fatal("first call should pass")
	}
	if l.allow("9.9.9.9") {
		t.Fatal("immediate second call should be blocked")
	}
	// rate.Limiter refills on wall-clock; after >1s a token is available again.
	time.Sleep(1100 * time.Millisecond)
	if !l.allow("9.9.9.9") {
		t.Fatal("call after refill window should pass")
	}
}

func TestClientIPTrustProxyToggle(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/auth/register", nil)
	r.RemoteAddr = "203.0.113.5:44321"
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 203.0.113.5")

	if got := clientIP(r, false); got != "203.0.113.5" {
		t.Fatalf("trustProxy=false should use RemoteAddr host, got %q", got)
	}
	if got := clientIP(r, true); got != "198.51.100.7" {
		t.Fatalf("trustProxy=true should use left-most XFF hop, got %q", got)
	}
}
