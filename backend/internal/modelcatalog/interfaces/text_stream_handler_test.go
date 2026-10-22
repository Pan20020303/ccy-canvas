package interfaces

import "testing"

// 退款文案随「是否客户端中断」区分,便于对账排查双扣问题。
func TestRefundReasonForStream(t *testing.T) {
	if got := refundReasonForStream(true); got != "canceled" {
		t.Fatalf("clientGone=true → %q, want canceled", got)
	}
	if got := refundReasonForStream(false); got != "failed" {
		t.Fatalf("clientGone=false → %q, want failed", got)
	}
}
