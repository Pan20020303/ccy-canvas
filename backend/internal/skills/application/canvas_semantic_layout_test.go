package application

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSemanticCreateWithoutCoordinateRead(t *testing.T) {
	s := NewCanvasState([]CanvasNode{{ID: "anchor", Type: "textNode", Position: XY{-1500, -800}, Measured: &CanvasSize{800, 650}}}, nil, nil)
	result, err := (&createNodeTool{s}).Execute(context.Background(), []byte(`{"type":"imageNode","placement":{"anchor_id":"anchor","relation":"right"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, "position") {
		t.Fatal("geometry should stay in patches, not LLM results")
	}
	n := s.Nodes[1]
	if n.Position.X != -660 || n.Position.Y != -800 {
		t.Fatalf("measured geometry ignored: %+v", n)
	}
	if _, err = (&createNodeTool{s}).Execute(context.Background(), []byte(`{"type":"textNode"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestRelativeLayoutPreservesAboveRelationWhileAvoidingObstacle(t *testing.T) {
	s := NewCanvasState([]CanvasNode{
		{ID: "anchor", Position: XY{0, 0}},
		{ID: "obstacle", Position: XY{0, -280}},
	}, nil, nil)
	_, err := (&createNodeTool{s}).Execute(context.Background(), []byte(`{"type":"imageNode","placement":{"anchor_id":"anchor","relation":"above"}}`))
	if err != nil {
		t.Fatal(err)
	}
	n := s.Nodes[2]
	if n.Position.Y+nodeSize(n).Height > -40 {
		t.Fatalf("not above: %+v", n)
	}
	if rectOverlap(nodeRect(n), nodeRect(s.Nodes[1]), 40) {
		t.Fatal("overlapping obstacle")
	}
}

func TestBatchFlowLayoutIsAtomicAndDimensionAware(t *testing.T) {
	var patches []map[string]any
	s := NewCanvasState([]CanvasNode{
		{ID: "a", Position: XY{0, 0}, Measured: &CanvasSize{600, 700}},
		{ID: "b", Position: XY{0, 0}, Measured: &CanvasSize{350, 260}},
		{ID: "c", Position: XY{0, 0}},
		{ID: "outside", Position: XY{0, 0}, Measured: &CanvasSize{900, 900}},
	}, []CanvasEdge{{ID: "ab", Source: "a", Target: "b"}, {ID: "bc", Source: "b", Target: "c"}}, func(event string, data any) {
		if event == EventCanvasPatch {
			patches = append(patches, data.(map[string]any))
		}
	})
	out, err := (&layoutNodesTool{s}).Execute(context.Background(), []byte(`{"node_ids":["c","a","b"],"mode":"flow","expected_revision":0}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(patches) != 1 || patches[0]["op"] != "move_nodes" || s.revision != 1 {
		t.Fatalf("not atomic: %+v", patches)
	}
	if !strings.Contains(out, `"layout":"flow"`) {
		t.Fatal(out)
	}
	if !(s.Nodes[0].Position.X < s.Nodes[1].Position.X && s.Nodes[1].Position.X < s.Nodes[2].Position.X) {
		t.Fatal("dependency order ignored")
	}
	if s.Nodes[3].Position != (XY{0, 0}) || len(s.Edges) != 2 {
		t.Fatal("unselected data changed")
	}
	for i := range s.Nodes {
		for j := 0; j < i; j++ {
			if rectOverlap(nodeRect(s.Nodes[i]), nodeRect(s.Nodes[j]), 40) {
				t.Fatalf("overlap %d %d", i, j)
			}
		}
	}
	for _, raw := range []string{`{"node_ids":["a","missing"],"mode":"row"}`, `{"node_ids":["a","b"],"mode":"grid","expected_revision":0}`, `{"node_ids":["a","a"],"mode":"grid"}`} {
		if _, err := (&layoutNodesTool{s}).Execute(context.Background(), []byte(raw)); err == nil {
			t.Fatal("invalid layout accepted")
		}
		if len(patches) != 1 || s.revision != 1 {
			t.Fatal("failed operation partially mutated canvas")
		}
	}
}

func TestSemanticLayoutHandlesGroupsLocksAndCycles(t *testing.T) {
	s := NewCanvasState([]CanvasNode{{ID: "a"}, {ID: "b"}, {ID: "c", Position: XY{900, 900}}}, []CanvasEdge{{Source: "a", Target: "b"}, {Source: "b", Target: "a"}}, nil)
	s.Groups = []CanvasGroup{{ID: "group", NodeIDs: []string{"c"}}}
	out, err := (&layoutNodesTool{s}).Execute(context.Background(), []byte(`{"node_ids":["a","b"],"mode":"flow","placement":{"anchor_id":"group","relation":"left"}}`))
	if err != nil || !strings.Contains(out, `"cycle_fallback":true`) {
		t.Fatalf("%s %v", out, err)
	}
	for _, n := range s.Nodes[:2] {
		if n.Position.X+nodeSize(n).Width > 860 {
			t.Fatal("not left of group")
		}
	}
	locked := false
	s.Nodes[0].Draggable = &locked
	before, _ := json.Marshal(s.Nodes)
	if _, err := (&layoutNodesTool{s}).Execute(context.Background(), []byte(`{"node_ids":["a","b"],"mode":"row"}`)); err == nil {
		t.Fatal("locked node moved")
	}
	after, _ := json.Marshal(s.Nodes)
	if string(before) != string(after) {
		t.Fatal("partial mutation")
	}
}

func TestDenseGridLayoutRemainsNonOverlapping(t *testing.T) {
	nodes := []CanvasNode{}
	ids := []string{}
	for i := 0; i < 100; i++ {
		id := fmt.Sprint(i)
		ids = append(ids, id)
		nodes = append(nodes, CanvasNode{ID: id, Position: XY{-800, -900}, Measured: &CanvasSize{float64(200 + i%5*70), float64(150 + i%7*60)}})
	}
	s := NewCanvasState(nodes, nil, nil)
	args, _ := json.Marshal(map[string]any{"node_ids": ids, "mode": "grid", "columns": 10})
	if _, err := (&layoutNodesTool{s}).Execute(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	for i := range s.Nodes {
		for j := 0; j < i; j++ {
			if rectOverlap(nodeRect(s.Nodes[i]), nodeRect(s.Nodes[j]), 40) {
				t.Fatalf("overlap %d %d", i, j)
			}
		}
	}
}

func TestUnmeasuredNodeFootprintsAndSingleMovePrecondition(t *testing.T) {
	text := nodeSize(CanvasNode{Type: "textNode", Data: map[string]any{"boxWidth": 620.0, "boxHeight": 800.0}})
	if text.Width != 620 || text.Height < 800 {
		t.Fatalf("text renderer sizing ignored: %+v", text)
	}
	portrait := nodeSize(CanvasNode{Type: "imageNode", Data: map[string]any{"generationParams": map[string]any{"aspectRatio": "9:16"}}})
	if portrait.Height < portrait.Width*16/9 {
		t.Fatalf("portrait sizing ignored: %+v", portrait)
	}
	var patch map[string]any
	s := NewCanvasState([]CanvasNode{{ID: "a", Position: XY{10, 20}}, {ID: "b", Position: XY{400, 20}}}, nil, func(event string, data any) {
		if event == EventCanvasPatch {
			patch = data.(map[string]any)
		}
	})
	if _, err := (&moveNodeTool{s}).Execute(context.Background(), []byte(`{"node_id":"a","placement":{"anchor_id":"b","relation":"below"}}`)); err != nil {
		t.Fatal(err)
	}
	if patch["from_position"] != (XY{10, 20}) {
		t.Fatal("move patch omitted original position")
	}
}
