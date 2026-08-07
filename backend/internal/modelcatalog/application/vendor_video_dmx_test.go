package application

import (
	"strings"
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
	url, status, detail, err := parseDMXPollResponse(succeeded)
	if err != nil || status != "succeeded" || url != "https://x.tos.com/v.mp4?sig=1" {
		t.Fatalf("succeeded: url=%q status=%q detail=%q err=%v", url, status, detail, err)
	}

	// running: nested status present, no url yet → keep polling
	url, status, detail, err = parseDMXPollResponse([]byte(`{"output":[{"content":[{"text":"{\"status\":\"running\"}"}]}]}`))
	if err != nil || status != "running" || url != "" {
		t.Fatalf("running: url=%q status=%q err=%v", url, status, err)
	}

	// failed WITH an explicit reason (content policy) → detail carries it through
	_, status, detail, err = parseDMXPollResponse([]byte(`{"output":[{"content":[{"text":"{\"status\":\"failed\",\"message\":\"不能生成真人\"}"}]}]}`))
	if err != nil || status != "failed" || detail != "不能生成真人" {
		t.Fatalf("failed w/ msg: status=%q detail=%q err=%v", status, detail, err)
	}
	if msg := dmxFailureMessage(status, detail); !strings.Contains(msg, "不能生成真人") {
		t.Fatalf("dmxFailureMessage = %q, want to contain the upstream reason", msg)
	}

	// failed WITHOUT a dedicated reason field → fall back to the whole inner JSON
	_, status, detail, err = parseDMXPollResponse([]byte(`{"output":[{"content":[{"text":"{\"status\":\"failed\",\"code\":\"XKICK\"}"}]}]}`))
	if err != nil || status != "failed" || !strings.Contains(detail, "XKICK") {
		t.Fatalf("failed w/o msg: status=%q detail=%q err=%v", status, detail, err)
	}

	// not-ready shapes must error so the poll loop retries rather than failing.
	for _, notReady := range [][]byte{
		[]byte(`{"output":[]}`),
		[]byte(`{"usage":{}}`),
		[]byte(`not-json`),
	} {
		if _, _, _, err := parseDMXPollResponse(notReady); err == nil {
			t.Fatalf("parseDMXPollResponse(%s) = nil error, want error", notReady)
		}
	}
}
