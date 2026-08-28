package application

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCanvasIndexesStayConsistentAcrossMutations(t *testing.T) {
	state := NewCanvasState(
		[]CanvasNode{
			{ID: "a", Type: "textNode", Position: XY{X: 0, Y: 0}, Data: map[string]any{"content": "A"}},
			{ID: "b", Type: "imageNode", Position: XY{X: 400, Y: 0}, Data: map[string]any{"content": "B"}},
			{ID: "c", Type: "videoNode", Position: XY{X: 800, Y: 0}, Data: map[string]any{"content": "C"}},
		},
		[]CanvasEdge{
			{ID: "e1", Source: "a", Target: "b"},
			{ID: "e2", Source: "b", Target: "c"},
		},
		nil,
	)

	if _, ok := state.nodeIndex["b"]; !ok {
		t.Fatal("node index was not initialized")
	}
	if _, ok := state.edgePairs[edgePairKey("a", "b")]["e1"]; !ok {
		t.Fatal("edge-pair index does not contain e1")
	}

	move := &moveNodeTool{state: state}
	if _, err := move.Execute(context.Background(), json.RawMessage(`{"node_id":"a","position":{"x":1200,"y":600}}`)); err != nil {
		t.Fatalf("move node: %v", err)
	}
	state.mu.RLock()
	moved, ok := state.nodeLocked("a")
	if !ok || moved.Position != (XY{X: 1200, Y: 600}) {
		state.mu.RUnlock()
		t.Fatalf("moved node not found at expected position: %+v", moved)
	}
	if _, stillInOldCell := state.spatial[cellFor(XY{X: 0, Y: 0})]["a"]; stillInOldCell {
		state.mu.RUnlock()
		t.Fatal("spatial index retained the old node position")
	}
	state.mu.RUnlock()

	remove := &deleteNodeTool{state: state}
	if _, err := remove.Execute(context.Background(), json.RawMessage(`{"node_id":"b"}`)); err != nil {
		t.Fatalf("delete node: %v", err)
	}
	state.mu.RLock()
	defer state.mu.RUnlock()
	if _, ok := state.nodeIndex["b"]; ok {
		t.Fatal("deleted node remained in node index")
	}
	if len(state.Edges) != 0 || len(state.edgeIndex) != 0 || len(state.edgePairs) != 0 {
		t.Fatalf("incident edges were not fully removed: edges=%d index=%d pairs=%d", len(state.Edges), len(state.edgeIndex), len(state.edgePairs))
	}
	if _, ok := state.nodesByType["imageNode"]["b"]; ok {
		t.Fatal("deleted node remained in type index")
	}
}

func TestBatchReadAndSubgraphTools(t *testing.T) {
	state := NewCanvasState(
		[]CanvasNode{
			{ID: "a", Type: "textNode", Position: XY{X: 0, Y: 0}, Data: map[string]any{"content": "script", "promptDraft": "draft-a"}},
			{ID: "b", Type: "imageNode", Position: XY{X: 400, Y: 0}, Data: map[string]any{"customTitle": "frame", "url": "https://example.test/b.png"}},
			{ID: "c", Type: "videoNode", Position: XY{X: 800, Y: 0}, Data: map[string]any{"content": "clip"}},
		},
		[]CanvasEdge{
			{ID: "e1", Source: "a", Target: "b"},
			{ID: "e2", Source: "b", Target: "c"},
		},
		nil,
	)

	batch := &readNodesTool{state: state}
	out, err := batch.Execute(context.Background(), json.RawMessage(`{"node_ids":["a","c","missing"],"fields":["type","content"]}`))
	if err != nil {
		t.Fatalf("read_nodes: %v", err)
	}
	var batchResult struct {
		Nodes   []map[string]any `json:"nodes"`
		Missing []string         `json:"missing"`
	}
	if err := json.Unmarshal([]byte(out), &batchResult); err != nil {
		t.Fatalf("decode read_nodes: %v", err)
	}
	if len(batchResult.Nodes) != 2 || len(batchResult.Missing) != 1 || batchResult.Missing[0] != "missing" {
		t.Fatalf("unexpected read_nodes result: %s", out)
	}

	subgraph := &getSubgraphTool{state: state}
	out, err = subgraph.Execute(context.Background(), json.RawMessage(`{"node_ids":["c"],"direction":"upstream","depth":2}`))
	if err != nil {
		t.Fatalf("get_subgraph: %v", err)
	}
	var graphResult struct {
		Nodes []subgraphNode `json:"nodes"`
		Edges []CanvasEdge   `json:"edges"`
	}
	if err := json.Unmarshal([]byte(out), &graphResult); err != nil {
		t.Fatalf("decode get_subgraph: %v", err)
	}
	if len(graphResult.Nodes) != 3 || len(graphResult.Edges) != 2 {
		t.Fatalf("unexpected subgraph: %s", out)
	}
	if graphResult.Nodes[0].ID != "a" || graphResult.Nodes[1].ID != "b" || graphResult.Nodes[2].ID != "c" {
		t.Fatalf("subgraph nodes are not deterministic: %+v", graphResult.Nodes)
	}
}

