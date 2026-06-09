package application

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Tool is anything the agent can invoke. Implementations cover both
// canvas-CLI ops (manipulate node graph) and bound skills (HTTP / prompt).
type Tool interface {
	Name() string
	Description() string
	// Parameters returns a JSON Schema describing the expected `arguments`.
	Parameters() json.RawMessage
	// Execute runs the tool and returns a short string the LLM will read as
	// the tool_result message.
	Execute(ctx context.Context, args json.RawMessage) (string, error)
}

// ─── Canvas state ────────────────────────────────────────────────────────────
//
// CanvasState is the in-memory copy of the React Flow project the agent is
// working against. The frontend sends it with the initial run request; tools
// mutate it locally as the agent reasons, AND emit canvas_patch SSE events
// so the browser reflects the same mutations in real time.

type CanvasState struct {
	mu    sync.Mutex
	Nodes []CanvasNode `json:"nodes"`
	Edges []CanvasEdge `json:"edges"`
	// emit lets tools push events back to the SSE stream.
	emit func(string, any)
	// idCounter for deterministic node IDs when the agent doesn't supply one.
	idCounter int
}

type CanvasNode struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Position XY             `json:"position"`
	// Always serialize `data` (no omitempty) so the React Flow node always
	// has a `.data` object to read — node renderers blow up on undefined.
	Data map[string]any `json:"data"`
}

type CanvasEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

type XY struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

func NewCanvasState(nodes []CanvasNode, edges []CanvasEdge, emit func(string, any)) *CanvasState {
	if emit == nil {
		emit = func(string, any) {}
	}
	return &CanvasState{Nodes: nodes, Edges: edges, emit: emit}
}

// nextID generates a unique node/edge id that won't collide with the existing
// snapshot. Format is human-readable so logs are easy to follow.
func (s *CanvasState) nextID(prefix string) string {
	s.idCounter++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixMilli(), s.idCounter)
}

// ─── Canvas tools ────────────────────────────────────────────────────────────

type listNodesTool struct{ state *CanvasState }

func (t *listNodesTool) Name() string        { return "list_nodes" }
func (t *listNodesTool) Description() string { return "List all nodes currently on the canvas with id, type, and brief data summary." }
func (t *listNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
}
func (t *listNodesTool) Execute(_ context.Context, _ json.RawMessage) (string, error) {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	type brief struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Name    string `json:"name,omitempty"`
		HasURL  bool   `json:"has_url,omitempty"`
		Content string `json:"content,omitempty"`
	}
	out := make([]brief, 0, len(t.state.Nodes))
	for _, n := range t.state.Nodes {
		b := brief{ID: n.ID, Type: n.Type}
		if v, ok := n.Data["sourceName"].(string); ok {
			b.Name = v
		} else if v, ok := n.Data["customTitle"].(string); ok {
			b.Name = v
		}
		if v, ok := n.Data["url"].(string); ok && v != "" {
			b.HasURL = true
		}
		if v, ok := n.Data["content"].(string); ok {
			if len(v) > 80 {
				v = v[:80] + "..."
			}
			b.Content = v
		}
		out = append(out, b)
	}
	raw, _ := json.Marshal(out)
	return string(raw), nil
}

type createNodeTool struct{ state *CanvasState }

func (t *createNodeTool) Name() string { return "create_node" }
func (t *createNodeTool) Description() string {
	return "Add a new node to the canvas. type ∈ {imageNode, videoNode, textNode, audioNode, referenceImageNode, referenceVideoNode}. Returns the new node id."
}
func (t *createNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{
        "type":"object",
        "properties":{
          "type":{"type":"string","enum":["imageNode","videoNode","textNode","audioNode","referenceImageNode","referenceVideoNode"]},
          "position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]},
          "data":{"type":"object","additionalProperties":true}
        },
        "required":["type","position"]
    }`)
}
func (t *createNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		Type     string         `json:"type"`
		Position XY             `json:"position"`
		Data     map[string]any `json:"data"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if p.Data == nil {
		p.Data = map[string]any{}
	}
	// Seed sensible defaults so the React renderer doesn't trip over a
	// completely empty data bag. The agent is welcome to overwrite them.
	if _, ok := p.Data["customTitle"]; !ok {
		switch p.Type {
		case "imageNode":
			p.Data["customTitle"] = "生成图像"
		case "videoNode":
			p.Data["customTitle"] = "生成视频"
		case "textNode":
			p.Data["customTitle"] = "文本"
		case "audioNode":
			p.Data["customTitle"] = "音频"
		case "referenceImageNode":
			p.Data["customTitle"] = "参考图像"
		case "referenceVideoNode":
			p.Data["customTitle"] = "参考视频"
		}
	}
	t.state.mu.Lock()
	node := CanvasNode{ID: t.state.nextID("ag"), Type: p.Type, Position: p.Position, Data: p.Data}
	t.state.Nodes = append(t.state.Nodes, node)
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, map[string]any{"op": "add_node", "node": node})
	out, _ := json.Marshal(map[string]string{"id": node.ID})
	return string(out), nil
}

