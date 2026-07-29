package application

import (
	"strings"
	"testing"

	"ccy-canvas/backend/internal/shared/apperror"
)

func TestProviderErrorKeepsRawBodyOutOfPublicMessage(t *testing.T) {
	err := parseProviderErrorBytes(502, []byte(`{"error":{"message":"token=super-secret","type":"gateway_error"}}`))
	public := apperror.PublicMessage(err)
	if public == "" {
		t.Fatal("provider error should have a public message")
	}
	if strings.Contains(public, "super-secret") {
		t.Fatal("upstream body leaked into public message")
	}
	if !strings.Contains(apperror.Diagnostic(err), "super-secret") {
		t.Fatal("server diagnostic should retain the upstream context")
	}
}
