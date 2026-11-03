package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/client"
	"ccy-canvas/backend/internal/cli/output"
)

// Shared generation flags (bound per-subcommand below).
type genFlags struct {
	prompt           string
	model            string
	providerConfigID string
	nodeID           string
	projectID        string
	requestID        string
	noWait           bool
	pollOnly         bool
	out              string
	timeout          int
	params           []string

	// image
	size         string
	quality      string
	outputCount  int
	sequential   bool
	thinking     bool
	outputFormat string

	// image + video
	resolution string
	refs       []string
	seed       int
	seedSet    bool

	// video
	duration      int
	aspectRatio   string
	refVideos     []string
	referenceMode string
	audioSetting  string
}

var (
	gfImage genFlags
	gfVideo genFlags
	gfText  genFlags
)

var generateCmd = &cobra.Command{
	Use:   "generate",
	Short: "提交生成任务(image / video / text)",
}

var generateImageCmd = &cobra.Command{
	Use:   "image",
	Short: "生成图片",
	RunE: func(cmd *cobra.Command, args []string) error {
		gfImage.seedSet = cmd.Flags().Changed("seed")
		req := client.GenerateRequest{
			ServiceType:  "image",
			Size:         gfImage.size,
			Resolution:   gfImage.resolution,
			Quality:      gfImage.quality,
			OutputCount:  gfImage.outputCount,
			OutputFormat: gfImage.outputFormat,
		}
		if gfImage.sequential {
			b := true
			req.EnableSequential = &b
		}
		if cmd.Flags().Changed("thinking") {
			b := gfImage.thinking
			req.ThinkingMode = &b
		}
		return runGenerate(&gfImage, req, gfImage.refs, nil)
	},
}

var generateVideoCmd = &cobra.Command{
	Use:   "video",
	Short: "生成视频",
	RunE: func(cmd *cobra.Command, args []string) error {
		gfVideo.seedSet = cmd.Flags().Changed("seed")
		req := client.GenerateRequest{
			ServiceType:   "video",
			Resolution:    gfVideo.resolution,
			Duration:      gfVideo.duration,
			AspectRatio:   gfVideo.aspectRatio,
			ReferenceMode: gfVideo.referenceMode,
			AudioSetting:  gfVideo.audioSetting,
		}
		return runGenerate(&gfVideo, req, gfVideo.refs, gfVideo.refVideos)
	},
}

var generateTextCmd = &cobra.Command{
	Use:   "text",
	Short: "生成文本",
	RunE: func(cmd *cobra.Command, args []string) error {
		gfText.seedSet = false
		req := client.GenerateRequest{ServiceType: "text"}
		return runGenerate(&gfText, req, nil, nil)
	},
}

// runGenerate finalizes the request, resolves references, submits, and — unless
// --no-wait — waits for a terminal state and optionally downloads (--out).
func runGenerate(gf *genFlags, req client.GenerateRequest, refs, refVideos []string) error {
	if strings.TrimSpace(gf.prompt) == "" {
		return fmt.Errorf("--prompt 必填")
	}
	if strings.TrimSpace(gf.model) == "" {
		return fmt.Errorf("--model 必填")
	}
	c, err := newAuthedClient()
	if err != nil {
		return err
	}

	req.Prompt = gf.prompt
	req.Model = gf.model
	req.ProviderConfigID = gf.providerConfigID
	req.ProjectID = gf.projectID
	req.NodeID = gf.nodeID
	if req.NodeID == "" {
		req.NodeID = uuid.NewString()
	}
	req.RequestID = gf.requestID
	if req.RequestID == "" {
		req.RequestID = uuid.NewString()
	}
	if gf.seedSet {
		s := gf.seed
		req.Seed = &s
	}
	params, err := parseParams(gf.params)
	if err != nil {
		return err
	}
	req.Parameters = params

	// Resolve references: URL passes through; local file is uploaded first.
	imgs, err := resolveRefs(c, refs)
	if err != nil {
		return err
	}
	req.ReferenceImages = append(req.ReferenceImages, imgs...)
	vids, err := resolveRefs(c, refVideos)
	if err != nil {
		return err
	}
	switch {
	case len(vids) == 1:
		req.ReferenceVideo = vids[0]
	case len(vids) > 1:
		req.ReferenceVideos = vids
	}

	res, err := c.Generate(ctx(), req)
	if err != nil {
		return err
	}

	switch res.Type {
	case "text":
		if flagJSON {
			return output.JSON(res)
		}
		fmt.Println(res.Content)
		return nil

	case "url":
		return finish(c, primaryOf(res.Content, res.ContentList), allURLs(res.Content, res.ContentList), res.TaskID, gf.out)

	case "queued":
		if gf.noWait {
			if flagJSON {
				return output.JSON(res)
			}
			fmt.Printf("已提交,task_id=%s(稍后 `ccy tasks get %s`,或加 --out 下载)\n", res.TaskID, res.TaskID)
			return nil
		}
		if !flagJSON {
			fmt.Fprintf(os.Stderr, "已排队,等待中… task_id=%s\n", res.TaskID)
		}
		wr, err := c.Wait(ctx(), res.TaskID, time.Duration(gf.timeout)*time.Second, gf.pollOnly)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return fmt.Errorf("等待超时,任务仍在进行,task_id=%s(稍后 `ccy tasks get %s`)", res.TaskID, res.TaskID)
			}
			return err
		}
		if wr.Status == "error" {
			return fmt.Errorf("生成失败: %s", wr.ErrorMsg)
		}
		urls := wr.ResultURLs
		if len(urls) == 0 && wr.ResultURL != "" {
			urls = []string{wr.ResultURL}
		}
		return finish(c, primaryOf("", urls), urls, res.TaskID, gf.out)

	default:
		if flagJSON {
			return output.JSON(res)
		}
		fmt.Printf("未知返回类型 %q\n", res.Type)
		return nil
	}
}