type connectNodesTool struct{ state *CanvasState }

func (t *connectNodesTool) Name() string        { return "connect_nodes" }
func (t *connectNodesTool) Description() string { return "Create an edge from source node to target node." }
func (t *connectNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"source":{"type":"string"},"target":{"type":"string"}},"required":["source","target"]}`)
}
func (t *connectNodesTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct{ Source, Target string }
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	// Prevent duplicate edges.
	for _, e := range t.state.Edges {
		if e.Source == p.Source && e.Target == p.Target {
			t.state.mu.Unlock()
			return `{"ok":true,"existing":true}`, nil
		}
	}
	edge := CanvasEdge{ID: t.state.nextID("ae"), Source: p.Source, Target: p.Target}
	t.state.Edges = append(t.state.Edges, edge)
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, map[string]any{"op": "add_edge", "edge": edge})
	return `{"ok":true}`, nil
}

type setPromptTool struct{ state *CanvasState }

func (t *setPromptTool) Name() string { return "set_prompt" }
func (t *setPromptTool) Description() string {
	return "Set the prompt (description) used when the node generates."
}
func (t *setPromptTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"prompt":{"type":"string"}},"required":["node_id","prompt"]}`)
}
func (t *setPromptTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID string `json:"node_id"`
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	found := false
	for i := range t.state.Nodes {
		if t.state.Nodes[i].ID == p.NodeID {
			if t.state.Nodes[i].Data == nil {
				t.state.Nodes[i].Data = map[string]any{}
			}
			t.state.Nodes[i].Data["promptDraft"] = p.Prompt
			found = true
			break
		}
	}
	t.state.mu.Unlock()
	if !found {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	t.state.emit(EventCanvasPatch, map[string]any{
		"op":      "patch_node_data",
		"node_id": p.NodeID,
		"patch":   map[string]string{"promptDraft": p.Prompt},
	})
	return `{"ok":true}`, nil
}

type runNodeTool struct{ state *CanvasState }

func (t *runNodeTool) Name() string { return "run_node" }
func (t *runNodeTool) Description() string {
	return "Trigger generation on the target node. The browser will perform the actual API call; this just signals it to start."
}
func (t *runNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"}},"required":["node_id"]}`)
}
func (t *runNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID string `json:"node_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.emit(EventCanvasPatch, map[string]any{"op": "run_node", "node_id": p.NodeID})
	return `{"ok":true,"note":"Submitted to browser for generation"}`, nil
}

// ─── Additional canvas tools ─────────────────────────────────────────────────

type deleteNodeTool struct{ state *CanvasState }

func (t *deleteNodeTool) Name() string        { return "delete_node" }
func (t *deleteNodeTool) Description() string { return "Remove a node and all edges connected to it." }
func (t *deleteNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"}},"required":["node_id"]}`)
}
func (t *deleteNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct{ NodeID string `json:"node_id"` }
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	keptNodes := t.state.Nodes[:0]
	for _, n := range t.state.Nodes {
		if n.ID != p.NodeID {
			keptNodes = append(keptNodes, n)
		}
	}
	t.state.Nodes = keptNodes
	keptEdges := t.state.Edges[:0]
	for _, e := range t.state.Edges {
		if e.Source != p.NodeID && e.Target != p.NodeID {
			keptEdges = append(keptEdges, e)
		}
	}
	t.state.Edges = keptEdges
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, map[string]any{"op": "delete_node", "node_id": p.NodeID})
	return `{"ok":true}`, nil
}

type moveNodeTool struct{ state *CanvasState }

