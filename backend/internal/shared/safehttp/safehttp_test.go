package safehttp

import (
	"net"
	"testing"
)

func TestIPBlockedAlwaysBlocksMetadataAndUnspecified(t *testing.T) {
	// Even with the LAN escape hatch on, link-local (cloud metadata) and
	// unspecified must stay blocked.
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	always := []string{"169.254.169.254", "0.0.0.0", "224.0.0.1", "fe80::1", "::"}
	for _, s := range always {
		if !IPBlocked(net.ParseIP(s)) {
			t.Errorf("IPBlocked(%s) = false, want true even with escape hatch on", s)
		}
	}
}

func TestIPBlockedLoopbackAndPrivateHonorFlag(t *testing.T) {
	conditional := []string{"127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1", "100.64.0.1", "::1", "fc00::1"}

	t.Run("blocked by default", func(t *testing.T) {
		t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "0")
		for _, s := range conditional {
			if !IPBlocked(net.ParseIP(s)) {
				t.Errorf("IPBlocked(%s) = false, want true by default", s)
			}
		}
	})

	t.Run("allowed with flag", func(t *testing.T) {
		t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
		for _, s := range conditional {
			if IPBlocked(net.ParseIP(s)) {
				t.Errorf("IPBlocked(%s) = true, want false with flag on", s)
			}
		}
	})
}

func TestIPBlockedAllowsPublic(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "0")
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if IPBlocked(net.ParseIP(s)) {
			t.Errorf("IPBlocked(%s) = true, want false for public address", s)
		}
	}
}

func TestValidatePublicURL(t *testing.T) {
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "0")
	bad := []string{
		"",                              // unparseable as URL with host
		"ftp://example.com/x",           // wrong scheme
		"file:///etc/passwd",            // wrong scheme
		"http://169.254.169.254/latest", // metadata literal
		"http://127.0.0.1:6379",         // loopback literal
		"http://[::1]/x",                // loopback literal v6
	}
	for _, u := range bad {
		if err := ValidatePublicURL(u); err == nil {
			t.Errorf("ValidatePublicURL(%q) = nil, want error", u)
		}
	}

	good := []string{"http://example.com/x", "https://cdn.example.com/a.png", "http://8.8.8.8/x"}
	for _, u := range good {
		if err := ValidatePublicURL(u); err != nil {
			t.Errorf("ValidatePublicURL(%q) = %v, want nil", u, err)
		}
	}
}
