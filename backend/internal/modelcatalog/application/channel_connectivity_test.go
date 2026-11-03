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

func TestChannelConnectivityHopBaseMidjourneyChecksModelPermission(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	credential := "test-private-midjourney-credential"
	encrypted, err := crypto.Encrypt(key, credential)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/v1/"} {
		for _, tc := range []struct {
			name   string
			status int
			body   string
			ok     bool
		}{
			{"authorized", 200, `{"data":[{"id":"other-model"},{"id":"midjourney-v8-2"}]}`, true},
			{"wrong-key-group", 200, `{"data":[{"id":"MiniMax-H3"}]}`, false},
			{"missing-data", 200, `{"message":"midjourney-v8-2 ` + credential + `"}`, false},
			{"wrong-version", 200, `{"data":[{"id":"midjourney-v8"}]}`, false},
			{"invalid-json", 200, credential, false},
			{"empty-response", 204, "", false},
			{"unauthorized", 401, `{"data":[{"id":"midjourney-v8-2"}]}`, false},
		} {
			t.Run(suffix+"/"+tc.name, func(t *testing.T) {
				requests := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests++
					if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
						t.Errorf("unexpected probe: %s %s", r.Method, r.URL.Path)
					}
					if r.Header.Get("Authorization") != "Bearer "+credential {
						t.Error("probe did not use the stored credential")
					}
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
				}))
				defer server.Close()
				repo := &connectivityRepository{provider: domain.ProviderConfig{
					ID: "probe-midjourney", Vendor: "HopBase", ServiceType: "image",
					BaseURL: server.URL + suffix, EncryptedAPIKey: encrypted,
					ModelList: []string{hopBaseMidjourneyModel},
				}}
				report, err := NewService(repo, key).TestChannelConnectivity(context.Background(), repo.provider.ID)
				if err != nil {
					t.Fatal(err)
				}
				if report.OK != tc.ok || report.HTTPStatus != tc.status || requests != 1 {
					t.Fatalf("report=%+v requests=%d, want OK=%v HTTP=%d and one read-only probe", report, requests, tc.ok, tc.status)
				}
				if !tc.ok && report.ErrorMsg == "" {
					t.Fatal("missing actionable probe failure")
				}
				if strings.Contains(report.ErrorMsg, credential) {
					t.Fatal("probe leaked a credential")
				}
			})
		}
	}
}
