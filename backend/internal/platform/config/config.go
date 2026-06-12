package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
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

	// NewAPI gateway (optional).
	// When NewAPIBaseURL is set, the model catalog routes generation
	// requests through the unified NewAPI OpenAI-compatible endpoint
	// instead of the per-provider direct path. Leave empty to keep the
	// legacy ProviderConfig-driven path (no behavior change).
	//
	// Set NEWAPI_BASE_URL to e.g. "https://newapi.example.com/v1".
	// Set NEWAPI_TOKEN to the sk-* admin token issued by NewAPI admin UI.
	NewAPIBaseURL string
	NewAPIToken   string
	NewAPITimeout int // seconds; default 60
	ChannelPolicy string

	// Redis / Asynq task queue (optional).
	// When RedisAddr is set, the generation handler enqueues a durable
	// task via Asynq instead of running it inline in a detached goroutine.
	// Survives backend restart (at-least-once delivery) and enables
	// built-in retries + dead-letter via asynqmon.
	// Leave RedisAddr empty to keep the legacy detached-goroutine path.
	//
	// Format: host:port (e.g. "localhost:6379"). For TLS or Sentinel,
	// pass the full URL via REDIS_URL and we'll parse it.
	RedisAddr     string
	RedisPassword string
	RedisDB       int
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

	newAPITimeout, err := strconv.Atoi(getenv("NEWAPI_TIMEOUT_SECONDS", "60"))
	if err != nil || newAPITimeout <= 0 {
		newAPITimeout = 60
	}

	redisDB, err := strconv.Atoi(getenv("REDIS_DB", "0"))
	if err != nil || redisDB < 0 {
		redisDB = 0
	}

	cfg := Config{
		HTTPAddr:      getenv("HTTP_ADDR", ":8080"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		CookieSecure:  cookieSecure,
		EncryptionKey: encryptionKey,
		NewAPIBaseURL: strings.TrimRight(os.Getenv("NEWAPI_BASE_URL"), "/"),
		NewAPIToken:   os.Getenv("NEWAPI_TOKEN"),
		NewAPITimeout: newAPITimeout,
		ChannelPolicy: strings.ToLower(getenv("CHANNEL_POLICY", "single")),
		RedisAddr:     os.Getenv("REDIS_ADDR"),
		RedisPassword: os.Getenv("REDIS_PASSWORD"),
		RedisDB:       redisDB,
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
