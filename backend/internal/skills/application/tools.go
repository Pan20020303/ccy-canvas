package application

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
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
	mu    sync.RWMutex
	Nodes []CanvasNode `json:"nodes"`
	Edges []CanvasEdge `json:"edges"`
	// emit lets tools push events back to the SSE stream.
	emit func(string, any)
	// idCounter for deterministic node IDs when the agent doesn't supply one.
	idCounter int

	// Secondary indexes keep tool operations proportional to the affected
	// subgraph instead of forcing a full canvas scan for every lookup/mutation.
	nodeIndex   map[string]int
	edgeIndex   map[string]int
	edgePairs   map[string]map[string]struct{}
	incoming    map[string]map[string]struct{}
	outgoing    map[string]map[string]struct{}
	nodesByType map[string]map[string]struct{}
	spatial     map[spatialCell]map[string]struct{}

	// revision is scoped to one agent run. Every successful canvas mutation
	// advances it exactly once. changes is a bounded operation log used by
	// get_canvas_delta so the model can refresh its view without re-reading the
	// full graph after every tool call.
	revision uint64
	changes  []CanvasChange
}

const maxCanvasChanges = 256

// CanvasChange is deliberately compact: it tells the agent what became stale
// and lets read_nodes/get_subgraph fetch only the affected details.
type CanvasChange struct {
	Revision uint64   `json:"revision"`
	Op       string   `json:"op"`
	NodeIDs  []string `json:"node_ids,omitempty"`
	EdgeIDs  []string `json:"edge_ids,omitempty"`
}

type CanvasRevisionConflictError struct {
	Expected uint64
	Current  uint64
}

func (e *CanvasRevisionConflictError) Error() string {
	return fmt.Sprintf("canvas revision conflict: expected %d, current %d; call get_canvas_delta and retry", e.Expected, e.Current)
}

type spatialCell struct {
	X int
	Y int
}

type CanvasNode struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Position XY     `json:"position"`
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

// CanvasGroup 是前端分组(Group)的镜像:成员节点 id + 可选的外壳几何。
type CanvasGroup struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	NodeIDs  []string `json:"nodeIds"`
	Position *XY      `json:"position,omitempty"`
	Width    float64  `json:"width,omitempty"`
	Height   float64  `json:"height,omitempty"`
}

func NewCanvasState(nodes []CanvasNode, edges []CanvasEdge, emit func(string, any)) *CanvasState {
	return NewCanvasStateAtRevision(nodes, edges, 0, emit)
}

// NewCanvasStateAtRevision allows callers with a persisted canvas revision to
// preserve it as the base for this run. NewCanvasState remains the compatible
// zero-based constructor used by existing callers and tests.
func NewCanvasStateAtRevision(nodes []CanvasNode, edges []CanvasEdge, revision uint64, emit func(string, any)) *CanvasState {
	if emit == nil {
		emit = func(string, any) {}
	}
	s := &CanvasState{
		Nodes:       append([]CanvasNode(nil), nodes...),
		Edges:       append([]CanvasEdge(nil), edges...),
		emit:        emit,
		nodeIndex:   make(map[string]int, len(nodes)),
		edgeIndex:   make(map[string]int, len(edges)),
		edgePairs:   make(map[string]map[string]struct{}, len(edges)),
		incoming:    make(map[string]map[string]struct{}, len(nodes)),
		outgoing:    make(map[string]map[string]struct{}, len(nodes)),
		nodesByType: make(map[string]map[string]struct{}),
		spatial:     make(map[spatialCell]map[string]struct{}),
		revision:    revision,
		changes:     make([]CanvasChange, 0, 16),
	}
	s.rebuildIndexes()
	return s
}

// 节点卡片的粗略占位(宽 × 高):画布节点多为 300px 宽卡片,高度按中等内容估。
const (
	nodeSlotW = 340.0
	nodeSlotH = 280.0
)

