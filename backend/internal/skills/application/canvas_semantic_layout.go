package application

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

type CanvasSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type CanvasPlacement struct {
	AnchorID string   `json:"anchor_id"`
	Relation string   `json:"relation"`
	Gap      *float64 `json:"gap,omitempty"`
}
type canvasRect struct{ X, Y, W, H float64 }

func validCanvasNumber(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) < 1e8
}
func nodeSize(n CanvasNode) CanvasSize {
	// Before the browser measures a new node, reserve its renderer's default
	// footprint (including the title/padding). Measured geometry always wins.
	fallback := CanvasSize{300, 240}
	number := func(key string, defaultValue float64) float64 {
		if v, ok := n.Data[key].(float64); ok && validCanvasNumber(v) && v > 0 {
			return v
		}
		return defaultValue
	}
	if n.Type == "textNode" {
		fallback = CanvasSize{number("boxWidth", 320), number("boxHeight", 260) + 52}
	} else if n.Type == "imageNode" || n.Type == "videoNode" || n.Type == "referenceImageNode" || n.Type == "referenceVideoNode" {
		ratio := 1.0
		if n.Type == "videoNode" || n.Type == "referenceVideoNode" {
			ratio = 16.0 / 9.0
		}
		if params, ok := n.Data["generationParams"].(map[string]any); ok {
			if aspect, ok := params["aspectRatio"].(string); ok {
				parts := strings.Split(aspect, ":")
				if len(parts) == 2 {
					w, _ := strconv.ParseFloat(parts[0], 64)
					h, _ := strconv.ParseFloat(parts[1], 64)
					if validCanvasNumber(w) && validCanvasNumber(h) && w > 0 && h > 0 {
						ratio = w / h
					}
				}
			}
		}
		if w, h := number("mediaWidth", 0), number("mediaHeight", 0); w > 0 && h > 0 {
			ratio = w / h
		}
		fallback.Height = math.Max(120, 300/ratio) + 32
	}
	w, h := n.Width, n.Height
	if n.Measured != nil {
		if n.Measured.Width > 0 {
			w = n.Measured.Width
		}
		if n.Measured.Height > 0 {
			h = n.Measured.Height
		}
	}
	if !validCanvasNumber(w) || w <= 0 {
		w = fallback.Width
	}
	if !validCanvasNumber(h) || h <= 0 {
		h = fallback.Height
	}
	return CanvasSize{math.Min(w, 10000), math.Min(h, 10000)}
}
func nodeRect(n CanvasNode) canvasRect {
	size := nodeSize(n)
	return canvasRect{n.Position.X, n.Position.Y, size.Width, size.Height}
}
func rectOverlap(a, b canvasRect, gap float64) bool {
	return a.X < b.X+b.W+gap && a.X+a.W+gap > b.X && a.Y < b.Y+b.H+gap && a.Y+a.H+gap > b.Y
}
func unionRect(a, b canvasRect) canvasRect {
	x, y := math.Min(a.X, b.X), math.Min(a.Y, b.Y)
	return canvasRect{x, y, math.Max(a.X+a.W, b.X+b.W) - x, math.Max(a.Y+a.H, b.Y+b.H) - y}
}
func (t *CanvasPlacement) spacing() (float64, error) {
	if t == nil || t.Gap == nil {
		return 40, nil
	}
	if !validCanvasNumber(*t.Gap) || *t.Gap < 0 || *t.Gap > 400 {
		return 0, apperror.New(apperror.CodeInvalidInput, "节点间距必须在 0 到 400 之间")
	}
	return *t.Gap, nil
}
func (s *CanvasState) anchorBoundsLocked(id string) (canvasRect, bool) {
	if n, ok := s.nodeLocked(id); ok {
		return nodeRect(*n), true
	}
	for _, group := range s.Groups {
		if group.ID != id {
			continue
		}
		var bounds canvasRect
		found := false
		for _, member := range group.NodeIDs {
			if node, ok := s.nodeLocked(member); ok {
				r := nodeRect(*node)
				if found {
					bounds = unionRect(bounds, r)
				} else {
					bounds = r
					found = true
				}
			}
		}
		if found && group.Position != nil && group.Width > 0 && group.Height > 0 {
			bounds = unionRect(bounds, canvasRect{group.Position.X, group.Position.Y, group.Width, group.Height})
		}
		return bounds, found
	}
	return canvasRect{}, false
}