func TestBuildCanvasToolsIncludesIndexedReaders(t *testing.T) {
	tools := BuildCanvasTools(NewCanvasState(nil, nil, nil))
	names := make(map[string]bool, len(tools))
	for _, tool := range tools {
		names[tool.Name()] = true
	}
	for _, name := range []string{"read_nodes", "get_subgraph", "get_canvas_delta"} {
		if !names[name] {
			t.Fatalf("BuildCanvasTools missing %s", name)
		}
	}
}

func TestCanvasRevisionDeltaAndOptimisticConflict(t *testing.T) {
	emitted := make([]map[string]any, 0, 2)
	state := NewCanvasState(
		[]CanvasNode{
			{ID: "a", Type: "textNode", Position: XY{X: 0, Y: 0}, Data: map[string]any{}},
			{ID: "b", Type: "imageNode", Position: XY{X: 400, Y: 0}, Data: map[string]any{}},
		},
		nil,
		func(event string, payload any) {
			if event == EventCanvasPatch {
				emitted = append(emitted, payload.(map[string]any))
			}
		},
	)

	move := &moveNodeTool{state: state}
	out, err := move.Execute(context.Background(), json.RawMessage(`{"node_id":"a","position":{"x":100,"y":200},"expected_revision":0}`))
	if err != nil {
		t.Fatalf("move at revision 0: %v", err)
	}
	var mutation struct {
		Revision uint64 `json:"revision"`
	}
	if err := json.Unmarshal([]byte(out), &mutation); err != nil || mutation.Revision != 1 {
		t.Fatalf("unexpected mutation result: %s err=%v", out, err)
	}
	if len(emitted) != 1 || emitted[0]["base_revision"] != uint64(0) || emitted[0]["revision"] != uint64(1) {
		t.Fatalf("patch revision metadata missing: %+v", emitted)
	}

	remove := &deleteNodeTool{state: state}
	if _, err := remove.Execute(context.Background(), json.RawMessage(`{"node_id":"a","expected_revision":0}`)); err == nil {
		t.Fatal("stale delete unexpectedly succeeded")
	} else {
		if _, ok := err.(*CanvasRevisionConflictError); !ok {
			t.Fatalf("expected CanvasRevisionConflictError, got %T: %v", err, err)
		}
	}
	state.mu.RLock()
	_, stillExists := state.nodeLocked("a")
	state.mu.RUnlock()
	if !stillExists {
		t.Fatal("conflicting delete mutated the canvas")
	}

	delta := &getCanvasDeltaTool{state: state}
	out, err = delta.Execute(context.Background(), json.RawMessage(`{"since_revision":0}`))
	if err != nil {
		t.Fatalf("get delta: %v", err)
	}
	var result struct {
		CurrentRevision uint64         `json:"current_revision"`
		NextRevision    uint64         `json:"next_revision"`
		Changes         []CanvasChange `json:"changes"`
		ResetRequired   bool           `json:"reset_required"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("decode delta: %v", err)
	}
	if result.CurrentRevision != 1 || result.NextRevision != 1 || result.ResetRequired || len(result.Changes) != 1 {
		t.Fatalf("unexpected delta: %s", out)
	}
	if result.Changes[0].Op != "move_node" || result.Changes[0].NodeIDs[0] != "a" {
		t.Fatalf("unexpected change entry: %+v", result.Changes[0])
	}

	if _, err := remove.Execute(context.Background(), json.RawMessage(`{"node_id":"a","expected_revision":1}`)); err != nil {
		t.Fatalf("delete at revision 1: %v", err)
	}
	if state.revision != 2 {
		t.Fatalf("revision did not advance after delete: %d", state.revision)
	}
}

func TestCanvasDeltaRequestsResetAfterLogCompaction(t *testing.T) {
	state := NewCanvasState(nil, nil, nil)
	state.mu.Lock()
	for i := 0; i < maxCanvasChanges+4; i++ {
		state.recordChangeLocked("move_node", []string{"a"}, nil)
	}
	state.mu.Unlock()

	delta := &getCanvasDeltaTool{state: state}
	out, err := delta.Execute(context.Background(), json.RawMessage(`{"since_revision":0}`))
	if err != nil {
		t.Fatalf("get compacted delta: %v", err)
	}
	var result struct {
		ResetRequired bool `json:"reset_required"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("decode compacted delta: %v", err)
	}
	if !result.ResetRequired {
		t.Fatalf("expected reset_required after compaction: %s", out)
	}
}
