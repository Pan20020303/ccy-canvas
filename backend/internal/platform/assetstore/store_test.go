package assetstore

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func resetStoresForTest() {
	defaultOnce = sync.Once{}
	defaultStore = nil
	defaultErr = nil
	presignOnce = sync.Once{}
	presignStores = nil
}

func TestPresignGetUsesConfiguredLegacyCOSWhenOSSIsActive(t *testing.T) {
	resetStoresForTest()
	t.Cleanup(resetStoresForTest)

	t.Setenv("STORAGE_BACKEND", "oss")
	t.Setenv("OSS_BUCKET", "current-assets")
	t.Setenv("OSS_REGION", "cn-beijing")
	t.Setenv("OSS_ACCESS_KEY_ID", "current-key-id")
	t.Setenv("OSS_ACCESS_KEY_SECRET", "current-key-secret")
	t.Setenv("COS_BUCKET", "legacy-assets-123456")
	t.Setenv("COS_REGION", "ap-beijing")
	t.Setenv("COS_SECRET_ID", "legacy-secret-id")
	t.Setenv("COS_SECRET_KEY", "legacy-secret-key")
	t.Setenv("COS_PUBLIC_BASE_URL", "https://legacy-assets-123456.cos.ap-beijing.myqcloud.com")
	t.Setenv("COS_KEY_PREFIX", "ccy-canvas")

	raw := "https://legacy-assets-123456.cos.ap-beijing.myqcloud.com/ccy-canvas/generated/video.mp4"
	signed, err := PresignGet(context.Background(), raw, 10*time.Minute)
	if err != nil {
		t.Fatalf("PresignGet returned an error: %v", err)
	}
	if signed == "" || signed == raw {
		t.Fatalf("expected a signed legacy COS URL, got %q", signed)
	}
	if !strings.Contains(signed, "q-sign-") {
		t.Fatalf("expected COS signing parameters, got %q", signed)
	}
}
