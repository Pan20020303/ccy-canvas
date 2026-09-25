package application

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func executeCanvasRead(t *testing.T, tool Tool, args any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), raw)
	if err != nil {
		t.Fatalf("%s: %v", tool.Name(), err)
	}
	if !utf8.ValidString(result) || strings.Contains(result, "�") {
		t.Fatalf("invalid Unicode result: %s", result)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("decode %s: %v", result, err)
	}
	return out
}

func TestCanvasReadersPageStableAndRejectStaleCursor(t *testing.T) {
	nodes := make([]CanvasNode, 0, 53)
	for i := 52; i >= 0; i-- {
		nodes = append(nodes, CanvasNode{ID: fmt.Sprintf("n%02d", i), Type: "imageNode", Data: map[string]any{"customTitle": "角色"}})
	}
	state := NewCanvasStateAtRevision(nodes, nil, 7, nil)
	reader := &listNodesTool{state}
	first := executeCanvasRead(t, reader, map[string]any{})
	if len(first["nodes"].([]any)) != 20 || first["total"] != float64(53) || first["truncated"] != true || first["revision"] != float64(7) || first["snapshot_scope"] != "run_snapshot" {
		t.Fatalf("unexpected page: %+v", first)
	}
	seen := make([]string, 0, 53)
	for page := first; ; {
		for _, node := range page["nodes"].([]any) {
			seen = append(seen, node.(map[string]any)["id"].(string))
		}
		cursor := page["next_cursor"].(string)
		if cursor == "" {
			break
		}
		page = executeCanvasRead(t, reader, map[string]any{"cursor": cursor})
	}
	if len(seen) != 53 {
		t.Fatalf("unexpected count %d", len(seen))
	}
	for i, id := range seen {
		if id != fmt.Sprintf("n%02d", i) {
			t.Fatalf("unstable order at %d: %s", i, id)
		}
	}
	for _, args := range []map[string]any{
		{"limit": 51}, {"limit": -1}, {"cursor": "not a cursor"},
		{"cursor": first["next_cursor"], "type": "videoNode"},
	} {
		raw, _ := json.Marshal(args)
		if _, err := reader.Execute(context.Background(), raw); err == nil {
			t.Fatalf("expected rejection for %+v", args)
		}
	}
	state.mu.Lock()
	state.recordChangeLocked("test", nil, nil)
	state.mu.Unlock()
	raw, _ := json.Marshal(map[string]any{"cursor": first["next_cursor"]})
	if _, err := reader.Execute(context.Background(), raw); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("expected stale cursor, got %v", err)
	}
}

func TestCanvasReadersSearchTitleFileContentPromptAndGroup(t *testing.T) {
	state := NewCanvasState([]CanvasNode{
		{ID: "a", Type: "imageNode", Data: map[string]any{"customTitle": "第四集 护士", "sourceName": "Upload-FILE.png", "content": "病房角色表", "promptDraft": "制服整洁", "prompt": "自然站姿", "url": "https://example.test/a.png", "generationStatus": "success"}},
		{ID: "b", Type: "imageNode", Data: map[string]any{"customTitle": "第四集 护士", "sourceName": "other.png"}},
		{ID: "c", Type: "videoNode", Data: map[string]any{"customTitle": "护士视频"}},
	}, nil, nil)
	state.Groups = []CanvasGroup{{ID: "ep4", Name: "第四集", NodeIDs: []string{"a", "c", "a", "gone"}}, {ID: "empty", Name: "保留空组"}}
	reader := &findNodesTool{state}
	for _, term := range []string{"第四集", "UPLOAD-file", "病房", "制服", "自然站姿"} {
		result := executeCanvasRead(t, reader, map[string]any{"name_contains": term, "group_id": "ep4", "type": "imageNode"})
		if result["total"] != float64(1) {
			t.Fatalf("search %s: %+v", term, result)
		}
		node := result["nodes"].([]any)[0].(map[string]any)
		if node["id"] != "a" || node["name"] != "第四集 护士" || node["source_name"] != "Upload-FILE.png" || node["status"] != "success" || node["has_url"] != true {
			t.Fatalf("unexpected summary: %+v", node)
		}
		if _, ok := node["content"]; ok {
			t.Fatal("list unexpectedly included content")
		}
	}
	ambiguous := executeCanvasRead(t, reader, map[string]any{"name_contains": "第四集 护士"})
	if ambiguous["total"] != float64(2) {
		t.Fatalf("duplicate names should remain separate candidates: %+v", ambiguous)
	}
	if _, err := reader.Execute(context.Background(), json.RawMessage(`{"group_id":"no-such-group"}`)); err == nil {
		t.Fatal("unknown group must not fall back to whole canvas")
	}
	groups := executeCanvasRead(t, &listGroupsTool{state}, map[string]any{"limit": 1})
	if groups["total"] != float64(2) || groups["truncated"] != true {
		t.Fatalf("unexpected groups: %+v", groups)
	}
	empty := executeCanvasRead(t, &readGroupTool{state}, map[string]any{"group_id": "empty"})
	if empty["total"] != float64(0) || len(empty["nodes"].([]any)) != 0 || empty["group"].(map[string]any)["name"] != "保留空组" {
		t.Fatalf("empty group disappeared: %+v", empty)
	}
	group := executeCanvasRead(t, &readGroupTool{state}, map[string]any{"group_id": "ep4", "limit": 1})
	if group["total"] != float64(2) || group["truncated"] != true {
		t.Fatalf("stale/duplicate members inflated result: %+v", group)
	}
	last := executeCanvasRead(t, &readGroupTool{state}, map[string]any{"group_id": "ep4", "limit": 1, "cursor": group["next_cursor"]})
	if last["nodes"].([]any)[0].(map[string]any)["id"] != "c" || last["next_cursor"] != "" {
		t.Fatalf("group pagination: %+v", last)
	}
}

