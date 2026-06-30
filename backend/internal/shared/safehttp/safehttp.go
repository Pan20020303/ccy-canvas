// Package safehttp provides an HTTP client hardened against SSRF.
//
// It is meant for any code path that fetches a URL the caller does not fully
// control (media proxy, remote reference images, member-defined "http" skills).
// The client validates the *actual IP it connects to* at dial time — not just
// the hostname up front — so DNS rebinding and HTTP redirects to internal
// targets cannot slip past the guard.
//
// Policy:
//   - Always blocked: link-local (incl. cloud metadata 169.254.169.254 /
//     fe80::/10), unspecified (0.0.0.0 / ::), and multicast addresses. These
//     are never legitimate fetch targets.
//   - Blocked by default, but allowed when CCY_ALLOW_INTERNAL_FETCH=1:
//     loopback (127.0.0.0/8, ::1), private RFC1918 / ULA (fc00::/7), and
//     CGNAT (100.64.0.0/10). The escape hatch exists because this product is
//     also deployed on trusted LANs where referenced media may legitimately
//     live on a private host, and because tests serve from loopback. Note that
//     cloud metadata stays blocked even with the flag on.
package safehttp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// ErrBlockedTarget is returned (wrapped) when a request would reach a
// disallowed internal address.
var ErrBlockedTarget = errors.New("request to internal/private address is blocked")

func allowInternal() bool {
	return os.Getenv("CCY_ALLOW_INTERNAL_FETCH") == "1"
}

// IPBlocked reports whether dialing the given IP should be refused under the
// current policy.
func IPBlocked(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// Never legitimate, regardless of the LAN escape hatch.
	if ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return true
	}
	if allowInternal() {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() {
		return true
	}
	// CGNAT 100.64.0.0/10 (not covered by IsPrivate).
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
		return true
	}
	return false
}

// ValidatePublicURL checks scheme and host shape. It does not resolve DNS —
// the authoritative IP check happens at dial time — but it gives callers a
// clear, early error for obviously bad input and is reused as the redirect
// guard.
func ValidatePublicURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("only http and https urls are allowed")
	}
	if u.Hostname() == "" {
		return errors.New("url is missing a host")
	}
	// If the host is a literal IP, reject it here too (no DNS step will run).
	if ip := net.ParseIP(u.Hostname()); ip != nil && IPBlocked(ip) {
		return fmt.Errorf("%w: %s", ErrBlockedTarget, ip)
	}
	return nil
}

// Client returns an *http.Client whose dialer connects only to allowed public
// IPs and whose redirect handler re-validates every hop.
func Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           guardedDialContext(dialer),
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			return ValidatePublicURL(req.URL.String())
		},
	}
}

// guardedDialContext resolves the host itself and dials the resolved IP
// directly, so the IP that is validated is exactly the IP that is connected to
// (closing the DNS-rebinding window between check and connect).
func guardedDialContext(d *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, ipa := range ips {
			if IPBlocked(ipa.IP) {
				lastErr = fmt.Errorf("%w: %s", ErrBlockedTarget, ipa.IP)
				continue
			}
			conn, derr := d.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
			if derr != nil {
				lastErr = derr
				continue
			}
			return conn, nil
		}
		if lastErr == nil {
			lastErr = fmt.Errorf("no dialable address for %q", host)
		}
		return nil, lastErr
	}
}
