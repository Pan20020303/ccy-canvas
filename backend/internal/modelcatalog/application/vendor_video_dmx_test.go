package application

import (
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestDMXProfileResolution(t *testing.T) {
	pc := &domain.ProviderConfig{Vendor: "DMXAPI", BaseURL: "https://www.dmxapi.cn/v1", APISpec: "dmxapi"}
	if got := ResolveProfile(pc).ID; got != "dmxapi" {
		t.Fatalf("ResolveProfile = %q, want dmxapi", got)
	}
	if got := resolveVideoSubmitPath(pc); got != "/responses" {
		t.Fatalf("resolveVideoSubmitPath = %q, want /responses", got)
	}
	if got := resolveVideoQueryPath(pc); got != "/responses" {
		t.Fatalf("resolveVideoQueryPath = %q, want /responses", got)
	}
}

func TestParseDMXPollResponse(t *testing.T) {
	// succeeded: the real result is a JSON STRING nested at output[0].content[0].text
	succeeded := []byte(`{"request_id":"cgt-1","output":[{"type":"message","content":[{"type":"output_text","text":"{\"content\":{\"video_url\":\"https://x.tos.com/v.mp4?sig=1\"},\"id\":\"cgt-1\",\"model\":\"doubao-seedance-2-0-260128\",\"status\":\"succeeded\"}"}]}]}`)
	url, status, err := parseDMXPollResponse(succeeded)
	if err != nil {
		t.Fatalf("succeeded parse error: %v", err)
	}
	if status != "succeeded" || url != "https://x.tos.com/v.mp4?sig=1" {
		t.Fatalf("got url=%q status=%q; want succeeded + url", url, status)
	}

	// running: nested status present, no url yet → keep polling
	url, status, err = parseDMXPollResponse([]byte(`{"output":[{"content":[{"text":"{\"status\":\"running\"}"}]}]}`))
	if err != nil {
		t.Fatalf("running parse error: %v", err)
	}
	if status != "running" || url != "" {
		t.Fatalf("got url=%q status=%q; want running + empty url", url, status)
	}

	// not-ready shapes must error so the poll loop retries rather than failing.
	for _, notReady := range [][]byte{
		[]byte(`{"output":[]}`),
		[]byte(`{"id":"cgt-1","usage":{}}`),
		[]byte(`not-json`),
	} {
		if _, _, err := parseDMXPollResponse(notReady); err == nil {
			t.Fatalf("parseDMXPollResponse(%s) = nil error, want error", notReady)
		}
	}
}