func TestCanvasReadersMetadataOnlyAndUnicodePromptPagination(t *testing.T) {
	prompt := strings.Repeat("护👩士镜头。", 700)
	state := NewCanvasState([]CanvasNode{{ID: "a", Type: "imageNode", Data: map[string]any{
		"customTitle": strings.Repeat("护士", 100), "sourceName": "角色.png", "promptDraft": prompt, "content": "正文不应默认读取",
		"url": "data:image/png;base64," + strings.Repeat("A", 50000), "editorState": map[string]any{"secret": "raw editor data"},
	}}}, nil, nil)
	reader := &readNodeTool{state}
	metadata := executeCanvasRead(t, reader, map[string]any{"node_id": "a"})
	data := metadata["data"].(map[string]any)
	for _, forbidden := range []string{"promptDraft", "content", "url", "editorState"} {
		if _, ok := data[forbidden]; ok {
			t.Fatalf("default leaked %s", forbidden)
		}
	}
	if len([]rune(metadata["name"].(string))) > 121 {
		t.Fatal("unbounded node name")
	}
	var rebuilt strings.Builder
	for offset := 0; ; {
		page := executeCanvasRead(t, reader, map[string]any{"node_id": "a", "fields": []string{"promptDraft"}, "text_limit": 503, "text_offset": offset})
		chunk := page["data"].(map[string]any)["promptDraft"].(string)
		rebuilt.WriteString(chunk)
		if len([]rune(chunk)) > 503 {
			t.Fatal("text limit exceeded")
		}
		field := page["field_pages"].(map[string]any)["promptDraft"].(map[string]any)
		if field["next_offset"] == nil {
			break
		}
		offset = int(field["next_offset"].(float64))
	}
	if rebuilt.String() != prompt {
		t.Fatal("prompt pagination corrupted/truncated Chinese/emoji content")
	}
	all := executeCanvasRead(t, reader, map[string]any{"node_id": "a", "fields": []string{"data"}})
	encoded, _ := json.Marshal(all)
	if strings.Contains(string(encoded), "base64") || strings.Contains(string(encoded), "raw editor data") {
		t.Fatal("whitelisted data read leaked binary/editor payload")
	}
	if all["field_pages"].(map[string]any)["url"].(map[string]any)["reason"] != "inline_media" {
		t.Fatal("inline media omission is not explained")
	}
}

func TestCanvasReadersBoundBatchBudgetAndValidateFields(t *testing.T) {
	state := NewCanvasState([]CanvasNode{
		{ID: "a", Type: "textNode", Data: map[string]any{"content": strings.Repeat("甲", 9000)}},
		{ID: "b", Type: "textNode", Data: map[string]any{"content": strings.Repeat("乙", 9000)}},
		{ID: "c", Type: "textNode", Data: map[string]any{"content": strings.Repeat("丙", 9000)}},
	}, nil, nil)
	reader := &readNodesTool{state}
	result := executeCanvasRead(t, reader, map[string]any{"node_ids": []string{"a", "a", "b", "missing", "c"}, "fields": []string{"content"}, "text_limit": 8000})
	if result["text_used"] != float64(16000) || len(result["nodes"].([]any)) != 3 || len(result["missing"].([]any)) != 1 {
		t.Fatalf("unexpected batch budget: %+v", result)
	}
	last := result["nodes"].([]any)[2].(map[string]any)
	if last["data"].(map[string]any)["content"] != "" || last["field_pages"].(map[string]any)["content"].(map[string]any)["next_offset"] != float64(0) {
		t.Fatal("budget exhausted should leave an explicit continuation")
	}
	for _, args := range []string{
		`{"node_ids":["a"],"fields":["editorState"]}`,
		`{"node_ids":["a"],"text_offset":-1}`,
		`{"node_ids":["a"],"text_limit":8001}`,
		`{"node_ids":[]}`,
	} {
		if _, err := reader.Execute(context.Background(), json.RawMessage(args)); err == nil {
			t.Fatalf("expected invalid read to fail: %s", args)
		}
	}
	ids := make([]string, 51)
	raw, _ := json.Marshal(map[string]any{"node_ids": ids})
	if _, err := reader.Execute(context.Background(), raw); err == nil {
		t.Fatal("more than 50 IDs should fail")
	}
}

