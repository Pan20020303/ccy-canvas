package apperror

import (
	"errors"
	"strings"
	"testing"
)

func TestInternalErrorNeverIncludesCauseInPublicMessage(t *testing.T) {
	err := Wrap(CodeInternal, "模型服务暂时不可用，请稍后重试", errors.New("postgres://password@db/internal token=secret"))
	if got := PublicMessage(err); got == "" {
		t.Fatal("internal error should have a public fallback")
	}
	if strings.Contains(err.Error(), "postgres") || strings.Contains(err.Error(), "token") {
		t.Fatalf("Error() leaked private cause: %q", err.Error())
	}
	if !strings.Contains(Diagnostic(err), "postgres") {
		t.Fatalf("Diagnostic should retain private cause")
	}
}

func TestHTTPStatusMapping(t *testing.T) {
	if got := HTTPStatus(CodeRateLimited); got != 429 {
		t.Fatalf("rate limit status = %d", got)
	}
	if got := HTTPStatus(CodeUpstreamUnavailable); got != 502 {
		t.Fatalf("upstream status = %d", got)
	}
	if got := CodeForHTTPStatus(422); got != CodeValidation {
		t.Fatalf("422 code = %s", got)
	}
}
