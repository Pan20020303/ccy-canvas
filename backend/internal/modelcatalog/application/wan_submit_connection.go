package application

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

const wanConnectionAttempts = 3

func newWanSubmitClient() *http.Client {
	// Keep the IP/redirect SSRF guard; allow a slow TLS handshake and response.
	client := safehttp.Client(90 * time.Second)
	client.Transport.(*http.Transport).TLSHandshakeTimeout = 30 * time.Second
	return client
}

type wanConnectionTrace struct {
	mu              sync.Mutex
	phase           string
	connectionUsed  bool
	preflightFailed bool
}

func (s *wanConnectionTrace) trace() *httptrace.ClientTrace {
	set := func(phase string, used bool, err error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.phase = phase
		s.connectionUsed = s.connectionUsed || used
		if err != nil && !s.connectionUsed {
			s.preflightFailed = true
		}
	}
	return &httptrace.ClientTrace{
		DNSStart:          func(httptrace.DNSStartInfo) { set("dns", false, nil) },
		DNSDone:           func(info httptrace.DNSDoneInfo) { set("dns", false, info.Err) },
		ConnectStart:      func(_, _ string) { set("connect", false, nil) },
		ConnectDone:       func(_, _ string, err error) { set("connect", false, err) },
		TLSHandshakeStart: func() { set("tls", false, nil) },
		TLSHandshakeDone:  func(_ tls.ConnectionState, err error) { set("tls", false, err) },
		GotConn:           func(httptrace.GotConnInfo) { set("request_write", true, nil) },
		WroteHeaders:      func() { set("request_write", true, nil) },
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err != nil {
				set("request_write", true, nil)
			} else {
				set("response_headers", true, nil)
			}
		},
		GotFirstResponseByte: func() { set("response_headers", true, nil) },
	}
}

func (s *wanConnectionTrace) snapshot() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phase, s.preflightFailed && !s.connectionUsed
}

// Only explicit pre-connection trace evidence allows another attempt. An EOF
// alone, a write failure or a missing task ID is NOT evidence of non-submission.
// Other providers keep their existing single-submit policy.
func doWanSubmitWithPreflightRetry(ctx context.Context, client *http.Client, req *http.Request, body []byte) (*http.Response, error) {
	oneShot := *client
	// In particular, never follow a 307/308 by replaying this paid POST.
	oneShot.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for attempt := 1; attempt <= wanConnectionAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, apperror.ProviderRequestFailure(err)
		}
		state := &wanConnectionTrace{phase: "unknown"}
		clone := req.Clone(httptrace.WithClientTrace(ctx, state.trace()))
		clone.Body = io.NopCloser(bytes.NewReader(body))
		clone.GetBody = nil
		started := time.Now()
		response, err := oneShot.Do(clone)
		if err == nil {
			response.Body = &wanSubmitBody{ReadCloser: response.Body, attempts: attempt}
			return response, nil
		}
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		phase, notSent := state.snapshot()
		failure := wanSubmitFailure(err, phase, notSent, attempt)
		willRetry := notSent && ctx.Err() == nil && attempt < wanConnectionAttempts && wanTransientConnectionError(err)
		notifyProviderRetryObserver(ctx, providerRetryEvent{Attempt: attempt, DurationMs: int(time.Since(started).Milliseconds()), Err: failure, WillRetry: willRetry})
		if !willRetry {
			return nil, failure
		}
		timer := time.NewTimer(time.Duration(attempt) * 250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, wanSubmitFailure(ctx.Err(), phase, notSent, attempt)
		case <-timer.C:
		}
	}
	panic("unreachable: bounded Wan connection attempts")
}

type wanSubmitBody struct {
	io.ReadCloser
	attempts int
}

func (b *wanSubmitBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		return n, wanSubmitFailure(err, "response_body", false, b.attempts)
	}
	return n, err
}

func wanTransientConnectionError(err error) bool {
	var certificate *tls.CertificateVerificationError
	var dns *net.DNSError
	if errors.Is(err, context.Canceled) || errors.Is(err, safehttp.ErrBlockedTarget) ||
		errors.As(err, &certificate) || (errors.As(err, &dns) && dns.IsNotFound) {
		return false
	}
	// A permanent certificate/configuration problem must not be retried either.
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "certificate") || strings.Contains(low, "x509:") {
		return false
	}
	var timeout net.Error
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		(errors.As(err, &timeout) && timeout.Timeout()) ||
		strings.Contains(low, "connection reset") || strings.Contains(low, "forcibly closed") ||
		strings.Contains(low, "connection refused") || strings.Contains(low, "actively refused")
}

// Only allow-listed categories go into task/attempt logs. Never expose URLs,
// API keys, IPs, headers or arbitrary transport error strings to the browser.
func wanSubmitFailure(err error, phase string, notSent bool, attempts int) *apperror.Error {
	phases := map[string]string{"dns": "域名解析", "connect": "建立连接", "tls": "TLS 握手", "request_write": "发送请求", "response_headers": "等待响应", "response_body": "读取响应", "unknown": "请求阶段未确认"}
	phaseLabel, ok := phases[phase]
	if !ok {
		phase, phaseLabel = "unknown", phases["unknown"]
	}
	reason := "网络连接异常"
	code := apperror.CodeUpstreamUnavailable
	var timeout net.Error
	var dns *net.DNSError
	low := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, context.Canceled):
		reason = "请求已取消"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		code, reason = apperror.CodeTimeout, "连接或响应超时"
	case errors.As(err, &dns):
		reason = "域名解析失败"
	case errors.Is(err, safehttp.ErrBlockedTarget):
		reason = "地址被安全策略阻止"
	case strings.Contains(low, "certificate"), strings.Contains(low, "x509:"):
		reason = "证书校验失败"
	case errors.Is(err, io.ErrUnexpectedEOF):
		reason = "响应数据不完整"
	case errors.Is(err, io.EOF), strings.Contains(low, "connection reset"), strings.Contains(low, "forcibly closed"):
		reason = "连接意外中断"
	case strings.Contains(low, "connection refused"), strings.Contains(low, "actively refused"):
		reason = "连接被拒绝"
	}
	message := fmt.Sprintf("万相连接异常（%s：%s；已尝试 %d 次）", phaseLabel, reason, attempts)
	if notSent {
		message += "；生成请求尚未发出，请稍后重试"
	} else {
		message += "；上游受理状态待确认，未自动重提，请勿立即重复生成"
	}
	return apperror.WithDetails(apperror.Wrap(code, message, err), map[string]any{
		"source": "provider_transport", "phase": phase, "reason": reason,
		"attempts": attempts, "submission_state": map[bool]string{true: "not_sent", false: "unknown"}[notSent],
	})
}
