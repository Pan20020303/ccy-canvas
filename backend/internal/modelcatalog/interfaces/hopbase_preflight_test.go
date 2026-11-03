package interfaces

import (
	"context"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
	"github.com/danielgtaylor/huma/v2"
)

type hopBasePreflightRepo struct {
	application.Repository
	config domain.ProviderConfig
}

func (r *hopBasePreflightRepo) ListProviderConfigs(context.Context) ([]domain.ProviderConfig, error) {
	return []domain.ProviderConfig{r.config}, nil
}

type hopBasePreflightCredits struct{ reserves int }

func (c *hopBasePreflightCredits) Reserve(context.Context, string, string, int32, string) (string, error) {
	c.reserves++
	return "mock", nil
}
func (*hopBasePreflightCredits) Refund(context.Context, string, string, string, int32, string) error {
	return nil
}

func TestHopBaseRejectsInvalidReferencesBeforeCreditsLogsOrQueue(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encrypted, err := crypto.Encrypt(key, "offline-key")
	if err != nil {
		t.Fatal(err)
	}
	model := "dreamina-seedance-2-5-260628"
	repo := &hopBasePreflightRepo{config: domain.ProviderConfig{ID: "hopbase-mock", Vendor: "HopBase", ServiceType: "video", BaseURL: "https://hop-base.com", Status: "enabled", ModelList: []string{model}, EncryptedAPIKey: encrypted}}
	credits := &hopBasePreflightCredits{}
	// No database or queue exists in this test. Any unintended repository
	// write dispatches through a nil embedded interface and fails the test.
	h := &Handler{svc: application.NewService(repo, key).WithCredits(credits)}
	input := &generateInput{}
	input.Body.ServiceType = "video"
	input.Body.Model = model
	input.Body.ProviderConfigID = "hopbase-mock"
	input.Body.ReferenceAudios = []string{"/uploads/missing.wav"}
	t.Setenv("UPLOAD_DIR", t.TempDir())
	_, err = h.generate(context.Background(), input)
	status, ok := err.(huma.StatusError)
	if !ok || status.GetStatus() != 400 {
		t.Fatalf("want 400 before charging, log or queue; got %v", err)
	}
	if credits.reserves != 0 {
		t.Fatalf("credit reserves = %d, want 0", credits.reserves)
	}
}

func TestMidjourneyRejectsInvalidGroupBeforeCharging(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	encrypted, err := crypto.Encrypt(key, "offline-key")
	if err != nil {
		t.Fatal(err)
	}
	repo := &hopBasePreflightRepo{config: domain.ProviderConfig{
		ID: "mj", Vendor: "HopBase", ServiceType: "image", Status: "enabled",
		BaseURL: "https://api.hop-base.com", ModelList: []string{"midjourney-v8-2"}, EncryptedAPIKey: encrypted,
	}}
	credits := &hopBasePreflightCredits{}
	h := &Handler{svc: application.NewService(repo, key).WithCredits(credits)}
	input := &generateInput{}
	input.Body.ServiceType, input.Body.Model = "image", "midjourney-v8-2"
	input.Body.Prompt, input.Body.OutputCount = "A forest", 1
	_, err = h.generate(context.Background(), input)
	status, ok := err.(huma.StatusError)
	if !ok || status.GetStatus() != 400 || credits.reserves != 0 {
		t.Fatalf("invalid group reached credit/log/queue: err=%v reserves=%d", err, credits.reserves)
	}
	input.Body.OutputCount, input.Body.Prompt = 4, "A forest --draft"
	_, err = h.generate(context.Background(), input)
	status, ok = err.(huma.StatusError)
	if !ok || status.GetStatus() != 400 || credits.reserves != 0 {
		t.Fatalf("invalid prompt reached credit/log/queue: err=%v reserves=%d", err, credits.reserves)
	}
}
