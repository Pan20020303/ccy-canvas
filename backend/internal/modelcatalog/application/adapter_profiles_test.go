package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestResolveProfile(t *testing.T) {
	cases := []struct {
		name string
		pc   *domain.ProviderConfig
		want string
	}{
		{"nil config defaults to openai", nil, "openai"},
		{"empty spec defaults to openai", &domain.ProviderConfig{}, "openai"},
		{"explicit openai", &domain.ProviderConfig{APISpec: "openai"}, "openai"},
		{"explicit ark", &domain.ProviderConfig{APISpec: "ark"}, "ark"},
		{"explicit custom", &domain.ProviderConfig{APISpec: "custom"}, "custom"},
		{"relaybases uses openai-compatible profile", &domain.ProviderConfig{APISpec: "openai", Name: "RelayBases · gpt-image-2"}, "openai"},
		// Legacy Volcengine rows were saved with api_spec="custom" —
		// the vendor sniffer must outrank the spec value.
		{"volcengine vendor beats custom spec", &domain.ProviderConfig{APISpec: "custom", Vendor: "Volcengine"}, "ark"},
		{"volces.com host beats custom spec", &domain.ProviderConfig{APISpec: "custom", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}, "ark"},
		{"ark video contract beats openai spec", &domain.ProviderConfig{APISpec: "openai", SubmitEndpoint: "/contents/generations/tasks"}, "ark"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveProfile(tc.pc); got.ID != tc.want {
				t.Errorf("ResolveProfile(%+v).ID = %q, want %q", tc.pc, got.ID, tc.want)
			}
		})
	}
}

func TestResolveImageEditPath(t *testing.T) {
	cases := []struct {
		name string
		pc   *domain.ProviderConfig
		want string
	}{
		// Branch 1: endpoint explicitly mentions "edit" → trust verbatim.
		{"custom explicit edits endpoint", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/v1/images/edits"}, "/v1/images/edits"},
		{"custom explicit edit, nonstandard", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/api/edit-image"}, "/api/edit-image"},

		// Branch 2: endpoint is the generations path → derive sibling.
		// THIS is the RelayBases bug fix: /images/generations no longer
		// hijacks the multipart edit request.
		{"custom derive sibling from generations", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/images/generations"}, "/images/edits"},
		{"custom derive sibling keeps path prefix", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/v1/images/generations"}, "/v1/images/edits"},
		{"custom derive sibling trailing slash", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/images/generations/"}, "/images/edits"},

		// Branch 3: anything else → profile default.
		{"custom unrelated endpoint falls to default", &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/api/draw"}, "/images/edits"},
		{"empty endpoint falls to default", &domain.ProviderConfig{}, "/images/edits"},
		{"openai ignores submit endpoint", &domain.ProviderConfig{APISpec: "openai", SubmitEndpoint: "/api/edit-image"}, "/images/edits"},
		{"nil pc falls to default", nil, "/images/edits"},

		// RelayBases docs place /v1 in the operation path, not the base URL.
		{"relaybases edit path includes v1", &domain.ProviderConfig{APISpec: "openai", Name: "RelayBases · gpt-image-2"}, "/v1/images/edits"},

		// Ark profile: edits ride the generations endpoint.
		{"ark profile default", &domain.ProviderConfig{Vendor: "Volcengine"}, "/images/generations"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveImageEditPath(tc.pc); got != tc.want {
				t.Errorf("resolveImageEditPath(%+v) = %q, want %q", tc.pc, got, tc.want)
			}
		})
	}
}

func TestResolveProfileBaseURL(t *testing.T) {
	cases := []struct {
		name    string
		pc      *domain.ProviderConfig
		baseURL string
		want    string
	}{
		{
			name:    "relaybases root is canonical",
			pc:      &domain.ProviderConfig{APISpec: "openai", Vendor: "RelayBases"},
			baseURL: "https://image-2.relaybases.com",
			want:    "https://image-2.relaybases.com",
		},
		{
			name:    "relaybases existing v1 is stripped from base",
			pc:      &domain.ProviderConfig{APISpec: "openai", Vendor: "RelayBases"},
			baseURL: "https://image-2.relaybases.com/v1",
			want:    "https://image-2.relaybases.com",
		},
		{
			name:    "custom relaybases is unchanged",
			pc:      &domain.ProviderConfig{APISpec: "custom", Vendor: "RelayBases"},
			baseURL: "https://image-2.relaybases.com",
			want:    "https://image-2.relaybases.com",
		},
		{
			name:    "non relaybases openai is unchanged",
			pc:      &domain.ProviderConfig{APISpec: "openai", Vendor: "OpenAI"},
			baseURL: "https://api.openai.com",
			want:    "https://api.openai.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveProfileBaseURL(tc.pc, tc.baseURL); got != tc.want {
				t.Errorf("resolveProfileBaseURL(%+v, %q) = %q, want %q", tc.pc, tc.baseURL, got, tc.want)
			}
		})
	}
}

func TestResolveVideoPaths(t *testing.T) {
	openaiPC := &domain.ProviderConfig{APISpec: "openai"}
	if got := resolveVideoSubmitPath(openaiPC); got != "/videos" {
		t.Errorf("openai video submit = %q, want /videos", got)
	}
	if got := resolveVideoQueryPath(openaiPC); got != "/videos/{taskId}" {
		t.Errorf("openai video query = %q, want /videos/{taskId}", got)
	}

	arkPC := &domain.ProviderConfig{Vendor: "Volcengine", APISpec: "custom"}
	if got := resolveVideoSubmitPath(arkPC); got != "/contents/generations/tasks" {
		t.Errorf("ark video submit = %q, want /contents/generations/tasks", got)
	}

	// Explicit fields only win for custom profiles.
	override := &domain.ProviderConfig{APISpec: "custom", SubmitEndpoint: "/v1/videos", QueryEndpoint: "/v1/videos/{taskId}"}
	if got := resolveVideoSubmitPath(override); got != "/v1/videos" {
		t.Errorf("override video submit = %q, want /v1/videos", got)
	}
	if got := resolveVideoQueryPath(override); got != "/v1/videos/{taskId}" {
		t.Errorf("override video query = %q, want /v1/videos/{taskId}", got)
	}

	openaiOverride := &domain.ProviderConfig{APISpec: "openai", SubmitEndpoint: "/custom/videos", QueryEndpoint: "/custom/videos/{taskId}"}
	if got := resolveVideoSubmitPath(openaiOverride); got != "/videos" {
		t.Errorf("openai submit override = %q, want /videos", got)
	}
	if got := resolveVideoQueryPath(openaiOverride); got != "/videos/{taskId}" {
		t.Errorf("openai query override = %q, want /videos/{taskId}", got)
	}
}
