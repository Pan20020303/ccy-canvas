package interfaces

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"testing"
)

func TestRejectOversizedSeedreamBeforeCharging(t *testing.T) {
	h := &Handler{}
	input := &generateInput{}
	input.Body.ServiceType = "image"
	input.Body.Model = "doubao-seedream-5-0-260128"
	input.Body.OutputCount = 50
	_, err := h.generate(context.Background(), input)
	status, ok := err.(huma.StatusError)
	if !ok || status.GetStatus() != 400 {
		t.Fatalf("want 400 before touching credits or database; got %v", err)
	}
}