// placeClear 从期望位置开始找不与现有节点重叠的落点:先垂直向下扫,扫不出
// 再右移一列重扫。模型给坐标时普遍"盲放"(反复用同一个默认值),不避让的
// 话所有新节点都会叠死在一起。
func (s *CanvasState) placeClear(want XY) XY {
	pos := want
	for col := 0; col < 8; col++ {
		for row := 0; row < 24; row++ {
			if !s.overlapsLocked(pos, "") {
				return pos
			}
			pos.Y += nodeSlotH
		}
		pos = XY{X: want.X + float64(col+1)*nodeSlotW, Y: want.Y}
	}
	return want
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func edgePairKey(source, target string) string { return source + "\x00" + target }

func cellFor(position XY) spatialCell {
	return spatialCell{
		X: int(math.Floor(position.X / nodeSlotW)),
		Y: int(math.Floor(position.Y / nodeSlotH)),
	}
}

func addSetValue(index map[string]map[string]struct{}, key, value string) {
	values := index[key]
	if values == nil {
		values = make(map[string]struct{})
		index[key] = values
	}
	values[value] = struct{}{}
}

func removeSetValue(index map[string]map[string]struct{}, key, value string) {
	values := index[key]
	if values == nil {
		return
	}
	delete(values, value)
	if len(values) == 0 {
		delete(index, key)
	}
}

func (s *CanvasState) addSpatialLocked(node CanvasNode) {
	cell := cellFor(node.Position)
	values := s.spatial[cell]
	if values == nil {
		values = make(map[string]struct{})
		s.spatial[cell] = values
	}
	values[node.ID] = struct{}{}
}

func (s *CanvasState) removeSpatialLocked(node CanvasNode) {
	cell := cellFor(node.Position)
	values := s.spatial[cell]
	delete(values, node.ID)
	if len(values) == 0 {
		delete(s.spatial, cell)
	}
}

func (s *CanvasState) rebuildIndexes() {
	for i, node := range s.Nodes {
		if node.ID == "" {
			continue
		}
		s.nodeIndex[node.ID] = i
		addSetValue(s.nodesByType, node.Type, node.ID)
		s.addSpatialLocked(node)
	}
	for i, edge := range s.Edges {
		if edge.ID == "" {
			continue
		}
		s.edgeIndex[edge.ID] = i
		addSetValue(s.edgePairs, edgePairKey(edge.Source, edge.Target), edge.ID)
		addSetValue(s.outgoing, edge.Source, edge.ID)
		addSetValue(s.incoming, edge.Target, edge.ID)
	}
}

func (s *CanvasState) nodeLocked(id string) (*CanvasNode, bool) {
	i, ok := s.nodeIndex[id]
	if !ok || i < 0 || i >= len(s.Nodes) {
		return nil, false
	}
	return &s.Nodes[i], true
}

func (s *CanvasState) edgeLocked(id string) (*CanvasEdge, bool) {
	i, ok := s.edgeIndex[id]
	if !ok || i < 0 || i >= len(s.Edges) {
		return nil, false
	}
	return &s.Edges[i], true
}

func (s *CanvasState) addNodeLocked(node CanvasNode) {
	s.nodeIndex[node.ID] = len(s.Nodes)
	s.Nodes = append(s.Nodes, node)
	addSetValue(s.nodesByType, node.Type, node.ID)
	s.addSpatialLocked(node)
}

func (s *CanvasState) addEdgeLocked(edge CanvasEdge) {
	s.edgeIndex[edge.ID] = len(s.Edges)
	s.Edges = append(s.Edges, edge)
	addSetValue(s.edgePairs, edgePairKey(edge.Source, edge.Target), edge.ID)
	addSetValue(s.outgoing, edge.Source, edge.ID)
	addSetValue(s.incoming, edge.Target, edge.ID)
}

func (s *CanvasState) removeEdgeLocked(id string) bool {
	i, ok := s.edgeIndex[id]
	if !ok || i < 0 || i >= len(s.Edges) {
		return false
	}
	edge := s.Edges[i]
	delete(s.edgeIndex, id)
	removeSetValue(s.edgePairs, edgePairKey(edge.Source, edge.Target), id)
	removeSetValue(s.outgoing, edge.Source, id)
	removeSetValue(s.incoming, edge.Target, id)
	last := len(s.Edges) - 1
	if i != last {
		s.Edges[i] = s.Edges[last]
		s.edgeIndex[s.Edges[i].ID] = i
	}
	s.Edges = s.Edges[:last]
	return true
}

func (s *CanvasState) removeNodeLocked(id string) bool {
	i, ok := s.nodeIndex[id]
	if !ok || i < 0 || i >= len(s.Nodes) {
		return false
	}
	incident := make(map[string]struct{})
	for edgeID := range s.incoming[id] {
		incident[edgeID] = struct{}{}
	}
	for edgeID := range s.outgoing[id] {
		incident[edgeID] = struct{}{}
	}
	for edgeID := range incident {
		s.removeEdgeLocked(edgeID)
	}
	node := s.Nodes[i]
	delete(s.nodeIndex, id)
	removeSetValue(s.nodesByType, node.Type, id)
	s.removeSpatialLocked(node)
	delete(s.incoming, id)
	delete(s.outgoing, id)
	last := len(s.Nodes) - 1
	if i != last {
		s.Nodes[i] = s.Nodes[last]
		s.nodeIndex[s.Nodes[i].ID] = i
	}
	s.Nodes = s.Nodes[:last]
	return true
}

func (s *CanvasState) moveNodeLocked(id string, position XY) bool {
	node, ok := s.nodeLocked(id)
	if !ok {
		return false
	}
	s.removeSpatialLocked(*node)
	node.Position = position
	s.addSpatialLocked(*node)
	return true
}

func (s *CanvasState) overlapsLocked(position XY, ignoreID string) bool {
	center := cellFor(position)
	for dx := -1; dx <= 1; dx++ {
		for dy := -1; dy <= 1; dy++ {
			for id := range s.spatial[spatialCell{X: center.X + dx, Y: center.Y + dy}] {
				if id == ignoreID {
					continue
				}
				node, ok := s.nodeLocked(id)
				if ok && abs(node.Position.X-position.X) < nodeSlotW && abs(node.Position.Y-position.Y) < nodeSlotH {
					return true
				}
			}
		}
	}
	return false
}

// nextID generates a unique node/edge id that won't collide with the existing
// snapshot. Format is human-readable so logs are easy to follow.
func (s *CanvasState) nextID(prefix string) string {
	s.idCounter++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixMilli(), s.idCounter)
}

func (s *CanvasState) checkExpectedRevisionLocked(expected *uint64) error {
	if expected == nil || *expected == s.revision {
		return nil
	}
	return &CanvasRevisionConflictError{Expected: *expected, Current: s.revision}
}

func (s *CanvasState) recordChangeLocked(op string, nodeIDs, edgeIDs []string) (baseRevision, revision uint64) {
	baseRevision = s.revision
	s.revision++
	change := CanvasChange{
		Revision: s.revision,
		Op:       op,
		NodeIDs:  append([]string(nil), nodeIDs...),
		EdgeIDs:  append([]string(nil), edgeIDs...),
	}
	s.changes = append(s.changes, change)
	if overflow := len(s.changes) - maxCanvasChanges; overflow > 0 {
		copy(s.changes, s.changes[overflow:])
		s.changes = s.changes[:maxCanvasChanges]
	}
	return baseRevision, s.revision
}

func canvasPatchWithRevision(patch map[string]any, baseRevision, revision uint64) map[string]any {
	patch["base_revision"] = baseRevision
	patch["revision"] = revision
	return patch
}