func TestCanvasReadersNeverReturnBrokenURL(t *testing.T) {
	state := NewCanvasState([]CanvasNode{{ID: "a", Type: "imageNode", Data: map[string]any{"url": "https://example.test/image?signature=" + strings.Repeat("a", 9000)}}}, nil, nil)
	result := executeCanvasRead(t, &readNodeTool{state}, map[string]any{"node_id": "a", "fields": []string{"url"}})
	if _, ok := result["data"].(map[string]any)["url"]; ok {
		t.Fatal("oversized URL must not be returned partially")
	}
	if result["field_pages"].(map[string]any)["url"].(map[string]any)["omitted"] != true {
		t.Fatal("missing omission explanation")
	}
}

func TestCanvasReadersGenerationSettingsAreWhitelisted(t *testing.T) {
	state := NewCanvasState([]CanvasNode{{ID: "a", Type: "videoNode", Data: map[string]any{"generationParams": map[string]any{
		"aspectRatio": "16:9", "resolution": "720p", "duration": 30, "generateAudio": true,
		"references": []string{"data:image/png;base64,AAAA"}, "editorScene": map[string]any{"mesh": strings.Repeat("x", 9000)},
	}}}}, nil, nil)
	result := executeCanvasRead(t, &readNodeTool{state}, map[string]any{"node_id": "a", "fields": []string{"generationParams"}})
	params := result["data"].(map[string]any)["generationParams"].(map[string]any)
	if len(params) != 4 || params["resolution"] != "720p" || params["aspectRatio"] != "16:9" || params["duration"] != float64(30) || params["generateAudio"] != true {
		t.Fatalf("unexpected parameters: %+v", params)
	}
	if result["field_pages"].(map[string]any)["generationParams"].(map[string]any)["omitted_fields"] != float64(2) {
		t.Fatal("omitted nested data should be explicit")
	}
}

func TestCanvasReadersSubgraphBoundsDenseConnections(t *testing.T) {
	nodes := make([]CanvasNode, 0, 30)
	edges := make([]CanvasEdge, 0, 900)
	for i := 0; i < 30; i++ {
		nodes = append(nodes, CanvasNode{ID: fmt.Sprintf("n%02d", i), Type: "textNode", Data: map[string]any{}})
		for j := 0; j < 30; j++ {
			if i != j {
				edges = append(edges, CanvasEdge{ID: fmt.Sprintf("e%02d-%02d", i, j), Source: fmt.Sprintf("n%02d", i), Target: fmt.Sprintf("n%02d", j)})
			}
		}
	}
	state := NewCanvasState(nodes, edges, nil)
	result := executeCanvasRead(t, &getSubgraphTool{state}, map[string]any{"node_ids": []string{"n00"}, "depth": 2})
	if len(result["edges"].([]any)) != 200 || result["truncated"] != true || result["snapshot_scope"] != "run_snapshot" {
		t.Fatalf("dense subgraph was not bounded: edges=%d truncated=%v", len(result["edges"].([]any)), result["truncated"])
	}
}

func TestCanvasReadersRegisteredAndGuideIsOnDemand(t *testing.T) {
	tools := BuildCanvasTools(NewCanvasState(nil, nil, nil))
	for _, name := range []string{"list_groups", "read_group", "list_nodes", "find_nodes", "read_node", "read_nodes"} {
		tool := findTool(tools, name)
		if tool == nil || !json.Valid(tool.Parameters()) {
			t.Fatalf("missing tool/schema %s", name)
		}
	}
	if strings.Contains(AgentInteractionGuide, "已提供画布摘要") || !strings.Contains(AgentInteractionGuide, "画布内容没有预加载") || !strings.Contains(AgentInteractionGuide, "普通问候") {
		t.Fatal("interaction guide must not assume the canvas is preloaded")
	}
}
