package application

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// analyze_image:让 agent 真正"看"画布上的图片。
//
// agent 之前只能 read_node 拿到图片节点的元数据(URL/尺寸),模型看不到
// 画面内容 —— 反推提示词、按参考图分析构图这类诉求都做不了。本工具:
//   node_id / image_url → 服务端下载图片转 data URL → 视觉模型分析 → 文字。
// 图片转 base64 再发,规避两个坑:画布里的 /uploads 相对路径和局域网地址
// 上游模型根本取不到;OSS/COS 直链可能有防盗链。

// visionImageMaxBytes 限制下载体积:主流 VLM 网关对 base64 图片的上限
// 普遍在 10MB 左右,base64 还会膨胀 1/3。
const visionImageMaxBytes = 7 * 1024 * 1024

// imageFieldPriority 是画布各类节点存图片 URL 的字段,按可能性排序。
var imageFieldPriority = []string{"output", "image", "imageUrl", "url", "src", "editorPreview"}

type analyzeImageTool struct {
	state     *CanvasState
	llm       *LLMClient
	endpoints []Endpoint
	model     string
}

// BuildAnalyzeImageTool 构造看图工具。endpoints/model 指向一个视觉模型
// (前端 pickVisionModel 挑选后经 run 请求体传入,handler 解析出端点)。
func BuildAnalyzeImageTool(state *CanvasState, llm *LLMClient, endpoints []Endpoint, model string) Tool {
	return &analyzeImageTool{state: state, llm: llm, endpoints: endpoints, model: model}
}

func (t *analyzeImageTool) Name() string { return "analyze_image" }
func (t *analyzeImageTool) Description() string {
	return "用视觉模型查看并理解一张图片。适用于:描述画面内容、反推生成提示词、分析构图/色调/光影/人物。" +
		"传画布节点 node_id(自动取其图片)或直接传 image_url;question 写明你想了解什么(不写则输出通用画面分析)。"
}
func (t *analyzeImageTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string","description":"画布图片节点 id(优先)"},"image_url":{"type":"string","description":"图片 URL(没有 node_id 时用)"},"question":{"type":"string","description":"想了解的问题,如:反推这张图的生成提示词"}},"additionalProperties":false}`)
}

func (t *analyzeImageTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var p struct {
		NodeID   string `json:"node_id"`
		ImageURL string `json:"image_url"`
		Question string `json:"question"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return "", err
	}

	imageURL := strings.TrimSpace(p.ImageURL)
	if p.NodeID != "" {
		url, err := t.imageURLFromNode(p.NodeID)
		if err != nil {
			return "", err
		}
		imageURL = url
	}
	if imageURL == "" {
		return "", fmt.Errorf("需要 node_id 或 image_url")
	}

	dataURL, err := fetchImageAsDataURL(ctx, imageURL)
	if err != nil {
		return "", fmt.Errorf("图片获取失败: %w", err)
	}

	question := strings.TrimSpace(p.Question)
	if question == "" {
		question = "请详细描述这张图片:画面内容、主体与人物、构图与镜头感、色调与光影、整体氛围;最后给出一段可直接用于 AI 图像生成的中文提示词。"
	}

	answer, err := t.llm.VisionOneShot(ctx, t.endpoints, t.model, dataURL, question)
	if err != nil {
		return "", fmt.Errorf("视觉模型分析失败: %w", err)
	}
	// tool result 会回填进 agent 上下文,过长会稀释注意力。
	return truncateForTranscript(answer, 3000), nil
}

// imageURLFromNode 从画布节点数据里按字段优先级取图片 URL。
func (t *analyzeImageTool) imageURLFromNode(nodeID string) (string, error) {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	for _, n := range t.state.Nodes {
		if n.ID != nodeID {
			continue
		}
		for _, field := range imageFieldPriority {
			if v, ok := n.Data[field].(string); ok && strings.TrimSpace(v) != "" {
				return v, nil
			}
		}
		// 站位参考层(导演台)嵌套一层。
		if ref, ok := n.Data["referenceLayer"].(map[string]any); ok {
			if v, ok := ref["image"].(string); ok && strings.TrimSpace(v) != "" {
				return v, nil
			}
		}
		return "", fmt.Errorf("节点 %s 上没有找到图片(检查了 %s)", nodeID, strings.Join(imageFieldPriority, "/"))
	}
	return "", fmt.Errorf("node not found: %s", nodeID)
}

// fetchImageAsDataURL 下载图片并转成 data URL。相对路径(/uploads/..)拼本机
// 服务地址;已是 data: 的原样返回。
func fetchImageAsDataURL(ctx context.Context, rawURL string) (string, error) {
	if strings.HasPrefix(rawURL, "data:") {
		return rawURL, nil
	}
	url := rawURL
	if strings.HasPrefix(url, "/") {
		url = localServerBase() + url
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "", fmt.Errorf("不支持的图片地址: %s", rawURL)
	}

	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d fetching image", resp.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, visionImageMaxBytes+1))
	if err != nil {
		return "", err
	}
	if len(raw) > visionImageMaxBytes {
		return "", fmt.Errorf("图片超过 %dMB,视觉模型无法接收", visionImageMaxBytes/1024/1024)
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		contentType = sniffImageContentType(raw)
		if contentType == "" {
			return "", fmt.Errorf("目标不是图片(Content-Type: %s)", resp.Header.Get("Content-Type"))
		}
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

// sniffImageContentType 用魔数兜底识别常见图片格式(网关 Content-Type 缺失时)。
func sniffImageContentType(b []byte) string {
	ct := http.DetectContentType(b)
	if strings.HasPrefix(ct, "image/") {
		return ct
	}
	return ""
}

// localServerBase 返回本服务对自己可达的地址(相对 /uploads 路径用)。
func localServerBase() string {
	if v := strings.TrimSpace(os.Getenv("PUBLIC_API_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "9090"
	}
	return "http://127.0.0.1:" + port
}