func canvasMutationResult(revision uint64, extra map[string]any) string {
	result := map[string]any{"ok": true, "revision": revision}
	for key, value := range extra {
		result[key] = value
	}
	raw, _ := json.Marshal(result)
	return string(raw)
}

// ─── Canvas tools ────────────────────────────────────────────────────────────

type listNodesTool struct{ state *CanvasState }

func (t *listNodesTool) Name() string { return "list_nodes" }
func (t *listNodesTool) Description() string {
	return "List all nodes currently on the canvas with id, type, and brief data summary."
}
func (t *listNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
}
func (t *listNodesTool) Execute(_ context.Context, _ json.RawMessage) (string, error) {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
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

// BuildCanvasOverview renders a compact, complete snapshot of the canvas to
// inject into the agent's system prompt. Giving the model the full node list
// up-front stops it from "exploring" the canvas by calling read_node on every
// node one-by-one (which floods the run with dozens of tool calls).
func BuildCanvasOverview(nodes []CanvasNode, edges []CanvasEdge, groups ...[]CanvasGroup) string {
	if len(nodes) == 0 {
		return "【画布快照】当前画布为空（没有任何节点）。创建节点时从 (100, 100) 开始排布,同排节点 x 间距 340、换行 y 间距 280。"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "【画布快照】共 %d 个节点、%d 条连线。以下是完整节点清单（id · 类型 · 位置 · 名称 · 产物 · 内容摘要）：\n", len(nodes), len(edges))
	for _, n := range nodes {
		name := ""
		if v, ok := n.Data["sourceName"].(string); ok && v != "" {
			name = v
		} else if v, ok := n.Data["customTitle"].(string); ok && v != "" {
			name = v
		}
		hasURL := false
		if v, ok := n.Data["url"].(string); ok && v != "" {
			hasURL = true
		}
		content := ""
		if v, ok := n.Data["content"].(string); ok && v != "" {
			if r := []rune(v); len(r) > 60 {
				content = string(r[:60]) + "…"
			} else {
				content = v
			}
		}
		b.WriteString("- " + n.ID + " · " + n.Type)
		fmt.Fprintf(&b, " · @(%.0f, %.0f)", n.Position.X, n.Position.Y)
		if name != "" {
			b.WriteString(" · " + name)
		}
		if hasURL {
			b.WriteString(" · [有产物]")
		}
		if content != "" {
			b.WriteString(" · " + content)
		}
		b.WriteString("\n")
	}
	// 分组段落:名字 + 包围盒,支撑"放在分组X上面/旁边"这类空间指令。
	if len(groups) > 0 && len(groups[0]) > 0 {
		byID := make(map[string]CanvasNode, len(nodes))
		for _, n := range nodes {
			byID[n.ID] = n
		}
		b.WriteString("【分组】\n")
		for _, g := range groups[0] {
			minX, minY, maxX, maxY, count := groupBounds(g, byID)
			if count == 0 {
				continue
			}
			fmt.Fprintf(&b, "- %s(id %s):%d 个成员,包围盒 x∈[%.0f, %.0f] y∈[%.0f, %.0f]\n",
				g.Name, g.ID, count, minX, maxX, minY, maxY)
		}
	}
	b.WriteString("【空间规则】创建节点必须给出经过推算的坐标：参考上面各节点/分组的真实位置，把新节点放到目标附近的空白处（节点间距至少 340×280）。" +
		"「放在某分组上面」= x 取该分组包围盒的 x 范围内、y = 包围盒 y 下界 - 300；「右侧」= x = 包围盒 x 上界 + 360。" +
		"连续创建多个节点时按每行间隔 340、每列间隔 280 排开，不要反复使用同一个坐标；若坐标与已有节点重叠，系统会自动向下避让并在结果里返回实际落点。\n" +
		"说明：以上已是完整画布快照，你已经掌握画布上的全部节点，**不要逐个调用 read_node 去遍历所有节点**。仅当确实需要某个具体节点的完整 prompt / url 等细节时，才对那一个节点调用 read_node；需要按类型或关键词筛选时用 find_nodes。")
	return b.String()
}

// groupBounds 计算分组包围盒:有外壳几何用外壳,否则按成员节点位置聚合。
func groupBounds(g CanvasGroup, byID map[string]CanvasNode) (minX, minY, maxX, maxY float64, count int) {
	if g.Position != nil && g.Width > 0 && g.Height > 0 {
		return g.Position.X, g.Position.Y, g.Position.X + g.Width, g.Position.Y + g.Height, len(g.NodeIDs)
	}
	first := true
	for _, id := range g.NodeIDs {
		n, ok := byID[id]
		if !ok {
			continue
		}
		count++
		if first {
			minX, minY, maxX, maxY = n.Position.X, n.Position.Y, n.Position.X+nodeSlotW, n.Position.Y+nodeSlotH
			first = false
			continue
		}
		minX = min(minX, n.Position.X)
		minY = min(minY, n.Position.Y)
		maxX = max(maxX, n.Position.X+nodeSlotW)
		maxY = max(maxY, n.Position.Y+nodeSlotH)
	}
	return
}

// askUserTool lets the agent pause and ask the user a clarifying question with
// concrete options (a "选择题") instead of guessing. It emits an `ask_user`
// SSE event the frontend renders as clickable choices; the user's pick becomes
// the next turn.
type askUserTool struct{ emit func(string, any) }

func (t *askUserTool) Name() string { return "ask_user" }
func (t *askUserTool) Description() string {
	return "Ask the user a clarifying multiple-choice question before proceeding. Use when the request is ambiguous or has several reasonable interpretations/paths. Provide 2-4 concrete options. After calling this, END your turn and wait for the user's choice — do NOT keep acting."
}
func (t *askUserTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"question":{"type":"string","description":"the clarifying question to show the user"},"options":{"type":"array","items":{"type":"string"},"description":"2-4 concrete, mutually-distinct choices"},"allow_custom":{"type":"boolean","description":"whether the user may also type a custom answer (default true)"}},"required":["question","options"],"additionalProperties":false}`)
}
func (t *askUserTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		Question    string   `json:"question"`
		Options     []string `json:"options"`
		AllowCustom *bool    `json:"allow_custom"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", fmt.Errorf("invalid ask_user payload: %w", err)
	}
	p.Question = strings.TrimSpace(p.Question)
	if p.Question == "" {
		return "", fmt.Errorf("ask_user question is required")
	}
	normalizedOptions := make([]string, 0, len(p.Options))
	seenOptions := make(map[string]struct{}, len(p.Options))
	for _, option := range p.Options {
		option = strings.TrimSpace(option)
		if option == "" {
			continue
		}
		if _, exists := seenOptions[option]; exists {
			continue
		}
		seenOptions[option] = struct{}{}
		normalizedOptions = append(normalizedOptions, option)
		if len(normalizedOptions) == 4 {
			break
		}
	}
	if len(normalizedOptions) < 2 {
		return "", fmt.Errorf("ask_user requires at least two distinct options")
	}
	p.Options = normalizedOptions
	allowCustom := p.AllowCustom == nil || *p.AllowCustom
	if t.emit != nil {
		t.emit("ask_user", map[string]any{
			"question":     p.Question,
			"options":      p.Options,
			"allow_custom": allowCustom,
		})
	}
	return "已向用户展示选择题并等待其选择。请立即结束本轮，不要再调用任何工具或继续执行，直到用户在下一轮给出选择。", nil
}

