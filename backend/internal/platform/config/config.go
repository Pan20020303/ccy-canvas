package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	HTTPAddr      string
	DatabaseURL   string
	SessionSecret string
	CookieSecure  bool
	// EncryptionKey is the 32-byte AES-256-GCM key used to encrypt relay provider API keys at rest.
	// Provide as base64-encoded 32 raw bytes via environment variable CCY_ENCRYPTION_KEY.
	// A 32-character raw value is still accepted for local development compatibility.
	EncryptionKey []byte
}

func Load() (Config, error) {
	cookieSecure, err := strconv.ParseBool(getenv("COOKIE_SECURE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("COOKIE_SECURE must be a valid boolean: %w", err)
	}

	encryptionKey, err := parseEncryptionKey(os.Getenv("CCY_ENCRYPTION_KEY"))
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		HTTPAddr:      getenv("HTTP_ADDR", ":8080"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		CookieSecure:  cookieSecure,
		EncryptionKey: encryptionKey,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, fmt.Errorf("SESSION_SECRET must be at least 32 characters")
	}
	return cfg, nil
}

func parseEncryptionKey(value string) ([]byte, error) {
	if value == "" {
		return nil, fmt.Errorf("CCY_ENCRYPTION_KEY is required")
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len(value) == 32 {
		return []byte(value), nil
	}
	return nil, fmt.Errorf("CCY_ENCRYPTION_KEY must be base64-encoded 32 bytes")
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
