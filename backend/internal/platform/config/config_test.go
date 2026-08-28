package config

import (
	"encoding/base64"
	"testing"
)

func TestLoadRejectsInvalidCookieSecure(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CCY_ENCRYPTION_KEY", "12345678901234567890123456789012")
	t.Setenv("COOKIE_SECURE", "definitely-not-bool")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid COOKIE_SECURE")
	}
}

func TestLoadAcceptsBase64EncryptionKey(t *testing.T) {
	rawKey := []byte("01234567890123456789012345678901")
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CCY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(rawKey))
	t.Setenv("COOKIE_SECURE", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if string(cfg.EncryptionKey) != string(rawKey) {
		t.Fatalf("EncryptionKey = %q, want %q", string(cfg.EncryptionKey), string(rawKey))
	}
}

func TestLoadUsesLongTextGatewayTimeout(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CCY_ENCRYPTION_KEY", "12345678901234567890123456789012")
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("NEWAPI_TIMEOUT_SECONDS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.NewAPITimeout != 720 {
		t.Fatalf("NewAPITimeout = %d, want 720", cfg.NewAPITimeout)
	}

	t.Setenv("NEWAPI_TIMEOUT_SECONDS", "345")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load override returned error: %v", err)
	}
	if cfg.NewAPITimeout != 345 {
		t.Fatalf("NewAPITimeout override = %d, want 345", cfg.NewAPITimeout)
	}
}