// BuildAskUserTool wires the ask_user tool to the SSE emitter.
func BuildAskUserTool(emit func(string, any)) Tool { return &askUserTool{emit: emit} }

// AgentInteractionGuide is appended to every agent's system prompt. It makes the
// agent (1) analyse intent first, (2) answer/execute directly when the request
// is clear, and (3) offer a multiple-choice question (ask_user) when ambiguous,
// instead of guessing — and not遍历 the canvas via read_node.
const AgentInteractionGuide = `【交互准则】
1. 先用一句话简要分析用户意图（要做什么、涉及画布哪些节点）。
2. 如果意图明确，直接正常回答或执行，不要画蛇添足地反问。
3. 如果请求存在多种合理理解或多条可行路径（例如"优化一下""做个视频"这类宽泛需求），不要擅自假设：调用 ask_user 工具，给出 2-4 个具体、互斥的选项（options），allow_custom 设为 true 允许用户补充其他意见；调用后立即结束本轮，等待用户选择。
4. 已经为你提供了完整的画布快照，不要为了"了解画布"而逐个调用 read_node 遍历所有节点；需要多个节点细节时用 read_nodes，需要分析连线关系时用 get_subgraph，只有需要单个节点完整细节时才用 read_node。
5. 多步画布操作期间，用 get_canvas_delta(since_revision) 获取增量变化；移动、删除、连线、分组等写操作优先携带最近返回的 expected_revision。发生 revision conflict 时先读取增量再重试。`

