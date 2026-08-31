package application

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestCreateGenerationBatchCreatesFiftySelfContainedNodes(t *testing.T) {
	events := make([]map[string]any, 0, 100)
	state := NewCanvasState(nil, nil, func(event string, payload any) {
		if event == EventCanvasPatch {
			events = append(events, payload.(map[string]any))
		}
	})
	items := make([]map[string]string, 50)
	for index := range items {
		items[index] = map[string]string{
			"prompt": fmt.Sprintf("完整画面提示词 %d", index+1),
			"title":  fmt.Sprintf("分镜 %d", index+1),
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"node_type": "imageNode",
		"model":     "doubao-seedream-5-0-260128",
		"columns":   5,
		"items":     items,
	})
	out, err := (&createGenerationBatchTool{state: state}).Execute(context.Background(), payload)
	if err != nil {
		t.Fatalf("create_generation_batch: %v", err)
	}
	var result struct {
		Created  int      `json:"created"`
		NodeIDs  []string `json:"node_ids"`
		Revision uint64   `json:"revision"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Created != 50 || len(result.NodeIDs) != 50 || result.Revision != 50 {
		t.Fatalf("unexpected result: %s", out)
	}
	if len(state.Nodes) != 50 || len(events) != 100 {
		t.Fatalf("nodes=%d events=%d, want 50/100", len(state.Nodes), len(events))
	}
	seen := make(map[string]bool, 50)
	for index, node := range state.Nodes {
		prompt := fmt.Sprintf("完整画面提示词 %d", index+1)
		if node.Data["promptDraft"] != prompt {
			t.Fatalf("node %d prompt=%v", index, node.Data["promptDraft"])
		}
		if node.Data["model"] != "doubao-seedream-5-0-260128" {
			t.Fatalf("node %d model=%v", index, node.Data["model"])
		}
		if seen[node.ID] {
			t.Fatalf("duplicate node id %s", node.ID)
		}
		seen[node.ID] = true
		addPatch := events[index*2]
		runPatch := events[index*2+1]
		if addPatch["op"] != "add_node" || runPatch["op"] != "run_node" {
			t.Fatalf("event pair %d out of order: %#v %#v", index, addPatch, runPatch)
		}
		if runPatch["prompt"] != prompt || runPatch["model"] != "doubao-seedream-5-0-260128" {
			t.Fatalf("run patch %d is not self-contained: %#v", index, runPatch)
		}
	}
}

func TestCreateGenerationBatchRejectsEmptyPromptAtomically(t *testing.T) {
	events := 0
	state := NewCanvasState(nil, nil, func(string, any) { events++ })
	payload := json.RawMessage(`{
		"node_type":"imageNode",
		"model":"doubao-seedream-5-0-260128",
		"items":[{"prompt":"第一张"},{"prompt":"   "},{"prompt":"第三张"}]
	}`)
	if _, err := (&createGenerationBatchTool{state: state}).Execute(context.Background(), payload); err == nil {
		t.Fatal("empty prompt was accepted")
	}
	if len(state.Nodes) != 0 || events != 0 || state.revision != 0 {
		t.Fatalf("invalid batch partially mutated canvas: nodes=%d events=%d revision=%d", len(state.Nodes), events, state.revision)
	}
}

func TestRunNodePatchCarriesPromptAndRejectsIncompleteNode(t *testing.T) {
	var patch map[string]any
	state := NewCanvasState([]CanvasNode{{
		ID: "ready", Type: "imageNode", Data: map[string]any{"promptDraft": "自包含提示词"},
	}, {
		ID: "empty", Type: "imageNode", Data: map[string]any{},
	}}, nil, func(event string, payload any) {
		if event == EventCanvasPatch {
			patch = payload.(map[string]any)
		}
	})
	run := &runNodeTool{state: state}
	if _, err := run.Execute(context.Background(), json.RawMessage(`{"node_id":"ready","model":"seedream-5"}`)); err != nil {
		t.Fatalf("run ready node: %v", err)
	}
	if patch["prompt"] != "自包含提示词" || patch["model"] != "seedream-5" {
		t.Fatalf("run patch missing prompt/model: %#v", patch)
	}
	if _, err := run.Execute(context.Background(), json.RawMessage(`{"node_id":"empty"}`)); err == nil {
		t.Fatal("node without prompt was submitted")
	}
	if _, err := run.Execute(context.Background(), json.RawMessage(`{"node_id":"missing"}`)); err == nil {
		t.Fatal("missing node was submitted")
	}
}

func TestBuildCanvasToolsIncludesGenerationBatch(t *testing.T) {
	for _, tool := range BuildCanvasTools(NewCanvasState(nil, nil, nil)) {
		if tool.Name() == "create_generation_batch" {
			return
		}
	}
	t.Fatal("BuildCanvasTools missing create_generation_batch")
}
