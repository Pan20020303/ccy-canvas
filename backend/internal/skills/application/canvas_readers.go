package application

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const canvasReadTextBudget = 16000

var canvasNodeListSchema = json.RawMessage(`{"type":"object","properties":{"type":{"type":"string","description":"Exact node type, e.g. imageNode/videoNode/textNode"},"group_id":{"type":"string","description":"Limit results to members of this group; discover IDs with list_groups"},"name_contains":{"type":"string","description":"Case-insensitive substring across customTitle, sourceName, content, promptDraft and prompt"},"limit":{"type":"integer","minimum":1,"maximum":50,"default":20},"cursor":{"type":"string","description":"next_cursor from the previous page; keep the same filters"}},"additionalProperties":false}`)

type canvasPageRequest struct {
	Limit        int    `json:"limit"`
	Cursor       string `json:"cursor"`
	Type         string `json:"type"`
	GroupID      string `json:"group_id"`
	NameContains string `json:"name_contains"`
}

type canvasPageCursor struct {
	Revision uint64 `json:"r"`
	Offset   int    `json:"o"`
	Query    string `json:"q"`
}

func (p *canvasPageRequest) normalize() error {
	if p.Limit == 0 {
		p.Limit = 20
	}
	if p.Limit < 1 || p.Limit > 50 {
		return fmt.Errorf("limit must be between 1 and 50")
	}
	p.Type = strings.TrimSpace(p.Type)
	p.GroupID = strings.TrimSpace(p.GroupID)
	p.NameContains = strings.ToLower(strings.TrimSpace(p.NameContains))
	return nil
}