const AgentBatchGenerationGuide = `【批量生成可靠性规则】创建 2 个及以上生成节点时，先把用户需求分析为完整清单，再调用 create_generation_batch；不要逐个调用 create_node、set_prompt、run_node。用户给了多条提示词时必须逐条保留，items 数量必须与要求一致，不得静默省略。每个 item 必须有非空、可以独立生成的完整 prompt。同批模型写在 model，只有确实要混用模型时才使用 item.model。单次最多 50 个；超过 50 个才按每批最多 50 个拆分。工具返回后核对 created 是否等于计划数量再汇报。`

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
          "data":{"type":"object","additionalProperties":true},
          "expected_revision":{"type":"integer","minimum":0,"description":"Optional optimistic-lock revision from get_canvas_delta or a previous mutation result"}
        },
        "required":["type","position"]
    }`)
}
func (t *createNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		Type     string         `json:"type"`
		Position XY             `json:"position"`
		Data     map[string]any `json:"data"`
		Expected *uint64        `json:"expected_revision"`
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
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	// 自动避让:模型给的坐标与现有节点重叠时,就近挪到空位。
	placed := t.state.placeClear(p.Position)
	node := CanvasNode{ID: t.state.nextID("ag"), Type: p.Type, Position: placed, Data: p.Data}
	t.state.addNodeLocked(node)
	baseRevision, revision := t.state.recordChangeLocked("add_node", []string{node.ID}, nil)
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{"op": "add_node", "node": node}, baseRevision, revision))
	// 把实际落点回给模型:连续创建多个节点时它才能基于真实位置继续排布。
	return canvasMutationResult(revision, map[string]any{"id": node.ID, "position": placed}), nil
}

type createGenerationBatchTool struct{ state *CanvasState }

type generationBatchItem struct {
	Prompt   string `json:"prompt"`
	Title    string `json:"title"`
	Model    string `json:"model"`
	Position *XY    `json:"position"`
}

type generationBatchMutation struct {
	Node         CanvasNode
	Prompt       string
	Model        string
	BaseRevision uint64
	Revision     uint64
}

func (t *createGenerationBatchTool) Name() string { return "create_generation_batch" }
func (t *createGenerationBatchTool) Description() string {
	return "Atomically create and submit 1-50 generation nodes. Use this for every multi-output image/video/audio/text request instead of repeated create_node, set_prompt, and run_node calls. Each item must contain its complete non-empty prompt; model applies to the whole batch unless an item overrides it."
}
func (t *createGenerationBatchTool) Parameters() json.RawMessage {
	return json.RawMessage(`{
        "type":"object",
        "properties":{
          "node_type":{"type":"string","enum":["imageNode","videoNode","audioNode","textNode"]},
          "model":{"type":"string","description":"Exact generation model name shared by the batch"},
          "start_position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]},
          "columns":{"type":"integer","minimum":1,"maximum":10,"default":5},
          "items":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"object","properties":{"prompt":{"type":"string","minLength":1},"title":{"type":"string"},"model":{"type":"string","description":"Optional per-item model override"},"position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]}},"required":["prompt"],"additionalProperties":false}},
          "expected_revision":{"type":"integer","minimum":0}
        },
        "required":["node_type","items"],
        "additionalProperties":false
    }`)
}

func generationNodeTitle(nodeType string, index int) string {
	label := map[string]string{
		"imageNode": "生成图像",
		"videoNode": "生成视频",
		"audioNode": "生成音频",
		"textNode":  "生成文本",
	}[nodeType]
	return fmt.Sprintf("%s %d", label, index+1)
}

func (t *createGenerationBatchTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeType         string                `json:"node_type"`
		Model            string                `json:"model"`
		StartPosition    *XY                   `json:"start_position"`
		Columns          int                   `json:"columns"`
		Items            []generationBatchItem `json:"items"`
		ExpectedRevision *uint64               `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if p.NodeType != "imageNode" && p.NodeType != "videoNode" && p.NodeType != "audioNode" && p.NodeType != "textNode" {
		return "", fmt.Errorf("unsupported generation node type: %s", p.NodeType)
	}
	if len(p.Items) == 0 || len(p.Items) > 50 {
		return "", fmt.Errorf("create_generation_batch requires 1-50 items")
	}
	for index := range p.Items {
		p.Items[index].Prompt = strings.TrimSpace(p.Items[index].Prompt)
		p.Items[index].Title = strings.TrimSpace(p.Items[index].Title)
		p.Items[index].Model = strings.TrimSpace(p.Items[index].Model)
		if p.Items[index].Prompt == "" {
			return "", fmt.Errorf("item %d has an empty prompt; no nodes were created", index+1)
		}
	}
	p.Model = strings.TrimSpace(p.Model)
	if p.Columns == 0 {
		p.Columns = 5
	}
	if p.Columns < 1 || p.Columns > 10 {
		return "", fmt.Errorf("columns must be between 1 and 10")
	}
	start := XY{X: 100, Y: 100}
	if p.StartPosition != nil {
		start = *p.StartPosition
	}

	mutations := make([]generationBatchMutation, 0, len(p.Items))
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.ExpectedRevision); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	for index, item := range p.Items {
		model := item.Model
		if model == "" {
			model = p.Model
		}
		position := XY{
			X: start.X + float64(index%p.Columns)*nodeSlotW,
			Y: start.Y + float64(index/p.Columns)*nodeSlotH,
		}
		if item.Position != nil {
			position = *item.Position
		}
		position = t.state.placeClear(position)
		title := item.Title
		if title == "" {
			title = generationNodeTitle(p.NodeType, index)
		}
		data := map[string]any{"customTitle": title, "promptDraft": item.Prompt}
		if model != "" {
			data["model"] = model
		}
		node := CanvasNode{ID: t.state.nextID("ag"), Type: p.NodeType, Position: position, Data: data}
		t.state.addNodeLocked(node)
		baseRevision, revision := t.state.recordChangeLocked("add_node", []string{node.ID}, nil)
		mutations = append(mutations, generationBatchMutation{
			Node: node, Prompt: item.Prompt, Model: model,
			BaseRevision: baseRevision, Revision: revision,
		})
	}
	finalRevision := t.state.revision
	t.state.mu.Unlock()

	nodeIDs := make([]string, 0, len(mutations))
	for _, mutation := range mutations {
		nodeIDs = append(nodeIDs, mutation.Node.ID)
		t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{
			"op": "add_node", "node": mutation.Node,
		}, mutation.BaseRevision, mutation.Revision))
		runPatch := map[string]any{
			"op": "run_node", "node_id": mutation.Node.ID, "prompt": mutation.Prompt,
		}
		if mutation.Model != "" {
			runPatch["model"] = mutation.Model
		}
		t.state.emit(EventCanvasPatch, runPatch)
	}
	raw, _ := json.Marshal(map[string]any{
		"created": len(mutations), "node_ids": nodeIDs, "revision": finalRevision,
	})
	return string(raw), nil
}

type connectNodesTool struct{ state *CanvasState }

func (t *connectNodesTool) Name() string { return "connect_nodes" }
func (t *connectNodesTool) Description() string {
	return "Create an edge from source node to target node."
}
func (t *connectNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"source":{"type":"string"},"target":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}},"required":["source","target"]}`)
}
func (t *connectNodesTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		Source   string  `json:"source"`
		Target   string  `json:"target"`
		Expected *uint64 `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	if _, ok := t.state.nodeLocked(p.Source); !ok {
		t.state.mu.Unlock()
		return "", fmt.Errorf("source node not found: %s", p.Source)
	}
	if _, ok := t.state.nodeLocked(p.Target); !ok {
		t.state.mu.Unlock()
		return "", fmt.Errorf("target node not found: %s", p.Target)
	}
	if len(t.state.edgePairs[edgePairKey(p.Source, p.Target)]) > 0 {
		revision := t.state.revision
		t.state.mu.Unlock()
		return canvasMutationResult(revision, map[string]any{"existing": true}), nil
	}
	edge := CanvasEdge{ID: t.state.nextID("ae"), Source: p.Source, Target: p.Target}
	t.state.addEdgeLocked(edge)
	baseRevision, revision := t.state.recordChangeLocked("add_edge", []string{p.Source, p.Target}, []string{edge.ID})
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{"op": "add_edge", "edge": edge}, baseRevision, revision))
	return canvasMutationResult(revision, map[string]any{"edge_id": edge.ID}), nil
}