// finish prints URLs and, when out != "", downloads each asset.
func finish(c *client.Client, primary string, all []string, taskID, out string) error {
	if len(all) == 0 && primary != "" {
		all = []string{primary}
	}
	if flagJSON {
		return output.JSON(map[string]any{"task_id": taskID, "result_url": primary, "result_urls": all})
	}
	for _, u := range all {
		fmt.Println(u)
	}
	if strings.TrimSpace(out) == "" {
		return nil
	}
	multiple := len(all) > 1
	for _, u := range all {
		dest := out
		if multiple {
			dest = ensureDir(out)
		}
		p, err := c.Download(ctx(), u, dest)
		if err != nil {
			return fmt.Errorf("下载 %s 失败: %w", u, err)
		}
		fmt.Fprintf(os.Stderr, "已保存 %s\n", p)
	}
	return nil
}

// ensureDir returns a directory path derived from out: if out has a file
// extension, use its parent dir; otherwise treat out itself as the dir.
func ensureDir(out string) string {
	dir := out
	if ext := strings.TrimSpace(fileExt(out)); ext != "" {
		dir = parentDir(out)
	}
	if dir == "" {
		dir = "."
	}
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func fileExt(p string) string {
	i := strings.LastIndexAny(p, "./\\")
	if i < 0 || p[i] != '.' {
		return ""
	}
	return p[i:]
}

func parentDir(p string) string {
	i := strings.LastIndexAny(p, "/\\")
	if i < 0 {
		return "."
	}
	return p[:i]
}

func resolveRefs(c *client.Client, refs []string) ([]string, error) {
	var out []string
	for _, r := range refs {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		if strings.HasPrefix(r, "http://") || strings.HasPrefix(r, "https://") {
			out = append(out, r)
			continue
		}
		up, err := c.Upload(ctx(), r)
		if err != nil {
			return nil, fmt.Errorf("上传参考文件 %s 失败: %w", r, err)
		}
		out = append(out, up.URL)
	}
	return out, nil
}

// parseParams turns --param k=v pairs into a map. Values are parsed as JSON
// when possible (so numbers/bools/objects keep their type), else kept as string.
func parseParams(pairs []string) (map[string]any, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	m := make(map[string]any, len(pairs))
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			return nil, fmt.Errorf("--param 需 key=value 形式: %q", p)
		}
		k = strings.TrimSpace(k)
		if k == "" {
			return nil, fmt.Errorf("--param 的 key 不能为空: %q", p)
		}
		var parsed any
		if json.Unmarshal([]byte(v), &parsed) == nil {
			m[k] = parsed
		} else {
			m[k] = v
		}
	}
	return m, nil
}

func primaryOf(content string, list []string) string {
	if content != "" {
		return content
	}
	if len(list) > 0 {
		return list[0]
	}
	return ""
}

