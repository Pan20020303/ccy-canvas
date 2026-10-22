package application

import "testing"

// 计费/数量放大修复(安全审计 CRITICAL-1):预留积分必须 = 上游实际计费数量，
// 且发给 relay 的 n 不得超过收费张数。

func TestClampOutputCount(t *testing.T) {
	cases := map[int]int{-5: 1, 0: 1, 1: 1, 4: 4, 12: 12, 13: 12, 100: 12, 1 << 30: 12}
	for in, want := range cases {
		if got := ClampOutputCount(in); got != want {
			t.Errorf("ClampOutputCount(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestCapOutputCountPreservesZero(t *testing.T) {
	// 边界版:保留 0(未指定→下游默认),负数归 0，只压上限。
	cases := map[int]int{-3: 0, 0: 0, 1: 1, 12: 12, 999: 12}
	for in, want := range cases {
		if got := CapOutputCount(in); got != want {
			t.Errorf("CapOutputCount(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestClampVideoDuration(t *testing.T) {
	cases := map[int]int{-1: 0, 0: 0, 8: 8, 60: 60, 61: 60, 600: 60}
	for in, want := range cases {
		if got := ClampVideoDuration(in); got != want {
			t.Errorf("ClampVideoDuration(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestBillableUnitsScalesImageByCount(t *testing.T) {
	cases := []struct {
		name string
		req  GenerateRequest
		want int32
	}{
		{"image n=1", GenerateRequest{ServiceType: "image", OutputCount: 1}, 1},
		{"image n=4", GenerateRequest{ServiceType: "image", OutputCount: 4}, 4},
		{"image n=0 -> 1", GenerateRequest{ServiceType: "image", OutputCount: 0}, 1},
		{"image amplify 100 -> capped 12", GenerateRequest{ServiceType: "image", OutputCount: 100}, 12},
		{"video per-call", GenerateRequest{ServiceType: "video", OutputCount: 100, Duration: 60}, 1},
		{"text per-call", GenerateRequest{ServiceType: "text", OutputCount: 50}, 1},
		{"audio per-call", GenerateRequest{ServiceType: "audio", OutputCount: 9}, 1},
	}
	for _, c := range cases {
		if got := billableUnits(c.req); got != c.want {
			t.Errorf("%s: billableUnits = %d, want %d", c.name, got, c.want)
		}
	}
}

// 不变量:发给 relay 的张数(requestedImageCount) 永不超过收费张数(billableUnits)。
func TestRelayCountNeverExceedsCharged(t *testing.T) {
	for _, n := range []int{-1, 0, 1, 3, 12, 13, 100, 100000} {
		req := GenerateRequest{ServiceType: "image", OutputCount: n}
		relayN := requestedImageCount(req)
		charged := int(billableUnits(req))
		if relayN > charged {
			t.Errorf("n=%d: relay would generate %d but only %d charged (amplification!)", n, relayN, charged)
		}
		if relayN < 1 {
			t.Errorf("n=%d: relay count %d < 1", n, relayN)
		}
	}
}