type setPromptTool struct{ state *CanvasState }

func (t *setPromptTool) Name() string { return "set_prompt" }
func (t *setPromptTool) Description() string {
	return "Set the prompt (description) used when the node generates."
}
func (t *setPromptTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"prompt":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}},"required":["node_id","prompt"]}`)
}
func (t *setPromptTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID   string  `json:"node_id"`
		Prompt   string  `json:"prompt"`
		Expected *uint64 `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	node, found := t.state.nodeLocked(p.NodeID)
	if found {
		if node.Data == nil {
			node.Data = map[string]any{}
		}
		node.Data["promptDraft"] = p.Prompt
	}
	var baseRevision, revision uint64
	if found {
		baseRevision, revision = t.state.recordChangeLocked("patch_node_data", []string{p.NodeID}, nil)
	}
	t.state.mu.Unlock()
	if !found {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{
		"op":      "patch_node_data",
		"node_id": p.NodeID,
		"patch":   map[string]string{"promptDraft": p.Prompt},
	}, baseRevision, revision))
	return canvasMutationResult(revision, nil), nil
}

type runNodeTool struct{ state *CanvasState }

func (t *runNodeTool) Name() string { return "run_node" }
func (t *runNodeTool) Description() string {
	return "Trigger generation on the target node (image/video/text/audio). Optionally pass `model` to pick a specific generation model (see 可用生成模型 in the system prompt). The browser performs the actual API call; this just signals it to start."
}
func (t *runNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"model":{"type":"string","description":"生成模型名(可选;省略则用节点已选/默认模型)"}},"required":["node_id"]}`)
}
func (t *runNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID string `json:"node_id"`
		Model  string `json:"model"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.RLock()
	node, found := t.state.nodeLocked(p.NodeID)
	prompt := ""
	if found {
		prompt, _ = node.Data["promptDraft"].(string)
		if strings.TrimSpace(prompt) == "" {
			prompt, _ = node.Data["content"].(string)
		}
	}
	t.state.mu.RUnlock()
	if !found {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	if strings.TrimSpace(prompt) == "" {
		return "", fmt.Errorf("node %s has no prompt; call set_prompt before run_node", p.NodeID)
	}
	patch := map[string]any{"op": "run_node", "node_id": p.NodeID, "prompt": prompt}
	if strings.TrimSpace(p.Model) != "" {
		patch["model"] = strings.TrimSpace(p.Model)
	}
	t.state.emit(EventCanvasPatch, patch)
	return `{"ok":true,"note":"Submitted to browser for generation"}`, nil
}

// ─── Additional canvas tools ─────────────────────────────────────────────────

type deleteNodeTool struct{ state *CanvasState }

func (t *deleteNodeTool) Name() string        { return "delete_node" }
func (t *deleteNodeTool) Description() string { return "Remove a node and all edges connected to it." }
func (t *deleteNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}},"required":["node_id"]}`)
}
func (t *deleteNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID   string  `json:"node_id"`
		Expected *uint64 `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	incident := make(map[string]struct{})
	for edgeID := range t.state.incoming[p.NodeID] {
		incident[edgeID] = struct{}{}
	}
	for edgeID := range t.state.outgoing[p.NodeID] {
		incident[edgeID] = struct{}{}
	}
	removed := t.state.removeNodeLocked(p.NodeID)
	var baseRevision, revision uint64
	if removed {
		baseRevision, revision = t.state.recordChangeLocked("delete_node", []string{p.NodeID}, sortedSetKeys(incident))
	}
	t.state.mu.Unlock()
	if !removed {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{"op": "delete_node", "node_id": p.NodeID}, baseRevision, revision))
	return canvasMutationResult(revision, nil), nil
}

type moveNodeTool struct{ state *CanvasState }

func (t *moveNodeTool) Name() string        { return "move_node" }
func (t *moveNodeTool) Description() string { return "Move a node to a new position on the canvas." }
func (t *moveNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"},"position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]},"expected_revision":{"type":"integer","minimum":0}},"required":["node_id","position"]}`)
}
func (t *moveNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID   string  `json:"node_id"`
		Position XY      `json:"position"`
		Expected *uint64 `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	found := t.state.moveNodeLocked(p.NodeID, p.Position)
	var baseRevision, revision uint64
	if found {
		baseRevision, revision = t.state.recordChangeLocked("move_node", []string{p.NodeID}, nil)
	}
	t.state.mu.Unlock()
	if !found {
		return "", fmt.Errorf("node not found: %s", p.NodeID)
	}
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{"op": "move_node", "node_id": p.NodeID, "position": p.Position}, baseRevision, revision))
	return canvasMutationResult(revision, nil), nil
}

type readNodeTool struct{ state *CanvasState }

