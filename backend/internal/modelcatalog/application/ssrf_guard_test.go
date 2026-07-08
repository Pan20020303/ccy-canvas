package application

import (
	"context"
	"testing"
)

// SSRF 收口(安全审计 HIGH-2/3):转存 provider 结果图走 safehttp，内网/元数据
// 目标必须被拒 —— 否则被入侵/恶意中转站返回 result_url=http://169.254... 会让
// 服务端拉取内网资源并转存到 /uploads 供读回(read-SSRF 外泄原语)。

func TestStageRemoteAssetBlocksInternalTargets(t *testing.T) {
	// flag OFF (default prod): loopback / private / CGNAT / metadata all rejected
	// before any fetch (ValidatePublicURL fails fast on literal internal IPs).
	blocked := []string{
		"http://127.0.0.1:9090/admin",
		"http://[::1]:8080/",
		"http://169.254.169.254/latest/meta-data/iam/security-credentials/",
		"http://10.0.0.5/internal",
		"http://192.168.1.1/router",
		"http://100.64.0.1/cgnat",
	}
	for _, u := range blocked {
		if _, err := stageRemoteAsset(context.Background(), u, remoteAssetAuth{}); err == nil {
			t.Errorf("stageRemoteAsset(%q) must be blocked by the SSRF guard, got nil error", u)
		}
	}

	// data:/blob:/uploads/ and relative paths are staged/skipped without a fetch
	// and must NOT be flagged as SSRF (no error from the guard).
	for _, u := range []string{"/uploads/x.png", "blob:abc", "relative/path.png"} {
		if _, err := stageRemoteAsset(context.Background(), u, remoteAssetAuth{}); err != nil {
			t.Errorf("stageRemoteAsset(%q) is a non-fetch path, must not error: %v", u, err)
		}
	}
}

func TestCloudMetadataBlockedEvenWithEscapeHatch(t *testing.T) {
	// The LAN escape hatch may enable loopback/private, but cloud metadata
	// (link-local 169.254/fe80) stays blocked unconditionally.
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	if _, err := stageRemoteAsset(context.Background(), "http://169.254.169.254/latest/meta-data/", remoteAssetAuth{}); err == nil {
		t.Error("cloud metadata must stay blocked even with CCY_ALLOW_INTERNAL_FETCH=1")
	}
}
