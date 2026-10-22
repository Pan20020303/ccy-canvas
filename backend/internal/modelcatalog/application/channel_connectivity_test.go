package application

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

type connectivityRepository struct {
	fakeRepository
	provider domain.ProviderConfig
}

func (r *connectivityRepository) GetProviderConfigByID(context.Context, string) (*domain.ProviderConfig, error) {
	return &r.provider, nil
}

func TestChannelConnectivityRequiresSuccessfulHTTPStatus(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	credential := "test-private-credential"
	encrypted, err := crypto.Encrypt(key, credential)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{200, 204, 401, 403, 404, 405, 429, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
					t.Errorf("unexpected probe: %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer "+credential {
					t.Error("probe did not use the stored credential")
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte(credential)) // Must never appear in the public report.
			}))
			defer server.Close()
			repo := &connectivityRepository{provider: domain.ProviderConfig{
				ID: "probe-channel", BaseURL: server.URL + "/v1/", EncryptedAPIKey: encrypted,
			}}
			report, err := NewService(repo, key).TestChannelConnectivity(context.Background(), "probe-channel")
			if err != nil {
				t.Fatal(err)
			}
			wantOK := status >= 200 && status < 300
			if report.OK != wantOK || report.HTTPStatus != status {
				t.Fatalf("report = %+v, want OK=%v, HTTP=%d", report, wantOK, status)
			}
			if !wantOK && !strings.Contains(report.ErrorMsg, strconv.Itoa(status)) {
				t.Fatalf("missing actionable HTTP failure: %+v", report)
			}
			if strings.Contains(report.ErrorMsg, credential) {
				t.Fatal("probe leaked a credential")
			}
			if status == 401 && !strings.Contains(report.ErrorMsg, "鉴权失败") {
				t.Fatalf("401 did not explain the authentication failure: %+v", report)
			}
		})
	}
}
