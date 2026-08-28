package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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
}

type Manager struct {
	secret []byte
	secure bool
}

func NewManager(secret string, secure bool) Manager {
	return Manager{secret: []byte(secret), secure: secure}
}

func (m Manager) NewCookie(userID string, role string) (*http.Cookie, error) {
	claims := Claims{
		UserID:    userID,
		Role:      role,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	value, err := m.sign(claims)
	if err != nil {
		return nil, err
	}
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   7 * 24 * 60 * 60,
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
	return claims, nil
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