// Geometry is resolved by the execution layer. Collision sweeping skips to
// the far edge of each obstacle instead of asking the LLM for another position.
func (s *CanvasState) resolvePlacementLocked(size CanvasSize, explicit *XY, placement *CanvasPlacement, ignore map[string]bool) (XY, error) {
	gap, err := placement.spacing()
	if err != nil {
		return XY{}, err
	}
	if explicit != nil && placement != nil {
		return XY{}, apperror.New(apperror.CodeInvalidInput, "position 与 placement 只能选择一种")
	}
	want := XY{100, 100}
	relation := "auto"
	if explicit != nil {
		if !validCanvasNumber(explicit.X) || !validCanvasNumber(explicit.Y) {
			return XY{}, apperror.New(apperror.CodeInvalidInput, "坐标必须是有效数字")
		}
		want = *explicit
	} else if placement != nil && placement.AnchorID != "" {
		if ignore[placement.AnchorID] {
			return XY{}, apperror.New(apperror.CodeInvalidInput, "不能以待移动节点自身作为参照")
		}
		anchor, ok := s.anchorBoundsLocked(placement.AnchorID)
		if !ok {
			return XY{}, apperror.New(apperror.CodeNotFound, "参照节点或分组不存在，请从画布摘要选择有效 ID")
		}
		relation = placement.Relation
		if relation == "" || relation == "auto" {
			relation = "right"
		}
		switch relation {
		case "right":
			want = XY{anchor.X + anchor.W + gap, anchor.Y}
		case "left":
			want = XY{anchor.X - size.Width - gap, anchor.Y}
		case "below":
			want = XY{anchor.X, anchor.Y + anchor.H + gap}
		case "above":
			want = XY{anchor.X, anchor.Y - size.Height - gap}
		default:
			return XY{}, apperror.New(apperror.CodeInvalidInput, "摆放关系应为 right、left、above、below 或 auto")
		}
	} else {
		if placement != nil && placement.Relation != "" && placement.Relation != "auto" {
			return XY{}, apperror.New(apperror.CodeInvalidInput, "相对摆放需要指定 anchor_id")
		}
		first := true
		var bounds canvasRect
		for _, n := range s.Nodes {
			if ignore[n.ID] {
				continue
			}
			r := nodeRect(n)
			if first {
				bounds = r
				first = false
			} else {
				bounds = unionRect(bounds, r)
			}
		}
		if !first {
			want = XY{bounds.X + bounds.W + gap, bounds.Y}
		}
	}
	// Each jump permanently clears at least one obstacle along the sweep axis.
	// This terminates after at most N+1 scans, including dense/negative coordinates.
	for attempt := 0; attempt <= len(s.Nodes); attempt++ {
		conflict := false
		for _, n := range s.Nodes {
			if ignore[n.ID] {
				continue
			}
			obstacle := nodeRect(n)
			if rectOverlap(canvasRect{want.X, want.Y, size.Width, size.Height}, obstacle, gap) {
				if relation == "above" || relation == "below" {
					want.X = obstacle.X + obstacle.W + gap
				} else {
					want.Y = obstacle.Y + obstacle.H + gap
				}
				conflict = true
				break
			}
		}
		if !conflict {
			return want, nil
		}
	}
	return XY{}, apperror.New(apperror.CodeConflict, "未找到满足条件的空白区域，请换一个参照节点")
}

type layoutNodesTool struct{ state *CanvasState }