func (t *moveNodeTool) Name() string        { return "move_node" }
func (t *moveNodeTool) Description() string { return "Move a node to a new position on the canvas." }
func (t *moveNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]}},"required":["node_id","position"]}`)
}
func (t *moveNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID   string `json:"node_id"`
		Position XY     `json:"position"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	found := false
	for i := range t.state.Nodes {
		if t.state.Nodes[i].ID == p.NodeID {
			t.state.Nodes[i].Position = p.Position
			found = true
			break
		}
	}
	t.state.mu.Unlock()
	if !found {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	t.state.emit(EventCanvasPatch, map[string]any{"op": "move_node", "node_id": p.NodeID, "position": p.Position})
	return `{"ok":true}`, nil
}

type readNodeTool struct{ state *CanvasState }

func (t *readNodeTool) Name() string        { return "read_node" }
func (t *readNodeTool) Description() string { return "Read the full data of a node: type, position, url, content, prompt, etc." }
func (t *readNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"}},"required":["node_id"]}`)
}
func (t *readNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct{ NodeID string `json:"node_id"` }
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	for _, n := range t.state.Nodes {
		if n.ID == p.NodeID {
			out, _ := json.Marshal(n)
			return string(out), nil
		}
	}
	return "", fmt.Errorf("node not found: %s", p.NodeID)
}

type findNodesTool struct{ state *CanvasState }

func (t *findNodesTool) Name() string        { return "find_nodes" }
func (t *findNodesTool) Description() string { return "Find nodes matching a type and/or a substring in their name/content." }
func (t *findNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"type":{"type":"string"},"name_contains":{"type":"string"}},"additionalProperties":false}`)
}
func (t *findNodesTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		Type         string `json:"type"`
		NameContains string `json:"name_contains"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	needle := strings.ToLower(p.NameContains)
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	type brief struct {
		ID, Type, Name string
	}
	out := []brief{}
	for _, n := range t.state.Nodes {
		if p.Type != "" && n.Type != p.Type {
			continue
		}
		name := ""
		if v, ok := n.Data["sourceName"].(string); ok {
			name = v
		} else if v, ok := n.Data["customTitle"].(string); ok {
			name = v
		}
		if needle != "" && !strings.Contains(strings.ToLower(name), needle) {
			if v, _ := n.Data["content"].(string); !strings.Contains(strings.ToLower(v), needle) {
				continue
			}
		}
		out = append(out, brief{n.ID, n.Type, name})
	}
	raw, _ := json.Marshal(out)
	return string(raw), nil
}

type createGroupTool struct{ state *CanvasState }

func (t *createGroupTool) Name() string        { return "create_group" }
func (t *createGroupTool) Description() string { return "Group a set of nodes under a named container." }
func (t *createGroupTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_ids":{"type":"array","items":{"type":"string"}},"name":{"type":"string"}},"required":["node_ids"]}`)
}
func (t *createGroupTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeIDs []string `json:"node_ids"`
		Name    string   `json:"name"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if len(p.NodeIDs) < 2 {
		return "", fmt.Errorf("create_group needs at least 2 nodes")
	}
	t.state.emit(EventCanvasPatch, map[string]any{
		"op": "create_group", "node_ids": p.NodeIDs, "name": p.Name,
	})
	return `{"ok":true}`, nil
}

// BuildCanvasTools returns the canonical list of canvas-CLI tools.
func BuildCanvasTools(state *CanvasState) []Tool {
	return []Tool{
		&listNodesTool{state},
		&findNodesTool{state},
		&readNodeTool{state},
		&createNodeTool{state},
		&connectNodesTool{state},
		&setPromptTool{state},
		&runNodeTool{state},
		&moveNodeTool{state},
		&deleteNodeTool{state},
		&createGroupTool{state},
	}
}

// ToOpenAIDefs converts our Tool list into the wire shape Chat() expects.
func ToOpenAIDefs(tools []Tool) []ToolDef {
	out := make([]ToolDef, 0, len(tools))
	for _, t := range tools {
		out = append(out, ToolDef{
			Type: "function",
			Function: ToolDefFn{
				Name:        t.Name(),
				Description: strings.TrimSpace(t.Description()),
				Parameters:  t.Parameters(),
			},
		})
	}
	return out
}

func findTool(tools []Tool, name string) Tool {
	for _, t := range tools {
		if t.Name() == name {
			return t
		}
	}
	return nil
}
