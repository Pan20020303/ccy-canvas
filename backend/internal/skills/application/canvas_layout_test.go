package application

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// 模型盲放同一坐标时,create_node 必须自动避让,不允许节点叠死。
func TestCreateNodeAutoAvoidsOverlap(t *testing.T) {
	state := NewCanvasState([]CanvasNode{
		{ID: "n1", Type: "textNode", Position: XY{X: 100, Y: 100}, Data: map[string]any{}},
	}, nil, nil)
	tool := &createNodeTool{state}

	positions := []XY{}
	for i := 0; i < 3; i++ {
		out, err := tool.Execute(context.Background(), json.RawMessage(`{"type":"textNode","position":{"x":100,"y":100}}`))
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		var res struct {
			ID       string `json:"id"`
			Position XY     `json:"position"`
		}
		if err := json.Unmarshal([]byte(out), &res); err != nil {
			t.Fatalf("parse result: %v", err)
		}
		positions = append(positions, res.Position)
	}

	all := append([]XY{{X: 100, Y: 100}}, positions...)
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			if abs(all[i].X-all[j].X) < nodeSlotW && abs(all[i].Y-all[j].Y) < nodeSlotH {
				t.Fatalf("nodes %d and %d overlap: %+v vs %+v", i, j, all[i], all[j])
			}
		}
	}
}

// 画布概览必须带节点坐标、分组包围盒与空间规则,支撑"放在分组X上面"。
func TestBuildCanvasOverviewSpatialContext(t *testing.T) {
	nodes := []CanvasNode{
		{ID: "a", Type: "imageNode", Position: XY{X: 1200, Y: 300}, Data: map[string]any{"customTitle": "图A"}},
		{ID: "b", Type: "imageNode", Position: XY{X: 1600, Y: 500}, Data: map[string]any{"customTitle": "图B"}},
	}
	groups := []CanvasGroup{{ID: "g3", Name: "分组3", NodeIDs: []string{"a", "b"}}}

	out := BuildCanvasOverview(nodes, nil, groups)
	for _, want := range []string{"@(1200, 300)", "【分组】", "分组3", "x∈[1200,", "【空间规则】"} {
		if !strings.Contains(out, want) {
			t.Fatalf("overview missing %q:\n%s", want, out)
		}
	}
}
