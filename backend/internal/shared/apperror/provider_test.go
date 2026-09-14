package apperror

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestProviderFailurePreservesRealReason(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body, want string
		retry      bool
	}{
		{"auth", 401, `{"error":{"message":"Invalid API key","code":"invalid_api_key"}}`, "模型渠道认证失败", false},
		{"permission", 403, `{"error":{"message":"model access denied"}}`, "model access denied", false},
		{"model", 404, `{"error":{"message":"model video-test does not exist"}}`, "video-test", false},
		{"parameter", 422, `{"error":{"message":"duration must be 5 or 10","param":"duration","code":"invalid_parameter"}}`, "duration must be 5 or 10", false},
		{"quota", 429, `{"error":{"message":"Budget exhausted","code":"insufficient_quota"}}`, "渠道额度不足", false},
		{"rate", 429, `{"error":{"message":"Too many concurrent tasks"}}`, "Too many concurrent tasks", true},
		{"timeout", 504, `{"message":"gateway timeout"}`, "响应超时", true},
		{"task", 200, `{"output":{"task_status":"FAILED","code":"InvalidParameter","message":"reference image not supported"}}`, "reference image not supported", false},
		{"volc", 400, `{"ResponseMetadata":{"Error":{"Code":"InvalidParameter","Message":"resolution unsupported"}}}`, "resolution unsupported", false},
		{"opaque", 502, `<html>password=private debug dump</html>`, "未提供更详细", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ProviderFailure(tc.status, []byte(tc.body))
			if !strings.Contains(PublicMessage(err), tc.want) || err.Retryable != tc.retry {
				t.Fatalf("%+v", err)
			}
			if status := err.Details.(map[string]any)["upstream_status"]; status != tc.status {
				t.Fatalf("status fabricated: %v", status)
			}
			if err.Code == CodeUnauthenticated {
				t.Fatal("provider auth must not log the user out")
			}
		})
	}
}

func TestProviderFailureSurvivesLegacyInternalWrapper(t *testing.T) {
	inner := ProviderFailure(401, []byte(`{"error":{"message":"Invalid key"}}`))
	err := Wrap(CodeInternal, "reference upload failed", inner)
	if !strings.Contains(PublicMessage(err), "HTTP 401") {
		t.Fatal(PublicMessage(err))
	}
	opaque := Wrap(CodeInternal, "private detail", errors.New("postgres://secret"))
	if strings.Contains(PublicMessage(opaque), "secret") {
		t.Fatal("private cause exposed")
	}
}

func TestMalformedProviderResponseKeepsContractFailure(t *testing.T) {
	err := ProviderResponseFailure(200, []byte(`{"status":"completed","debug":"private"}`), "模型任务未返回结果地址")
	if !strings.Contains(PublicMessage(err), "未返回结果地址") || strings.Contains(PublicMessage(err), "private") {
		t.Fatal(err)
	}
	err = ProviderResponseFailure(200, []byte(`{"error":{"message":"No available account"}}`), "缺少任务编号")
	if !strings.Contains(PublicMessage(err), "No available account") {
		t.Fatal(err)
	}
}

func TestProviderFailureRedactsSecretsButKeepsParameterReason(t *testing.T) {
	raw := `{"error":{"message":"duration unsupported; Authorization: Bearer abcd-private; api_key='quoted secret'; token=another-secret; Incorrect API key provided: plain-key; https://host/path?sig=signed-private; user@example.com; sk-abcdef-private","code":"invalid_parameter","param":"duration"},"headers":{"password":"private-header"}}`
	err := ProviderFailure(400, []byte(raw))
	public := PublicMessage(err)
	for _, private := range []string{"abcd-private", "quoted secret", "another-secret", "plain-key", "signed-private", "user@example.com", "abcdef-private", "private-header"} {
		if strings.Contains(public, private) {
			t.Fatalf("leaked %s: %s", private, public)
		}
	}
	if !strings.Contains(public, "duration unsupported") || !strings.Contains(public, "param=duration") {
		t.Fatal(public)
	}
	if !strings.Contains(Diagnostic(err), "signed-private") {
		t.Fatal("private cause lost")
	}
	if len([]rune(SafeProviderText(strings.Repeat("字", 2000)))) > 361 {
		t.Fatal("unbounded message")
	}
}

func TestProviderRequestFailureRetainsSafeTransportCause(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "超时"},
		{context.Canceled, "已取消"},
		{&net.DNSError{Err: "no such host", Name: "private.internal"}, "域名解析失败"},
		{errors.New("tls certificate invalid at https://private/?token=secret"), "TLS"},
		{errors.New("dial tcp 127.0.0.1:9999 connection refused"), "无法连接"},
	} {
		got := PublicMessage(ProviderRequestFailure(tc.err))
		if !strings.Contains(got, tc.want) || strings.Contains(got, "private") || strings.Contains(got, "127.0.0.1") {
			t.Fatal(got)
		}
	}
}
