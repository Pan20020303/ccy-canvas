package session

import (
	"context"
	"testing"
)

type memoryStore struct {
	entries        map[string]Entry
	revoked        map[string]bool
	legacyDisabled bool
	legacyIDs      map[string]string
}

func newMemoryStore() *memoryStore {
	return &memoryStore{entries: map[string]Entry{}, revoked: map[string]bool{}, legacyIDs: map[string]string{}}
}
func (s *memoryStore) Create(_ context.Context, entry Entry) error {
	s.entries[entry.ID] = entry
	return nil
}
func (s *memoryStore) CreateLegacy(_ context.Context, entry Entry, key string) (string, error) {
	if id, ok := s.legacyIDs[key]; ok {
		return id, nil
	}
	s.entries[entry.ID] = entry
	s.legacyIDs[key] = entry.ID
	return entry.ID, nil
}
func (s *memoryStore) Active(_ context.Context, id, userID string) (bool, error) {
	entry, ok := s.entries[id]
	return ok && entry.UserID == userID && !s.revoked[id], nil
}
func (s *memoryStore) LegacyAllowed(_ context.Context, _ string, key string) (bool, error) {
	id := s.legacyIDs[key]
	return !s.legacyDisabled && !s.revoked[id], nil
}
func (s *memoryStore) List(_ context.Context, userID string) ([]Entry, error) {
	entries := []Entry{}
	for _, entry := range s.entries {
		if entry.UserID == userID && !s.revoked[entry.ID] {
			entries = append(entries, entry)
		}
	}
	return entries, nil
}
func (s *memoryStore) RevokeAndDisableLegacy(_ context.Context, userID, id string) (bool, error) {
	entry, ok := s.entries[id]
	if !ok || entry.UserID != userID || s.revoked[id] {
		return false, nil
	}
	s.revoked[id] = true
	s.legacyDisabled = true
	return true, nil
}
func (s *memoryStore) RevokeCurrent(_ context.Context, userID, id string) error {
	if entry, ok := s.entries[id]; ok && entry.UserID == userID {
		s.revoked[id] = true
	}
	return nil
}

func TestTrackedDevicesAreDistinctAndRevokedImmediately(t *testing.T) {
	store := newMemoryStore()
	manager := NewManager("01234567890123456789012345678901", false).WithStore(store)
	first, err := manager.NewCookieForRequest(context.Background(), "user-1", "member", "Browser A", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.NewCookieForRequest(context.Background(), "user-1", "member", "Browser B", "127.0.0.2")
	if err != nil {
		t.Fatal(err)
	}
	a, err := manager.Parse(first.Value)
	if err != nil {
		t.Fatal(err)
	}
	b, err := manager.Parse(second.Value)
	if err != nil {
		t.Fatal(err)
	}
	if a.SessionID == "" || a.SessionID == b.SessionID {
		t.Fatalf("session IDs should be unique: %q / %q", a.SessionID, b.SessionID)
	}
	if entries, err := manager.List(context.Background(), "user-1"); err != nil || len(entries) != 2 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	renewed, err := manager.RenewCookie(a, "admin")
	if err != nil {
		t.Fatal(err)
	}
	updated, err := manager.Parse(renewed.Value)
	if err != nil || updated.SessionID != a.SessionID || updated.Role != "admin" {
		t.Fatalf("renewed=%+v err=%v", updated, err)
	}
	if ok, err := manager.Revoke(context.Background(), "user-1", b.SessionID); err != nil || !ok {
		t.Fatalf("revoke=%t err=%v", ok, err)
	}
	if _, err := manager.Parse(second.Value); err == nil {
		t.Fatal("revoked cookie still accepted")
	}
	if _, err := manager.Parse(first.Value); err != nil {
		t.Fatalf("current cookie should remain valid: %v", err)
	}
	if entries, err := manager.List(context.Background(), "user-1"); err != nil || len(entries) != 1 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
}

func TestLegacyCookieIsDisabledAfterDeviceRevocation(t *testing.T) {
	legacyManager := NewManager("01234567890123456789012345678901", false)
	legacyCookie, err := legacyManager.NewCookie("user-1", "member")
	if err != nil {
		t.Fatal(err)
	}
	store := newMemoryStore()
	manager := legacyManager.WithStore(store)
	if _, err := manager.Parse(legacyCookie.Value); err != nil {
		t.Fatalf("legacy cookie should be allowed before revocation: %v", err)
	}
	legacyClaims, err := manager.Parse(legacyCookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	upgradedA, firstUpgrade, err := manager.UpgradeLegacy(context.Background(), legacyCookie.Value, legacyClaims, "Browser", "")
	if err != nil {
		t.Fatal(err)
	}
	_, secondUpgrade, err := manager.UpgradeLegacy(context.Background(), legacyCookie.Value, legacyClaims, "Browser", "")
	if err != nil || firstUpgrade.SessionID == "" || firstUpgrade.SessionID != secondUpgrade.SessionID {
		t.Fatalf("upgrades differ: %+v / %+v err=%v", firstUpgrade, secondUpgrade, err)
	}
	if _, err := manager.Parse(upgradedA.Value); err != nil {
		t.Fatalf("upgraded cookie rejected: %v", err)
	}
	if err := manager.RevokeCurrent(context.Background(), firstUpgrade); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Parse(legacyCookie.Value); err == nil {
		t.Fatal("old cookie accepted after upgraded session logged out")
	}
	if _, err := manager.Parse(upgradedA.Value); err == nil {
		t.Fatal("upgraded cookie accepted after logout")
	}
	// A separate still-valid legacy cookie should remain valid until the user
	// explicitly kicks a device, which invalidates all untracked cookies.
	otherLegacyCookie, err := legacyManager.NewCookie("user-1", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Parse(otherLegacyCookie.Value); err != nil {
		t.Fatalf("unrelated legacy cookie rejected: %v", err)
	}
	trackedCookie, err := manager.NewCookieForRequest(context.Background(), "user-1", "member", "Browser", "")
	if err != nil {
		t.Fatal(err)
	}
	tracked, err := manager.Parse(trackedCookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := manager.Revoke(context.Background(), "user-1", tracked.SessionID); err != nil || !ok {
		t.Fatalf("revoke=%t err=%v", ok, err)
	}
	if _, err := manager.Parse(otherLegacyCookie.Value); err == nil {
		t.Fatal("legacy cookie still accepted after revocation")
	}
}