func (t *readNodeTool) Name() string { return "read_node" }
func (t *readNodeTool) Description() string {
	return "Read the full data of a node: type, position, url, content, prompt, etc."
}
func (t *readNodeTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string"}},"required":["node_id"]}`)
}
func (t *readNodeTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID string `json:"node_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	node, ok := t.state.nodeLocked(p.NodeID)
	if ok {
		out, _ := json.Marshal(node)
		return string(out), nil
	}
	return "", fmt.Errorf("node not found: %s", p.NodeID)
}

type findNodesTool struct{ state *CanvasState }

func (t *findNodesTool) Name() string { return "find_nodes" }
func (t *findNodesTool) Description() string {
	return "Find nodes matching a type and/or a substring in their name/content."
}
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
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	type brief struct {
		ID, Type, Name string
	}
	out := []brief{}
	candidateIDs := make([]string, 0, len(t.state.Nodes))
	if p.Type != "" {
		for id := range t.state.nodesByType[p.Type] {
			candidateIDs = append(candidateIDs, id)
		}
	} else {
		for id := range t.state.nodeIndex {
			candidateIDs = append(candidateIDs, id)
		}
	}
	sort.Strings(candidateIDs)
	for _, id := range candidateIDs {
		node, ok := t.state.nodeLocked(id)
		if !ok {
			continue
		}
		n := *node
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

type readNodesTool struct{ state *CanvasState }

func (t *readNodesTool) Name() string { return "read_nodes" }
func (t *readNodesTool) Description() string {
	return "Read up to 50 canvas nodes in one call. Optionally request only specific fields to reduce context size."
}
func (t *readNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":50},"fields":{"type":"array","items":{"type":"string"},"description":"Optional fields: type, position, data, or keys inside node.data such as content, promptDraft, url"}},"required":["node_ids"],"additionalProperties":false}`)
}
func (t *readNodesTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeIDs []string `json:"node_ids"`
		Fields  []string `json:"fields"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if len(p.NodeIDs) == 0 || len(p.NodeIDs) > 50 {
		return "", fmt.Errorf("read_nodes requires 1-50 node_ids")
	}

	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	nodes := make([]any, 0, len(p.NodeIDs))
	missing := make([]string, 0)
	seen := make(map[string]struct{}, len(p.NodeIDs))
	for _, id := range p.NodeIDs {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		node, ok := t.state.nodeLocked(id)
		if !ok {
			missing = append(missing, id)
			continue
		}
		if len(p.Fields) == 0 {
			nodes = append(nodes, *node)
			continue
		}
		item := map[string]any{"id": node.ID}
		data := make(map[string]any)
		for _, field := range p.Fields {
			switch field {
			case "id":
			case "type":
				item["type"] = node.Type
			case "position":
				item["position"] = node.Position
			case "data":
				item["data"] = node.Data
			default:
				if value, exists := node.Data[field]; exists {
					data[field] = value
				}
			}
		}
		if len(data) > 0 {
			item["data"] = data
		}
		nodes = append(nodes, item)
	}
	raw, _ := json.Marshal(map[string]any{"revision": t.state.revision, "nodes": nodes, "missing": missing})
	return string(raw), nil
}

type getSubgraphTool struct{ state *CanvasState }

func (t *getSubgraphTool) Name() string { return "get_subgraph" }
func (t *getSubgraphTool) Description() string {
	return "Read the compact upstream/downstream neighborhood around selected nodes. Prefer this over repeatedly calling read_node when reasoning about connected canvas content."
}
func (t *getSubgraphTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":50},"direction":{"type":"string","enum":["upstream","downstream","both"],"default":"both"},"depth":{"type":"integer","minimum":0,"maximum":4,"default":1}},"required":["node_ids"],"additionalProperties":false}`)
}

type subgraphNode struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Position XY     `json:"position"`
	Name     string `json:"name,omitempty"`
	Content  string `json:"content,omitempty"`
	HasURL   bool   `json:"has_url,omitempty"`
}

func compactSubgraphNode(node CanvasNode) subgraphNode {
	out := subgraphNode{ID: node.ID, Type: node.Type, Position: node.Position}
	if value, ok := node.Data["sourceName"].(string); ok && value != "" {
		out.Name = value
	} else if value, ok := node.Data["customTitle"].(string); ok {
		out.Name = value
	}
	if value, ok := node.Data["content"].(string); ok {
		runes := []rune(value)
		if len(runes) > 160 {
			value = string(runes[:160]) + "..."
		}
		out.Content = value
	}
	if value, ok := node.Data["url"].(string); ok && value != "" {
		out.HasURL = true
	}
	return out
}

func sortedSetKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (t *getSubgraphTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeIDs   []string `json:"node_ids"`
		Direction string   `json:"direction"`
		Depth     *int     `json:"depth"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if len(p.NodeIDs) == 0 || len(p.NodeIDs) > 50 {
		return "", fmt.Errorf("get_subgraph requires 1-50 node_ids")
	}
	direction := p.Direction
	if direction == "" {
		direction = "both"
	}
	if direction != "upstream" && direction != "downstream" && direction != "both" {
		return "", fmt.Errorf("invalid direction: %s", direction)
	}
	depth := 1
	if p.Depth != nil {
		depth = *p.Depth
	}
	if depth < 0 || depth > 4 {
		return "", fmt.Errorf("depth must be between 0 and 4")
	}

	const maxSubgraphNodes = 100
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	visited := make(map[string]struct{})
	missing := make([]string, 0)
	frontier := make([]string, 0, len(p.NodeIDs))
	for _, id := range p.NodeIDs {
		if _, duplicate := visited[id]; duplicate {
			continue
		}
		if _, ok := t.state.nodeLocked(id); !ok {
			missing = append(missing, id)
			continue
		}
		visited[id] = struct{}{}
		frontier = append(frontier, id)
	}
	edgeIDs := make(map[string]struct{})
	truncated := false
	for level := 0; level < depth && len(frontier) > 0; level++ {
		nextSet := make(map[string]struct{})
		for _, nodeID := range frontier {
			candidateEdgeIDs := make(map[string]struct{})
			if direction == "downstream" || direction == "both" {
				for edgeID := range t.state.outgoing[nodeID] {
					candidateEdgeIDs[edgeID] = struct{}{}
				}
			}
			if direction == "upstream" || direction == "both" {
				for edgeID := range t.state.incoming[nodeID] {
					candidateEdgeIDs[edgeID] = struct{}{}
				}
			}
			for _, edgeID := range sortedSetKeys(candidateEdgeIDs) {
				edge, ok := t.state.edgeLocked(edgeID)
				if !ok {
					continue
				}
				neighbor := edge.Target
				if neighbor == nodeID {
					neighbor = edge.Source
				}
				if _, ok := t.state.nodeLocked(neighbor); !ok {
					continue
				}
				if _, seen := visited[neighbor]; !seen {
					if len(visited) >= maxSubgraphNodes {
						truncated = true
						continue
					}
					visited[neighbor] = struct{}{}
					nextSet[neighbor] = struct{}{}
				}
				edgeIDs[edgeID] = struct{}{}
			}
		}
		frontier = sortedSetKeys(nextSet)
	}

	nodeIDs := sortedSetKeys(visited)
	nodes := make([]subgraphNode, 0, len(nodeIDs))
	for _, id := range nodeIDs {
		if node, ok := t.state.nodeLocked(id); ok {
			nodes = append(nodes, compactSubgraphNode(*node))
		}
	}
	edges := make([]CanvasEdge, 0, len(edgeIDs))
	for _, id := range sortedSetKeys(edgeIDs) {
		if edge, ok := t.state.edgeLocked(id); ok {
			edges = append(edges, *edge)
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"revision": t.state.revision,
		"nodes":    nodes, "edges": edges, "missing": missing, "truncated": truncated,
	})
	return string(raw), nil
}

type getCanvasDeltaTool struct{ state *CanvasState }

func (t *getCanvasDeltaTool) Name() string { return "get_canvas_delta" }
func (t *getCanvasDeltaTool) Description() string {
	return "Return compact canvas changes after a revision. Use this during multi-step work instead of listing or re-reading the whole canvas."
}
func (t *getCanvasDeltaTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"since_revision":{"type":"integer","minimum":0,"default":0},"limit":{"type":"integer","minimum":1,"maximum":256,"default":100}},"additionalProperties":false}`)
}
func (t *getCanvasDeltaTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		SinceRevision uint64 `json:"since_revision"`
		Limit         int    `json:"limit"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &p); err != nil {
			return "", err
		}
	}
	if p.Limit == 0 {
		p.Limit = 100
	}
	if p.Limit < 1 || p.Limit > maxCanvasChanges {
		return "", fmt.Errorf("limit must be between 1 and %d", maxCanvasChanges)
	}

	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	if p.SinceRevision > t.state.revision {
		return "", fmt.Errorf("since_revision %d is newer than current revision %d", p.SinceRevision, t.state.revision)
	}

	earliestAvailable := t.state.revision
	if len(t.state.changes) > 0 {
		earliestAvailable = t.state.changes[0].Revision - 1
	}
	resetRequired := p.SinceRevision < earliestAvailable
	changes := make([]CanvasChange, 0, p.Limit)
	nextRevision := p.SinceRevision
	hasMore := false
	if !resetRequired {
		for _, change := range t.state.changes {
			if change.Revision <= p.SinceRevision {
				continue
			}
			if len(changes) >= p.Limit {
				hasMore = true
				break
			}
			change.NodeIDs = append([]string(nil), change.NodeIDs...)
			change.EdgeIDs = append([]string(nil), change.EdgeIDs...)
			changes = append(changes, change)
			nextRevision = change.Revision
		}
	}
	if resetRequired {
		nextRevision = t.state.revision
	}
	raw, _ := json.Marshal(map[string]any{
		"current_revision":            t.state.revision,
		"earliest_available_revision": earliestAvailable,
		"next_revision":               nextRevision,
		"changes":                     changes,
		"has_more":                    hasMore,
		"reset_required":              resetRequired,
		"reset_hint":                  "Use list_nodes or get_subgraph to rebuild context when reset_required is true.",
	})
	return string(raw), nil
}

type createGroupTool struct{ state *CanvasState }

func (t *createGroupTool) Name() string { return "create_group" }
func (t *createGroupTool) Description() string {
	return "Group a set of nodes under a named container."
}
func (t *createGroupTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_ids":{"type":"array","items":{"type":"string"}},"name":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}},"required":["node_ids"]}`)
}
func (t *createGroupTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeIDs  []string `json:"node_ids"`
		Name     string   `json:"name"`
		Expected *uint64  `json:"expected_revision"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	uniqueNodeIDs := make([]string, 0, len(p.NodeIDs))
	seen := make(map[string]struct{}, len(p.NodeIDs))
	for _, nodeID := range p.NodeIDs {
		if nodeID == "" {
			continue
		}
		if _, duplicate := seen[nodeID]; duplicate {
			continue
		}
		seen[nodeID] = struct{}{}
		uniqueNodeIDs = append(uniqueNodeIDs, nodeID)
	}
	if len(uniqueNodeIDs) < 2 {
		return "", fmt.Errorf("create_group needs at least 2 nodes")
	}
	t.state.mu.Lock()
	if err := t.state.checkExpectedRevisionLocked(p.Expected); err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	for _, nodeID := range uniqueNodeIDs {
		if _, ok := t.state.nodeLocked(nodeID); !ok {
			t.state.mu.Unlock()
			return "", fmt.Errorf("node not found: %s", nodeID)
		}
	}
	baseRevision, revision := t.state.recordChangeLocked("create_group", uniqueNodeIDs, nil)
	t.state.mu.Unlock()
	t.state.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{
		"op": "create_group", "node_ids": uniqueNodeIDs, "name": p.Name,
	}, baseRevision, revision))
	return canvasMutationResult(revision, nil), nil
}

// BuildCanvasTools returns the canonical list of canvas-CLI tools.
func BuildCanvasTools(state *CanvasState) []Tool {
	return []Tool{
		&listNodesTool{state},
		&findNodesTool{state},
		&readNodeTool{state},
		&readNodesTool{state},
		&getSubgraphTool{state},
		&getCanvasDeltaTool{state},
		&createNodeTool{state},
		&createGenerationBatchTool{state},
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
