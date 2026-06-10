package application

// Adapter profiles centralize per-vendor endpoint knowledge so admins no
// longer hand-type endpoint paths for known API shapes. The provider
// config's api_spec column (previously dead weight) now selects a profile:
//
//	"openai" → OpenAI-compatible: image gen + edit are SEPARATE endpoints
//	           (/images/generations JSON, /images/edits multipart); video
//	           is submit + poll (/videos, /videos/{taskId}).
//	"ark"    → Volcengine Ark: references ride inside /images/generations
//	           (no edits endpoint); video uses the contents/generations
//	           task contract.
//	"custom" → No assumptions; submit_endpoint / query_endpoint fields
//	           drive everything, exactly like the legacy behavior.
//
// Resolution order matters for backward compatibility: existing Volcengine
// rows were saved with api_spec="custom", so the vendor sniffers
// (isVolcengine / isArkVideoContract) take precedence over the spec value.
//
// Explicit endpoint fields only win for custom profiles. Known profiles keep
// endpoint knowledge inside this registry instead of trusting stale row-level
// overrides.

import (
	"net/url"
	"strings"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

type AdapterProfile struct {
	ID              string
	ImageGenPath    string
	ImageEditPath   string
	VideoSubmitPath string
	VideoQueryPath  string // contains {taskId} placeholder
}

var profileOpenAI = AdapterProfile{
	ID:              "openai",
	ImageGenPath:    "/images/generations",
	ImageEditPath:   "/images/edits",
	VideoSubmitPath: "/videos",
	VideoQueryPath:  "/videos/{taskId}",
}

var profileRelayBases = AdapterProfile{
	ID:              "openai",
	ImageGenPath:    "/v1/images/generations",
	ImageEditPath:   "/v1/images/edits",
	VideoSubmitPath: "/videos",
	VideoQueryPath:  "/videos/{taskId}",
}

var profileArk = AdapterProfile{
	ID:           "ark",
	ImageGenPath: "/images/generations",
	// Ark has no separate edits endpoint — reference images are embedded
	// in the generations payload (see generateImageVolcengine).
	ImageEditPath:   "/images/generations",
	VideoSubmitPath: "/contents/generations/tasks",
	VideoQueryPath:  "/contents/generations/tasks/{taskId}",
}

// profileCustom carries openai-shaped fallbacks so a custom config with
// EMPTY endpoint fields still does something sensible instead of hitting
// the bare base URL.
var profileCustom = AdapterProfile{
	ID:              "custom",
	ImageGenPath:    "/images/generations",
	ImageEditPath:   "/images/edits",
	VideoSubmitPath: "/videos",
	VideoQueryPath:  "/videos/{taskId}",
}

// ResolveProfile picks the adapter profile for a provider config.
// Vendor sniffers run FIRST because legacy Volcengine rows carry
// api_spec="custom" — without this ordering they'd lose their Ark
// behavior the moment profiles start driving endpoints.
func ResolveProfile(pc *domain.ProviderConfig) AdapterProfile {
	if pc == nil {
		return profileOpenAI
	}
	if isRelayBasesProvider(pc, pc.BaseURL) {
		return profileRelayBases
	}
	if isVolcengine(pc) || isArkVideoContract(pc) {
		return profileArk
	}
	switch strings.ToLower(strings.TrimSpace(pc.APISpec)) {
	case "ark":
		return profileArk
	case "custom":
		return profileCustom
	default:
		return profileOpenAI
	}
}

// resolveImageGenPath returns the text-to-image endpoint. Custom profiles may
// override it with submit_endpoint; known profiles use registry defaults.
func resolveImageGenPath(pc *domain.ProviderConfig) string {
	if ResolveProfile(pc).ID == "custom" && pc != nil {
		if p := strings.TrimSpace(pc.SubmitEndpoint); p != "" {
			return p
		}
	}
	return ResolveProfile(pc).ImageGenPath
}

func resolveProfileBaseURL(pc *domain.ProviderConfig, baseURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" || ResolveProfile(pc).ID == "custom" {
		return baseURL
	}
	if !isRelayBasesProvider(pc, trimmed) {
		return baseURL
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return baseURL
	}
	if strings.EqualFold(strings.TrimRight(u.Path, "/"), "/v1") {
		u.Path = ""
		return u.String()
	}
	return baseURL
}

func isRelayBasesProvider(pc *domain.ProviderConfig, baseURL string) bool {
	lower := strings.ToLower(baseURL)
	if strings.Contains(lower, "relaybases") {
		return true
	}
	if pc == nil {
		return false
	}
	return strings.Contains(strings.ToLower(pc.Vendor), "relaybases") ||
		strings.Contains(strings.ToLower(pc.Name), "relaybases")
}

// resolveImageEditPath returns the image-edit (multipart, reference-image)
// endpoint. This is the fix for the "configured /images/generations broke
// multi-reference requests" bug: submit_endpoint semantically maps to the
// GENERATION operation, so it must not blindly override the edit path.
//
// Resolution:
//  1. submit_endpoint mentions "edit"           → trust it verbatim
//  2. submit_endpoint ends with "/generations"  → derive the sibling
//     ("/v1/images/generations" → "/v1/images/edits") so relays mounted
//     under a path prefix keep the prefix
//  3. otherwise                                 → profile default
func resolveImageEditPath(pc *domain.ProviderConfig) string {
	if ResolveProfile(pc).ID == "custom" && pc != nil {
		se := strings.TrimSpace(pc.SubmitEndpoint)
		if se != "" {
			lower := strings.ToLower(se)
			if strings.Contains(lower, "edit") {
				return se
			}
			trimmed := strings.TrimRight(se, "/")
			if strings.HasSuffix(strings.ToLower(trimmed), "/generations") {
				return trimmed[:len(trimmed)-len("/generations")] + "/edits"
			}
		}
	}
	return ResolveProfile(pc).ImageEditPath
}

func resolveImageQueryPath(pc *domain.ProviderConfig) string {
	if ResolveProfile(pc).ID == "custom" && pc != nil {
		return strings.TrimSpace(pc.QueryEndpoint)
	}
	return ""
}

// resolveVideoSubmitPath / resolveVideoQueryPath use explicit fields only for
// custom profiles; known profiles are fully registry-driven.
func resolveVideoSubmitPath(pc *domain.ProviderConfig) string {
	if ResolveProfile(pc).ID == "custom" && pc != nil {
		if p := strings.TrimSpace(pc.SubmitEndpoint); p != "" {
			return p
		}
	}
	return ResolveProfile(pc).VideoSubmitPath
}

func resolveVideoQueryPath(pc *domain.ProviderConfig) string {
	if ResolveProfile(pc).ID == "custom" && pc != nil {
		if p := strings.TrimSpace(pc.QueryEndpoint); p != "" {
			return p
		}
	}
	return ResolveProfile(pc).VideoQueryPath
}