func allURLs(content string, list []string) []string {
	if len(list) > 0 {
		return list
	}
	if content != "" {
		return []string{content}
	}
	return nil
}

func bindCommonGenFlags(cmd *cobra.Command, gf *genFlags) {
	f := cmd.Flags()
	f.StringVarP(&gf.prompt, "prompt", "p", "", "提示词(必填)")
	f.StringVarP(&gf.model, "model", "m", "", "模型名(必填,见 ccy providers)")
	f.StringVar(&gf.providerConfigID, "provider-config-id", "", "精确指定渠道(见 ccy providers 的 provider_config_id;不填则后端自选)")
	f.StringVar(&gf.nodeID, "node-id", "", "画布节点关联 id(默认自动生成 uuid)")
	f.StringVar(&gf.projectID, "project-id", "", "关联项目 id(可选)")
	f.StringVar(&gf.requestID, "request-id", "", "幂等键(默认每次新 uuid)")
	f.BoolVar(&gf.noWait, "no-wait", false, "只提交,不等待(返回 task_id)")
	f.BoolVar(&gf.pollOnly, "poll-only", false, "只用轮询,不订阅 SSE")
	f.IntVar(&gf.timeout, "timeout", 300, "等待超时(秒)")
	f.StringArrayVar(&gf.params, "param", nil, "额外参数 key=value(可重复;值按 JSON 解析)")
}

func init() {
	// image
	bindCommonGenFlags(generateImageCmd, &gfImage)
	generateImageCmd.Flags().StringVar(&gfImage.size, "size", "", "比例/尺寸(如 1:1, 16:9, auto)")
	generateImageCmd.Flags().StringVar(&gfImage.resolution, "resolution", "", "分辨率(如 1K, 2K, 4K)")
	generateImageCmd.Flags().StringVar(&gfImage.quality, "quality", "", "质量(auto/high/medium/low)")
	generateImageCmd.Flags().StringArrayVar(&gfImage.refs, "ref", nil, "参考图 URL 或本地文件(可重复;本地文件自动上传)")
	generateImageCmd.Flags().IntVar(&gfImage.outputCount, "output-count", 0, "输出数量")
	generateImageCmd.Flags().BoolVar(&gfImage.sequential, "sequential", false, "组图模式(一次最多 12 张)")
	generateImageCmd.Flags().BoolVar(&gfImage.thinking, "thinking", false, "思考模式(wan2.7 文生图)")
	generateImageCmd.Flags().IntVar(&gfImage.seed, "seed", 0, "随机种子 [0,2147483647]")
	generateImageCmd.Flags().StringVar(&gfImage.outputFormat, "output-format", "", "输出格式(如 png/jpeg/webp)")
	generateImageCmd.Flags().StringVar(&gfImage.out, "out", "", "下载目录或文件路径")

	// video
	bindCommonGenFlags(generateVideoCmd, &gfVideo)
	generateVideoCmd.Flags().IntVar(&gfVideo.duration, "duration", 0, "时长(秒)")
	generateVideoCmd.Flags().StringVar(&gfVideo.aspectRatio, "aspect-ratio", "", "宽高比(16:9, 9:16 等)")
	generateVideoCmd.Flags().StringVar(&gfVideo.resolution, "resolution", "", "分辨率(480p/720p/1080P 等)")
	generateVideoCmd.Flags().StringArrayVar(&gfVideo.refs, "ref", nil, "首帧/参考图 URL 或本地文件(可重复)")
	generateVideoCmd.Flags().StringArrayVar(&gfVideo.refVideos, "ref-video", nil, "参考视频 URL 或本地文件(可重复;1 个→reference_video,多个→reference_videos)")
	generateVideoCmd.Flags().StringVar(&gfVideo.referenceMode, "reference-mode", "", "参考模式(start_frame/start_end/image_reference/motion_mimic/video_edit)")
	generateVideoCmd.Flags().StringVar(&gfVideo.audioSetting, "audio-setting", "", "音频设置(auto/origin)")
	generateVideoCmd.Flags().IntVar(&gfVideo.seed, "seed", 0, "随机种子 [0,2147483647]")
	generateVideoCmd.Flags().StringVar(&gfVideo.out, "out", "", "下载目录或文件路径")

	// text
	bindCommonGenFlags(generateTextCmd, &gfText)

	generateCmd.AddCommand(generateImageCmd, generateVideoCmd, generateTextCmd)
}
