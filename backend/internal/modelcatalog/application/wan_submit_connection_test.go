package application

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

type wanTestTransport func(*http.Request) (*http.Response, error)

func (f wanTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func wanTestRequest(t *testing.T) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodPost, "https://provider.invalid/submit?token=private-secret", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer private-secret")
	return r
}

func TestWanPreflightRetriesOnlyProvenUnsentFailures(t *testing.T) {
	for _, phase := range []string{"dns", "connect", "tls"} {
		t.Run(phase, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: wanTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					trace := httptrace.ContextClientTrace(r.Context())
					err := io.EOF
					switch phase {
					case "dns":
						trace.DNSDone(httptrace.DNSDoneInfo{Err: err})
					case "connect":
						trace.ConnectDone("tcp", "hidden", err)
					case "tls":
						trace.TLSHandshakeDone(tls.ConnectionState{}, err)
					}
					return nil, err
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != "payload" || r.Header.Get("Authorization") != "Bearer private-secret" {
					t.Fatal("request changed")
				}
				return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"output":{"task_id":"one"}}`)), Header: http.Header{}}, nil
			})}
			response, err := doWanSubmitWithPreflightRetry(context.Background(), client, wanTestRequest(t), []byte("payload"))
			if err != nil || calls != 2 || response.StatusCode != 202 {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
			response.Body.Close()
		})
	}
}

func TestWanPreflightBoundedAndDiagnosticsRedacted(t *testing.T) {
	calls, reconnects := 0, 0
	client := &http.Client{Transport: wanTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		err := errors.New("connection reset https://private.invalid/?token=private-secret 127.0.0.1")
		httptrace.ContextClientTrace(r.Context()).TLSHandshakeDone(tls.ConnectionState{}, err)
		return nil, err
	})}
	ctx := withProviderRetryObserver(context.Background(), func(event providerRetryEvent) {
		if event.WillRetry {
			reconnects++
		}
		if strings.Contains(event.Err.Error(), "private-secret") {
			t.Fatal("secret in attempt log")
		}
	})
	_, err := doWanSubmitWithPreflightRetry(ctx, client, wanTestRequest(t), []byte("payload"))
	public := apperror.PublicMessage(err)
	if calls != 3 || reconnects != 2 || !strings.Contains(public, "TLS 握手") || !strings.Contains(public, "尚未发出") {
		t.Fatalf("calls=%d retries=%d error=%s", calls, reconnects, public)
	}
	for _, secret := range []string{"private", "127.0.0.1", "Bearer"} {
		if strings.Contains(public, secret) {
			t.Fatal("leaked private diagnostics")
		}
	}
	if apperror.Normalize(err).Retryable {
		t.Fatal("must not requeue entire paid task")
	}
}

func TestWanNeverReplaysPossiblySubmittedRequest(t *testing.T) {
	for _, phase := range []string{"untraced", "got_connection", "headers_written", "write_failed", "waiting_response"} {
		t.Run(phase, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: wanTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				trace := httptrace.ContextClientTrace(r.Context())
				if phase != "untraced" {
					trace.TLSHandshakeDone(tls.ConnectionState{}, io.EOF)
				}
				switch phase {
				case "got_connection":
					trace.GotConn(httptrace.GotConnInfo{})
				case "headers_written":
					trace.WroteHeaders()
				case "write_failed":
					trace.WroteRequest(httptrace.WroteRequestInfo{Err: io.EOF})
				case "waiting_response":
					trace.WroteRequest(httptrace.WroteRequestInfo{})
				}
				return nil, io.EOF
			})}
			_, err := doWanSubmitWithPreflightRetry(context.Background(), client, wanTestRequest(t), []byte("payload"))
			if calls != 1 || !strings.Contains(apperror.PublicMessage(err), "受理状态待确认") {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestWanPermanentAndCancelledFailuresDoNotReconnect(t *testing.T) {
	for _, reason := range []string{"certificate", "dns", "cancelled"} {
		t.Run(reason, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			client := &http.Client{Transport: wanTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				var err error = errors.New("x509: certificate invalid")
				if reason == "dns" {
					err = &net.DNSError{IsNotFound: true}
				}
				if reason == "cancelled" {
					err = io.EOF
					cancel()
				}
				httptrace.ContextClientTrace(r.Context()).TLSHandshakeDone(tls.ConnectionState{}, err)
				return nil, err
			})}
			_, err := doWanSubmitWithPreflightRetry(ctx, client, wanTestRequest(t), []byte("payload"))
			if calls != 1 || err == nil {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestWanRealTLSDisconnectReconnectsButSubmitsOnce(t *testing.T) {
	var submits, dials atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		submits.Add(1)
		w.WriteHeader(202)
	}))
	defer server.Close()
	client := server.Client()
	transport := client.Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if dials.Add(1) == 1 {
			// First socket disconnects during TLS, before any HTTP request.
			local, remote := net.Pipe()
			go func() { defer remote.Close(); buf := make([]byte, 4096); _, _ = remote.Read(buf) }()
			return local, nil
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	client.Transport = transport
	req, _ := http.NewRequest(http.MethodPost, server.URL, nil)
	response, err := doWanSubmitWithPreflightRetry(context.Background(), client, req, []byte("payload"))
	if err != nil || dials.Load() != 2 || submits.Load() != 1 {
		t.Fatalf("dials=%d submits=%d error=%v", dials.Load(), submits.Load(), err)
	}
	response.Body.Close()
}

func TestHopBaseWanConnectionResponseFailuresNeverResubmit(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	for _, mode := range []string{"reset_after_submit", "truncated_body", "redirect", "quota"} {
		t.Run(mode, func(t *testing.T) {
			var submits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				submits.Add(1)
				switch mode {
				case "reset_after_submit":
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
				case "truncated_body":
					w.Header().Set("Content-Length", "200")
					w.Write([]byte(`{"output":`))
				case "redirect":
					http.Redirect(w, r, "/should-not-resend", 307)
				case "quota":
					w.WriteHeader(402)
					w.Write([]byte(`{"error":{"code":"insufficient_quota"}}`))
				}
			}))
			defer server.Close()
			_, err := (&Service{}).generateVideoHopBaseWan3(context.Background(), &domain.ProviderConfig{}, server.URL, "private-secret", GenerateRequest{Prompt: "test"})
			if err == nil || submits.Load() != 1 {
				t.Fatalf("submits=%d err=%v", submits.Load(), err)
			}
			message := apperror.PublicMessage(err)
			if mode == "quota" {
				if !strings.Contains(message, "配额不足") {
					t.Fatal(message)
				}
			} else if !strings.Contains(message, "受理状态待确认") {
				t.Fatal(message)
			}
		})
	}
}

func TestWanSubmitClientRetainsSafetyAndHandshakeBudget(t *testing.T) {
	client := newWanSubmitClient()
	transport := client.Transport.(*http.Transport)
	if transport.DialContext == nil || !transport.DisableKeepAlives || transport.TLSHandshakeTimeout != 30*time.Second || client.Timeout != 90*time.Second {
		t.Fatal("unsafe/short connection policy")
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
}

func TestWanResponseBodyRetainsAttemptCount(t *testing.T) {
	reader := &wanSubmitBody{ReadCloser: io.NopCloser(wanBrokenBody{}), attempts: 3}
	_, err := io.ReadAll(reader)
	message := apperror.PublicMessage(err)
	if !strings.Contains(message, "读取响应") || !strings.Contains(message, "已尝试 3 次") || !strings.Contains(message, "状态待确认") {
		t.Fatal(message)
	}
}

type wanBrokenBody struct{}

func (wanBrokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestWanCancelledDuringReconnectBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	client := &http.Client{Transport: wanTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		httptrace.ContextClientTrace(r.Context()).TLSHandshakeDone(tls.ConnectionState{}, io.EOF)
		return nil, io.EOF
	})}
	ctx = withProviderRetryObserver(ctx, func(event providerRetryEvent) {
		if event.WillRetry {
			cancel()
		}
	})
	_, err := doWanSubmitWithPreflightRetry(ctx, client, wanTestRequest(t), []byte("payload"))
	if calls != 1 || !errors.Is(err, context.Canceled) {
		t.Fatalf("calls=%d error=%v", calls, err)
	}
}
