package application

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
)

type connectionTestTransport func(*http.Request) (*http.Response, error)

func (f connectionTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type handshakeTestTimeout struct{}

func (handshakeTestTimeout) Error() string { return "net/http: TLS handshake timeout" }
func (handshakeTestTimeout) Timeout() bool { return true }

func handshakeFailure(r *http.Request) (*http.Response, error) {
	err := handshakeTestTimeout{}
	httptrace.ContextClientTrace(r.Context()).TLSHandshakeDone(tls.ConnectionState{}, err)
	return nil, err
}
func completionResponse() *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))}
}

func TestLLMHandshakeTimeoutRetriesBeforeSubmission(t *testing.T) {
	c := NewLLMClient()
	if c.httpClient.Transport.(*http.Transport).TLSHandshakeTimeout != 30*time.Second {
		t.Fatal("short handshake timeout")
	}
	calls := 0
	c.httpClient.Transport = connectionTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return handshakeFailure(r)
		}
		return completionResponse(), nil
	})
	result, err := c.Chat(context.Background(), "https://example.invalid/v1", "test-secret", "model", nil, nil)
	if err != nil || result.Content != "ok" || calls != 2 {
		t.Fatalf("result=%v error=%v attempts=%d", result, err, calls)
	}
}

func TestLLMHandshakeRetryBoundAndPublicMessage(t *testing.T) {
	c := NewLLMClient()
	calls := 0
	c.httpClient.Transport = connectionTestTransport(func(r *http.Request) (*http.Response, error) { calls++; return handshakeFailure(r) })
	_, err := c.Chat(context.Background(), "https://example.invalid/v1", "test-secret", "model", nil, nil)
	message := apperror.PublicMessage(err)
	if calls != 3 || !strings.Contains(message, "本轮模型请求尚未发送") || strings.Contains(message, "上游是否已生成") || strings.Contains(message, "test-secret") {
		t.Fatalf("attempts=%d message=%s", calls, message)
	}
	if !strings.Contains(apperror.Diagnostic(err), "TLS handshake timeout") {
		t.Fatal("lost diagnostic")
	}
}

func TestLLMDoesNotMislabelTimeoutAfterConnection(t *testing.T) {
	c := NewLLMClient()
	calls := 0
	c.httpClient.Transport = connectionTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		httptrace.ContextClientTrace(r.Context()).GotConn(httptrace.GotConnInfo{})
		return nil, handshakeTestTimeout{}
	})
	_, err := c.Chat(context.Background(), "https://example.invalid/v1", "test-secret", "model", nil, nil)
	if calls != 1 || strings.Contains(apperror.PublicMessage(err), "尚未发送") {
		t.Fatalf("unsafe retry/message: %d %v", calls, err)
	}
}

type brokenStream struct{ sent bool }

func (r *brokenStream) Read(p []byte) (int, error) {
	if r.sent {
		return 0, io.ErrUnexpectedEOF
	}
	r.sent = true
	return copy(p, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"), nil
}
func (*brokenStream) Close() error { return nil }

func TestLLMPartialStreamIsNotReplayedOrFailedOver(t *testing.T) {
	c := NewLLMClient()
	calls := 0
	content := ""
	c.httpClient.Transport = connectionTestTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: &brokenStream{}}, nil
	})
	_, err := c.ChatStreamMulti(context.Background(), []Endpoint{{BaseURL: "https://one.invalid/v1"}, {BaseURL: "https://two.invalid/v1"}}, "model", nil, nil, func(s string) { content += s }, nil)
	if err == nil || calls != 1 || content != "partial" {
		t.Fatalf("attempts=%d content=%s err=%v", calls, content, err)
	}
}

func TestLLMCancelledHandshakeDoesNotRetry(t *testing.T) {
	c := NewLLMClient()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	c.httpClient.Transport = connectionTestTransport(func(r *http.Request) (*http.Response, error) { calls++; cancel(); return handshakeFailure(r) })
	_, err := c.Chat(ctx, "https://example.invalid/v1", "test-secret", "model", nil, nil)
	if calls != 1 || err == nil || !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("attempts=%d err=%v", calls, err)
	}
}