func (t *layoutNodesTool) Name() string { return "layout_nodes" }
func (t *layoutNodesTool) Description() string {
	return "用语义布局批量整理现有节点，不需读取或计算坐标。row 横排、column 竖排、grid 分镜网格、flow 按连线依赖分层。只移动 node_ids，不改内容或连线；默认保留所在区域并避让未选节点。"
}
func (t *layoutNodesTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":200},"mode":{"type":"string","enum":["row","column","grid","flow"]},"columns":{"type":"integer","minimum":1,"maximum":20},"placement":{"type":"object","properties":{"anchor_id":{"type":"string"},"relation":{"type":"string","enum":["right","left","above","below","auto"]},"gap":{"type":"number","minimum":0,"maximum":400}}},"expected_revision":{"type":"integer","minimum":0}},"required":["node_ids","mode"],"additionalProperties":false}`)
}
func (t *layoutNodesTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeIDs   []string         `json:"node_ids"`
		Mode      string           `json:"mode"`
		Columns   int              `json:"columns"`
		Placement *CanvasPlacement `json:"placement"`
		Expected  *uint64          `json:"expected_revision"`
	}
	if json.Unmarshal(args, &p) != nil || len(p.NodeIDs) == 0 || len(p.NodeIDs) > 200 {
		return "", apperror.New(apperror.CodeInvalidInput, "布局需要 1 到 200 个节点")
	}
	if p.Mode != "row" && p.Mode != "column" && p.Mode != "grid" && p.Mode != "flow" {
		return "", apperror.New(apperror.CodeInvalidInput, "布局模式不支持")
	}
	if p.Columns < 0 || p.Columns > 20 {
		return "", apperror.New(apperror.CodeInvalidInput, "布局列数必须在 1 到 20 之间")
	}
	s := t.state
	s.mu.Lock()
	fail := func(err error) (string, error) { s.mu.Unlock(); return "", err }
	if err := ctx.Err(); err != nil {
		return fail(apperror.ProviderRequestFailure(err))
	}
	if err := s.checkExpectedRevisionLocked(p.Expected); err != nil {
		return fail(err)
	}
	nodes := []CanvasNode{}
	ignore := map[string]bool{}
	for _, id := range p.NodeIDs {
		if ignore[id] {
			return fail(apperror.New(apperror.CodeInvalidInput, "布局节点 ID 不能重复"))
		}
		n, ok := s.nodeLocked(id)
		if !ok {
			return fail(apperror.New(apperror.CodeNotFound, "待布局节点不存在："+id))
		}
		if n.Draggable != nil && !*n.Draggable || n.Data["locked"] == true {
			return fail(apperror.New(apperror.CodeConflict, "布局中包含锁定节点，请先解锁或移出选择"))
		}
		nodes = append(nodes, *n)
		ignore[id] = true
	}
	if p.Placement != nil {
		for _, g := range s.Groups {
			if g.ID == p.Placement.AnchorID {
				for _, id := range g.NodeIDs {
					if ignore[id] {
						return fail(apperror.New(apperror.CodeInvalidInput, "参照分组不能包含待移动节点"))
					}
				}
			}
		}
	}
	gap, err := p.Placement.spacing()
	if err != nil {
		return fail(err)
	}
	mode := p.Mode
	layers := [][]int{}
	if mode == "flow" {
		layers = dependencyLayers(nodes, s.Edges)
		if layers == nil {
			mode = "grid"
		}
	}
	cols := p.Columns
	if cols == 0 {
		cols = int(math.Ceil(math.Sqrt(float64(len(nodes)))))
	}
	positions := make([]XY, len(nodes))
	extent := CanvasSize{}
	if mode == "flow" {
		x := 0.0
		for _, layer := range layers {
			y, maxW := 0.0, 0.0
			for _, i := range layer {
				size := nodeSize(nodes[i])
				positions[i] = XY{x, y}
				y += size.Height + gap
				maxW = math.Max(maxW, size.Width)
			}
			extent.Height = math.Max(extent.Height, y-gap)
			x += maxW + gap
		}
		extent.Width = x - gap
	} else {
		if mode == "row" {
			cols = len(nodes)
		}
		if mode == "column" {
			cols = 1
		}
		x, y, rowH := 0.0, 0.0, 0.0
		for i, n := range nodes {
			if i > 0 && i%cols == 0 {
				x = 0
				y += rowH + gap
				rowH = 0
			}
			size := nodeSize(n)
			positions[i] = XY{x, y}
			x += size.Width + gap
			rowH = math.Max(rowH, size.Height)
			extent.Width = math.Max(extent.Width, x-gap)
			extent.Height = math.Max(extent.Height, y+size.Height)
		}
	}
	var origin *XY
	if p.Placement == nil {
		pos := nodes[0].Position
		for _, n := range nodes {
			pos.X = math.Min(pos.X, n.Position.X)
			pos.Y = math.Min(pos.Y, n.Position.Y)
		}
		origin = &pos
	}
	placed, err := s.resolvePlacementLocked(extent, origin, p.Placement, ignore)
	if err != nil {
		return fail(err)
	}
	moves := make([]map[string]any, 0, len(nodes))
	for i, n := range nodes {
		pos := XY{placed.X + positions[i].X, placed.Y + positions[i].Y}
		s.moveNodeLocked(n.ID, pos)
		moves = append(moves, map[string]any{"node_id": n.ID, "position": pos, "from_position": n.Position})
	}
	base, revision := s.recordChangeLocked("move_nodes", p.NodeIDs, nil)
	s.mu.Unlock()
	s.emit(EventCanvasPatch, canvasPatchWithRevision(map[string]any{"op": "move_nodes", "moves": moves}, base, revision))
	return canvasMutationResult(revision, map[string]any{"node_ids": p.NodeIDs, "layout": mode, "cycle_fallback": mode != p.Mode, "moved": len(moves)}), nil
}

// Deterministic topological layering; cycles fall back to a stable grid.
// Edges are never reversed or deleted merely to satisfy a layout algorithm.
func dependencyLayers(nodes []CanvasNode, edges []CanvasEdge) [][]int {
	index := map[string]int{}
	for i, n := range nodes {
		index[n.ID] = i
	}
	indegree := make([]int, len(nodes))
	next := make([][]int, len(nodes))
	for _, e := range edges {
		a, okA := index[e.Source]
		b, okB := index[e.Target]
		if okA && okB {
			indegree[b]++
			next[a] = append(next[a], b)
		}
	}
	layers := [][]int{}
	seen := make([]bool, len(nodes))
	done := 0
	for done < len(nodes) {
		layer := []int{}
		for i := range nodes {
			if !seen[i] && indegree[i] == 0 {
				layer = append(layer, i)
			}
		}
		if len(layer) == 0 {
			return nil
		}
		for _, i := range layer {
			seen[i] = true
			done++
		}
		for _, i := range layer {
			for _, j := range next[i] {
				indegree[j]--
			}
		}
		layers = append(layers, layer)
	}
	return layers
}
