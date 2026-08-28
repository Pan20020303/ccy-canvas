package application

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/shared/apperror"
)

func TestProviderErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		status   int
		upstream string
		code     apperror.Code
		message  string
		retry    bool
	}{
		{400, "InputImageSensitiveContentDetected", apperror.CodeValidation, "参考图片未通过", false},
		{400, "InputTextSensitiveContentDetected", apperror.CodeValidation, "提示词未通过", false},
		{400, "InputVideoSensitiveContentDetected", apperror.CodeValidation, "参考视频未通过", false},
		{400, "InputAudioSensitiveContentDetected", apperror.CodeValidation, "参考音频未通过", false},
		{400, "InvalidParameter.Size", apperror.CodeValidation, "请求参数", false},
		{401, "AuthenticationError", apperror.CodeUpstreamUnavailable, "鉴权", false},
		{403, "OperationDenied.ServiceOverdue", apperror.CodeUpstreamUnavailable, "余额或配额", false},
		{403, "AccessDenied", apperror.CodeUpstreamUnavailable, "访问权限", false},
		{404, "NotFound.Model", apperror.CodeUpstreamUnavailable, "不存在", false},
		{413, "", apperror.CodeRequestTooLarge, "过大", false},
		{429, "", apperror.CodeRateLimited, "并发", true},
		{504, "", apperror.CodeTimeout, "超时", true},
		{502, "", apperror.CodeUpstreamUnavailable, "暂时不可用", true},
	} {
		t.Run(fmt.Sprintf("%d-%s", tc.status, tc.upstream), func(t *testing.T) {
			err := parseProviderErrorBytes(tc.status, []byte(fmt.Sprintf(`{"error":{"code":%q,"message":"token=secret"}}`, tc.upstream)))
			app := apperror.Normalize(err)
			if app.Code != tc.code || app.Retryable != tc.retry || !strings.Contains(app.Message, tc.message) {
				t.Fatalf("unexpected classification: %+v", app)
			}
			if httpStatusFromError(fmt.Errorf("wrapped: %w", err)) != tc.status {
				t.Fatal("wrapped provider HTTP status was lost")
			}
			if strings.Contains(app.Error(), "secret") || strings.Contains(publicTaskErrorMessage(err), "secret") {
				t.Fatal("secret leaked")
			}
		})
	}
}

func TestProviderErrorRequestID(t *testing.T) {
	const id = "20260828120411ABCDEF1234567890"
	for _, body := range []string{`{"error":{"code":"InvalidParameter"}}`,
		`{"request_id":"` + id + `","error":{"code":"InvalidParameter"}}`} {
		resp := &http.Response{StatusCode: 400, Header: http.Header{"X-Request-Id": {id}}, Body: io.NopCloser(strings.NewReader(body))}
		err := readProviderError(resp)
		var diagnostic *providerResponseError
		if !errors.As(err, &diagnostic) || diagnostic.RequestID != id {
			t.Fatal("missing request correlation ID")
		}
	}
	err := parseProviderErrorBytes(400, []byte(`{"request_id":"token=secret","error":{"code":"token=secret","message":"secret"}}`))
	var diagnostic *providerResponseError
	if !errors.As(err, &diagnostic) || diagnostic.RequestID != "" || diagnostic.Code != "unrecognized" {
		t.Fatal("unsafe metadata accepted")
	}
}

func TestProviderErrorKeepsRawBodyOutOfPublicMessage(t *testing.T) {
	err := parseProviderErrorBytes(502, []byte(`{"error":{"message":"token=super-secret","type":"gateway_error"}}`))
	public := apperror.PublicMessage(err)
	if public == "" {
		t.Fatal("provider error should have a public message")
	}
	if strings.Contains(public, "super-secret") {
		t.Fatal("upstream body leaked into public message")
	}
	if !strings.Contains(apperror.Diagnostic(err), "super-secret") {
		t.Fatal("server diagnostic should retain the upstream context")
	}
}