func (p canvasPageRequest) queryKey(kind string) string {
	data, _ := json.Marshal([]string{kind, p.Type, p.GroupID, p.NameContains})
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func (p canvasPageRequest) offset(revision uint64, kind string) (int, error) {
	if p.Cursor == "" {
		return 0, nil
	}
	if len(p.Cursor) > 512 {
		return 0, fmt.Errorf("invalid cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(p.Cursor)
	if err != nil {
		return 0, fmt.Errorf("invalid cursor")
	}
	var cursor canvasPageCursor
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.Offset < 0 {
		return 0, fmt.Errorf("invalid cursor")
	}
	if cursor.Revision != revision || cursor.Query != p.queryKey(kind) {
		return 0, fmt.Errorf("cursor is stale or filters changed; start again without cursor (current revision %d)", revision)
	}
	return cursor.Offset, nil
}

func (p canvasPageRequest) nextCursor(revision uint64, kind string, offset, total int) string {
	if offset >= total {
		return ""
	}
	raw, _ := json.Marshal(canvasPageCursor{Revision: revision, Offset: offset, Query: p.queryKey(kind)})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func canvasBriefText(value string, limit int) string {
	if canvasInlineMedia(value) {
		return "[内联媒体已省略]"
	}
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return value
}

func canvasInlineMedia(value string) bool {
	v := strings.TrimSpace(value)
	if len(v) >= 5 && strings.EqualFold(v[:5], "data:") {
		return true
	}
	// Raw base64 previews occasionally lack a data URI prefix.
	return strings.HasPrefix(v, "iVBORw0KGgo") || strings.HasPrefix(v, "/9j/") || strings.HasPrefix(v, "UklGR")
}

type canvasNodeSummary struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Name       string `json:"name,omitempty"`
	SourceName string `json:"source_name,omitempty"`
	Status     string `json:"status,omitempty"`
	HasURL     bool   `json:"has_url"`
	HasContent bool   `json:"has_content,omitempty"`
	HasPrompt  bool   `json:"has_prompt,omitempty"`
}

func summarizeCanvasNode(node CanvasNode) canvasNodeSummary {
	customTitle, _ := node.Data["customTitle"].(string)
	sourceName, _ := node.Data["sourceName"].(string)
	name := strings.TrimSpace(customTitle)
	if name == "" {
		name = sourceName
	}
	status, _ := node.Data["generationStatus"].(string)
	if status == "" {
		status, _ = node.Data["status"].(string)
	}
	url, _ := node.Data["url"].(string)
	content, _ := node.Data["content"].(string)
	prompt, _ := node.Data["promptDraft"].(string)
	if prompt == "" {
		prompt, _ = node.Data["prompt"].(string)
	}
	return canvasNodeSummary{ID: node.ID, Type: node.Type, Name: canvasBriefText(name, 120), SourceName: canvasBriefText(sourceName, 160), Status: canvasBriefText(status, 40), HasURL: strings.TrimSpace(url) != "", HasContent: content != "", HasPrompt: prompt != ""}
}

// Caller holds at least the state read lock.
func canvasGroupLocked(state *CanvasState, id string) (*CanvasGroup, error) {
	for i := range state.Groups {
		if state.Groups[i].ID == id {
			return &state.Groups[i], nil
		}
	}
	return nil, fmt.Errorf("group not found: %s; use list_groups to find the group ID", id)
}

func listCanvasNodes(state *CanvasState, args json.RawMessage) (string, error) {
	var p canvasPageRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &p); err != nil {
			return "", err
		}
	}
	if err := p.normalize(); err != nil {
		return "", err
	}
	state.mu.RLock()
	defer state.mu.RUnlock()
	offset, err := p.offset(state.revision, "nodes")
	if err != nil {
		return "", err
	}
	var members map[string]bool
	if p.GroupID != "" {
		group, err := canvasGroupLocked(state, p.GroupID)
		if err != nil {
			return "", err
		}
		members = make(map[string]bool, len(group.NodeIDs))
		for _, id := range group.NodeIDs {
			members[id] = true
		}
	}
	matches := make([]string, 0)
	for id := range state.nodeIndex {
		if members != nil && !members[id] {
			continue
		}
		node, ok := state.nodeLocked(id)
		if !ok || (p.Type != "" && node.Type != p.Type) {
			continue
		}
		matched := p.NameContains == ""
		for _, key := range []string{"customTitle", "sourceName", "content", "promptDraft", "prompt"} {
			value, _ := node.Data[key].(string)
			if !matched && !canvasInlineMedia(value) && strings.Contains(strings.ToLower(value), p.NameContains) {
				matched = true
			}
		}
		if matched {
			matches = append(matches, id)
		}
	}
	sort.Strings(matches)
	if offset > len(matches) {
		return "", fmt.Errorf("cursor offset exceeds result count; start again without cursor")
	}
	end := min(offset+p.Limit, len(matches))
	nodes := make([]canvasNodeSummary, 0, end-offset)
	for _, id := range matches[offset:end] {
		node, _ := state.nodeLocked(id)
		nodes = append(nodes, summarizeCanvasNode(*node))
	}
	raw, _ := json.Marshal(map[string]any{"revision": state.revision, "snapshot_scope": "run_snapshot", "nodes": nodes, "total": len(matches), "next_cursor": p.nextCursor(state.revision, "nodes", end, len(matches)), "truncated": end < len(matches)})
	return string(raw), nil
}

var canvasDefaultReadFields = []string{"customTitle", "sourceName", "status", "generationStatus", "model", "modelId", "width", "height", "duration", "resolution", "ratio", "mode"}
var canvasAllowedReadFields = []string{"id", "type", "position", "data", "customTitle", "sourceName", "status", "generationStatus", "model", "modelId", "modelKey", "width", "height", "duration", "resolution", "ratio", "mode", "content", "promptDraft", "prompt", "url", "thumbnailUrl", "mimeType", "format", "seed", "count", "videoMode", "error", "errorMessage", "generationParams"}

// Generation settings are the one structured data field readers expose. Keep
// their scalar settings useful without leaking embedded references/editor blobs.
var canvasGenerationParamFields = []string{"model", "aspectRatio", "ratio", "resolution", "size", "width", "height", "duration", "durationSeconds", "seed", "count", "mode", "referenceVariant", "fps", "generateAudio", "audio", "watermark", "quality", "steps", "cfgScale", "scale", "format"}

type canvasReadRequest struct {
	NodeID     string   `json:"node_id"`
	NodeIDs    []string `json:"node_ids"`
	Fields     []string `json:"fields"`
	TextOffset int      `json:"text_offset"`
	TextLimit  int      `json:"text_limit"`
}

func canvasNodeReadSchema(batch bool) json.RawMessage {
	properties := map[string]any{
		"fields":      map[string]any{"type": "array", "maxItems": len(canvasAllowedReadFields), "items": map[string]any{"type": "string", "enum": canvasAllowedReadFields}, "description": "Omit for compact metadata; explicitly request content/promptDraft/url. data expands to the safe whitelist, never raw editor state."},
		"text_offset": map[string]any{"type": "integer", "minimum": 0, "default": 0, "description": "Unicode character offset for text fields; use field_pages.next_offset to continue, especially for content/promptDraft/prompt"},
		"text_limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 8000, "default": 1000},
	}
	required := "node_id"
	properties[required] = map[string]any{"type": "string", "minLength": 1}
	if batch {
		delete(properties, required)
		required = "node_ids"
		properties[required] = map[string]any{"type": "array", "items": map[string]any{"type": "string", "minLength": 1}, "minItems": 1, "maxItems": 50}
	}
	raw, _ := json.Marshal(map[string]any{"type": "object", "properties": properties, "required": []string{required}, "additionalProperties": false})
	return raw
}

func (p *canvasReadRequest) validate() error {
	if p.NodeID == "" && len(p.NodeIDs) == 0 {
		return fmt.Errorf("node_id is required")
	}
	if p.TextLimit == 0 {
		p.TextLimit = 1000
	}
	if p.TextOffset < 0 || p.TextLimit < 1 || p.TextLimit > 8000 {
		return fmt.Errorf("text_offset must be nonnegative and text_limit must be between 1 and 8000")
	}
	if len(p.Fields) > len(canvasAllowedReadFields) {
		return fmt.Errorf("too many fields")
	}
	allowed := make(map[string]bool, len(canvasAllowedReadFields))
	for _, key := range canvasAllowedReadFields {
		allowed[key] = true
	}
	for _, field := range p.Fields {
		if !allowed[field] {
			return fmt.Errorf("unsupported field %q; choose a documented metadata, content, prompt or URL field", field)
		}
	}
	return nil
}

func canvasNodeDetails(node CanvasNode, p canvasReadRequest, budget *int) map[string]any {
	summary := summarizeCanvasNode(node)
	item := map[string]any{"id": node.ID, "type": node.Type, "name": summary.Name, "has_url": summary.HasURL, "has_content": summary.HasContent, "has_prompt": summary.HasPrompt}
	fields := p.Fields
	if len(fields) == 0 {
		fields = canvasDefaultReadFields
	}
	for _, field := range fields {
		if field == "data" {
			fields = append(append([]string{}, fields...), canvasAllowedReadFields...)
			break
		}
	}
	data := make(map[string]any)
	pages := make(map[string]any)
	seen := make(map[string]bool)
	for _, field := range fields {
		if seen[field] {
			continue
		}
		seen[field] = true
		if field == "position" {
			item["position"] = node.Position
			continue
		}
		if field == "id" || field == "type" || field == "data" {
			continue
		}
		value, exists := node.Data[field]
		if !exists {
			continue
		}
		if field == "generationParams" {
			if params, ok := value.(map[string]any); ok {
				filtered := make(map[string]any)
				omitted := len(params)
				for _, key := range canvasGenerationParamFields {
					switch parameter := params[key].(type) {
					case string:
						if canvasInlineMedia(parameter) || len([]rune(parameter)) > min(240, *budget) {
							continue
						}
						filtered[key] = parameter
						*budget -= len([]rune(parameter))
						omitted--
					case bool, float64, float32, int, int32, int64, uint, uint32, uint64, json.Number:
						filtered[key] = parameter
						omitted--
					}
				}
				data[field] = filtered
				if omitted > 0 {
					pages[field] = map[string]any{"omitted_fields": omitted, "reason": "only_safe_scalar_generation_settings"}
				}
				continue
			}
		}
		switch v := value.(type) {
		case string:
			if canvasInlineMedia(v) {
				pages[field] = map[string]any{"omitted": true, "reason": "inline_media"}
				continue
			}
			runes := []rune(v)
			offset, limit := min(p.TextOffset, len(runes)), 240
			if field == "content" || field == "promptDraft" || field == "prompt" {
				limit = p.TextLimit
			}
			if field == "url" || field == "thumbnailUrl" {
				// Never return a partial URL that a subsequent media tool might use.
				if len(runes) > 8192 || len(runes) > *budget {
					pages[field] = map[string]any{"omitted": true, "reason": "url_or_response_budget_exceeded"}
					continue
				}
				offset = 0
				limit = len(runes)
			}
			end := offset + min(limit, *budget, len(runes)-offset)
			data[field] = string(runes[offset:end])
			*budget -= end - offset
			pages[field] = map[string]any{"offset": offset, "total_chars": len(runes), "truncated": end < len(runes), "next_offset": nil}
			if end < len(runes) {
				pages[field].(map[string]any)["next_offset"] = end
			}
		case bool, float64, float32, int, int32, int64, uint, uint32, uint64, json.Number, nil:
			data[field] = value
		default:
			pages[field] = map[string]any{"omitted": true, "reason": "structured_editor_data"}
		}
	}
	item["data"] = data
	if len(pages) > 0 {
		item["field_pages"] = pages
	}
	return item
}

type listGroupsTool struct{ state *CanvasState }

func (t *listGroupsTool) Name() string { return "list_groups" }
func (t *listGroupsTool) Description() string {
	return "按需分页查找本轮画布分组（含空组），返回ID、名称和实际成员数；默认20组，最多50组。读取组内节点用 read_group 或带 group_id 的 find_nodes。"
}
func (t *listGroupsTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"name_contains":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50,"default":20},"cursor":{"type":"string"}},"additionalProperties":false}`)
}
func (t *listGroupsTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p canvasPageRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &p); err != nil {
			return "", err
		}
	}
	if err := p.normalize(); err != nil {
		return "", err
	}
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	offset, err := p.offset(t.state.revision, "groups")
	if err != nil {
		return "", err
	}
	groups := make([]CanvasGroup, 0)
	for _, group := range t.state.Groups {
		if p.NameContains == "" || strings.Contains(strings.ToLower(group.Name), p.NameContains) {
			groups = append(groups, group)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })
	if offset > len(groups) {
		return "", fmt.Errorf("cursor offset exceeds result count; start again without cursor")
	}
	end := min(offset+p.Limit, len(groups))
	items := make([]map[string]any, 0, end-offset)
	for _, group := range groups[offset:end] {
		members := make(map[string]bool)
		for _, id := range group.NodeIDs {
			if _, ok := t.state.nodeLocked(id); ok {
				members[id] = true
			}
		}
		items = append(items, map[string]any{"id": group.ID, "name": canvasBriefText(group.Name, 160), "node_count": len(members)})
	}
	raw, _ := json.Marshal(map[string]any{"revision": t.state.revision, "snapshot_scope": "run_snapshot", "groups": items, "total": len(groups), "next_cursor": p.nextCursor(t.state.revision, "groups", end, len(groups)), "truncated": end < len(groups)})
	return string(raw), nil
}

type readGroupTool struct{ state *CanvasState }

func (t *readGroupTool) Name() string { return "read_group" }
func (t *readGroupTool) Description() string {
	return "分页读取指定分组的节点摘要，返回分组ID、名称和成员总数。用节点ID再读取必要字段，不会展开全文或原始编辑器状态。"
}
func (t *readGroupTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"group_id":{"type":"string","minLength":1},"type":{"type":"string"},"name_contains":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50,"default":20},"cursor":{"type":"string"}},"required":["group_id"],"additionalProperties":false}`)
}
func (t *readGroupTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var p canvasPageRequest
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}
	if strings.TrimSpace(p.GroupID) == "" {
		return "", fmt.Errorf("group_id is required")
	}
	result, err := listCanvasNodes(t.state, args)
	if err != nil {
		return "", err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		return "", err
	}
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	group, err := canvasGroupLocked(t.state, strings.TrimSpace(p.GroupID))
	if err != nil {
		return "", err
	}
	// Do not attach a group name from a different revision than the member page.
	if revision, ok := out["revision"].(float64); !ok || uint64(revision) != t.state.revision {
		return "", fmt.Errorf("canvas changed while reading group; retry without cursor")
	}
	out["group"] = map[string]any{"id": group.ID, "name": canvasBriefText(group.Name, 160)}
	raw, _ := json.Marshal(out)
	return string(raw), nil
}
