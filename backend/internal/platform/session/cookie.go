package session

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const CookieName = "ccy_session"

type Claims struct {
	UserID    string `json:"user_id"`
	Role      string `json:"role"`
	ExpiresAt int64  `json:"expires_at"`
	SessionID string `json:"session_id,omitempty"`
}

type Manager struct {
	secret []byte
	secure bool
	store  Store
}

func NewManager(secret string, secure bool) Manager {
	return Manager{secret: []byte(secret), secure: secure}
}

func (m Manager) WithStore(store Store) Manager {
	m.store = store
	return m
}

func (m Manager) NewCookie(userID string, role string) (*http.Cookie, error) {
	return m.NewCookieForRequest(context.Background(), userID, role, "", "")
}

func (m Manager) NewCookieForRequest(ctx context.Context, userID, role, userAgent, ipAddress string) (*http.Cookie, error) {
	claims := Claims{
		UserID:    userID,
		Role:      role,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	if m.store != nil {
		id := make([]byte, 24)
		if _, err := rand.Read(id); err != nil {
			return nil, err
		}
		claims.SessionID = base64.RawURLEncoding.EncodeToString(id)
		if err := m.store.Create(ctx, Entry{
			ID: claims.SessionID, UserID: userID, UserAgent: userAgent,
			IPAddress: ipAddress, ExpiresAt: time.Unix(claims.ExpiresAt, 0),
		}); err != nil {
			return nil, err
		}
	}
	return m.cookieForClaims(claims)
}

// RenewCookie changes only the role snapshot. The device identity and expiry
// remain unchanged, so a permissions refresh does not create a fake device.
func (m Manager) RenewCookie(claims Claims, role string) (*http.Cookie, error) {
	claims.Role = role
	return m.cookieForClaims(claims)
}

// UpgradeLegacy gives an old signed cookie a durable device ID. The hash makes
// concurrent /me and /devices calls resolve to the same row without storing
// the old cookie itself or extending its lifetime.
func (m Manager) UpgradeLegacy(ctx context.Context, oldCookie string, claims Claims, userAgent, ipAddress string) (*http.Cookie, Claims, error) {
	if claims.SessionID != "" || m.store == nil {
		return nil, claims, nil
	}
	randomID := make([]byte, 24)
	if _, err := rand.Read(randomID); err != nil {
		return nil, Claims{}, err
	}
	key := sha256.Sum256([]byte(oldCookie))
	id, err := m.store.CreateLegacy(ctx, Entry{
		ID: base64.RawURLEncoding.EncodeToString(randomID), UserID: claims.UserID,
		UserAgent: userAgent, IPAddress: ipAddress, ExpiresAt: time.Unix(claims.ExpiresAt, 0),
	}, hex.EncodeToString(key[:]))
	if err != nil {
		return nil, Claims{}, err
	}
	claims.SessionID = id
	cookie, err := m.cookieForClaims(claims)
	return cookie, claims, err
}

func (m Manager) cookieForClaims(claims Claims) (*http.Cookie, error) {
	value, err := m.sign(claims)
	if err != nil {
		return nil, err
	}
	maxAge := int(time.Until(time.Unix(claims.ExpiresAt, 0)).Seconds())
	if maxAge < 0 {
		maxAge = 0
	}
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   m.secure,
	}, nil
}

func (m Manager) ClearCookie() *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   m.secure,
	}
}

func (m Manager) Parse(value string) (Claims, error) {
	return m.ParseContext(context.Background(), value)
}

func (m Manager) ParseContext(ctx context.Context, value string) (Claims, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return Claims{}, errors.New("invalid session format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, err
	}
	expected := m.signature(parts[0])
	if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return Claims{}, errors.New("invalid session signature")
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, err
	}
	if time.Now().Unix() >= claims.ExpiresAt {
		return Claims{}, errors.New("session expired")
	}
	if m.store != nil {
		if claims.SessionID == "" {
			key := sha256.Sum256([]byte(value))
			allowed, err := m.store.LegacyAllowed(ctx, claims.UserID, hex.EncodeToString(key[:]))
			if err != nil || !allowed {
				return Claims{}, errors.New("legacy session revoked")
			}
		} else {
			active, err := m.store.Active(ctx, claims.SessionID, claims.UserID)
			if err != nil || !active {
				return Claims{}, errors.New("session revoked")
			}
		}
	}
	return claims, nil
}

func (m Manager) List(ctx context.Context, userID string) ([]Entry, error) {
	if m.store == nil {
		return nil, errors.New("session store unavailable")
	}
	return m.store.List(ctx, userID)
}

func (m Manager) Revoke(ctx context.Context, userID, sessionID string) (bool, error) {
	if m.store == nil {
		return false, errors.New("session store unavailable")
	}
	return m.store.RevokeAndDisableLegacy(ctx, userID, sessionID)
}

func (m Manager) RevokeCurrent(ctx context.Context, claims Claims) error {
	if m.store == nil || claims.SessionID == "" {
		return nil
	}
	return m.store.RevokeCurrent(ctx, claims.UserID, claims.SessionID)
}

func (m Manager) sign(claims Claims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + m.signature(encoded), nil
}

func (m Manager) signature(encodedPayload string) string {
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
