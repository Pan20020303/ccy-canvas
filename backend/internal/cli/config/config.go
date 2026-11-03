// Package config persists the ccy CLI's settings and session under ~/.ccy/.
//
// Two files live there:
//   - config.json — non-secret settings (base_url, default model/provider).
//   - session     — the raw ccy_session cookie value (0600). Kept separate so
//     it can be chmod'd tight and cleared independently on logout.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	// DefaultBaseURL is used when neither flag, env, nor config supplies one.
	DefaultBaseURL = "http://localhost:8080"
	envBaseURL     = "CCY_BASE_URL"
)

// Config is the persisted CLI config. It deliberately holds NO secrets — the
// session cookie lives in its own 0600 file.
type Config struct {
	BaseURL                 string `json:"base_url,omitempty"`
	DefaultProviderConfigID string `json:"default_provider_config_id,omitempty"`
	DefaultModel            string `json:"default_model,omitempty"`
}

func dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ccy"), nil
}

func fileIn(name string) (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, name), nil
}

// Load reads config.json. A missing file yields a zero Config (not an error).
func Load() (Config, error) {
	var c Config
	p, err := fileIn("config.json")
	if err != nil {
		return c, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return c, nil
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	return c, nil
}

// Save writes config.json (0600), creating ~/.ccy (0700) if needed.
func (c Config) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d, "config.json"), b, 0o600)
}

// ResolveBaseURL applies precedence: flag > env CCY_BASE_URL > config > default.
func ResolveBaseURL(flagVal string, cfg Config) string {
	if s := strings.TrimSpace(flagVal); s != "" {
		return strings.TrimRight(s, "/")
	}
	if s := strings.TrimSpace(os.Getenv(envBaseURL)); s != "" {
		return strings.TrimRight(s, "/")
	}
	if s := strings.TrimSpace(cfg.BaseURL); s != "" {
		return strings.TrimRight(s, "/")
	}
	return DefaultBaseURL
}

// LoadSession returns the stored ccy_session cookie value, or "" if none.
func LoadSession() (string, error) {
	p, err := fileIn("session")
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// SaveSession writes the cookie value to ~/.ccy/session (0600). On Windows the
// 0600 bit maps imperfectly onto NTFS ACLs — protection there relies on the
// per-user %USERPROFILE% directory; do not use on a shared machine.
func SaveSession(value string) error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(d, "session"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(strings.TrimSpace(value))
	return err
}

// ClearSession removes the stored session file (idempotent).
func ClearSession() error {
	p, err := fileIn("session")
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
