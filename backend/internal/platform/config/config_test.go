package config

import "testing"

func TestLoadRejectsInvalidCookieSecure(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("COOKIE_SECURE", "definitely-not-bool")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid COOKIE_SECURE")
	}
}
