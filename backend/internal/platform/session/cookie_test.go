package session

import "testing"

func TestManagerSignsAndParsesSession(t *testing.T) {
	manager := NewManager("01234567890123456789012345678901", false)
	cookie, err := manager.NewCookie("user-1", "admin")
	if err != nil {
		t.Fatalf("NewCookie returned error: %v", err)
	}

	claims, err := manager.Parse(cookie.Value)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if claims.UserID != "user-1" {
		t.Fatalf("UserID = %q", claims.UserID)
	}
	if claims.Role != "admin" {
		t.Fatalf("Role = %q", claims.Role)
	}
}
