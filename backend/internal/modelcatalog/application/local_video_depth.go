package application

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
)

var localDepthSlots = make(chan struct{}, 1)

type LocalVideoDepthRequest struct {
	MediaURL string
	Invert   bool
}

type LocalVideoDepthResult struct {
	URL      string  `json:"url"`
	Engine   string  `json:"engine"`
	Duration float64 `json:"duration"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Inverted bool    `json:"inverted"`
	TaskID   string  `json:"task_id,omitempty"`
}

type videoDepthRuntime struct {
	Python string
	Root   string
	Runner string
}

// CreateLocalDepthVideo converts a normal video to a temporally consistent
// grayscale depth video. The original media is copied into a private bounded
// temp directory and never passed to Python as a remote/user-controlled URL.
func (s *Service) CreateLocalDepthVideo(ctx context.Context, req LocalVideoDepthRequest) (*LocalVideoDepthResult, error) {
	if strings.TrimSpace(req.MediaURL) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "media_url is required")
	}
	select {
	case localDepthSlots <- struct{}{}:
		defer func() { <-localDepthSlots }()
	default:
		return nil, apperror.New(apperror.CodeRateLimited, "深度动作转换繁忙，请等待当前任务完成后再试")
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	runtime, err := resolveVideoDepthRuntime()
	if err != nil {
		return nil, err
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		return nil, err
	}
	ffprobe, err := localMediaExecutable("ffprobe")
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "ccy-video-depth-")
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "无法创建深度视频临时目录", err)
	}
	defer os.RemoveAll(dir)
	input, rawDir, output := filepath.Join(dir, "input.mp4"), filepath.Join(dir, "depth"), filepath.Join(dir, "depth-reference.mp4")
	if err := os.Mkdir(rawDir, 0700); err != nil {
		return nil, err
	}
	if err := copyTrimInput(ctx, req.MediaURL, input); err != nil {
		return nil, err
	}
	meta, err := probeTrimVideo(ctx, ffprobe, input)
	if err != nil {
		return nil, err
	}
	duration, width, height, err := validateDepthSource(meta)
	if err != nil {
		return nil, err
	}
	modelInput := input
	if depthInputNeedsPreparation(width, height) {
		modelInput = filepath.Join(dir, "depth-input.mp4")
		if err := prepareDepthInput(ctx, ffmpeg, input, modelInput); err != nil {
			return nil, err
		}
	}

	cmd := exec.CommandContext(ctx, runtime.Python, depthRunnerArgs(runtime.Runner, modelInput, rawDir)...)
	cmd.Dir = runtime.Root
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stdout, cmd.Stderr = &stderr, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, apperror.New(apperror.CodeTimeout, "深度动作转换已取消或超过 30 分钟，请缩短视频后重试")
		}
		return nil, apperror.Wrap(apperror.CodeValidation, "Video Depth Anything 处理失败，请检查模型与显存", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	raw, err := findDepthVideo(rawDir)
	if err != nil {
		return nil, err
	}
	if err := normalizeDepthVideo(ctx, ffmpeg, raw, output, req.Invert); err != nil {
		return nil, err
	}
	stat, err := os.Stat(output)
	if err != nil || stat.Size() == 0 || stat.Size() >= trimMaxOutputBytes {
		return nil, apperror.New(apperror.CodeRequestTooLarge, "深度视频结果为空或超过 190 MB，请缩短素材")
	}
	resultMeta, err := probeTrimVideo(ctx, ffprobe, output)
	if err != nil {
		return nil, err
	}
	resultDuration, resultWidth, resultHeight, err := validateDepthSource(resultMeta)
	if err != nil {
		return nil, err
	}
	if math.Abs(resultDuration-duration) > math.Max(.75, duration*.02) {
		return nil, apperror.New(apperror.CodeValidation, "深度视频时长与原视频不一致，请重试")
	}
	f, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	staged, err := writeStagedAsset(f, ".mp4", "video/mp4")
	if err != nil {
		return nil, err
	}
	if resultWidth == 0 || resultHeight == 0 {
		resultWidth, resultHeight = width, height
	}
	return &LocalVideoDepthResult{URL: staged.StagingURL, Engine: "video-depth-anything-small", Duration: resultDuration, Width: resultWidth, Height: resultHeight, Inverted: req.Invert}, nil
}

func validateDepthSource(meta *trimProbe) (duration float64, width, height int, err error) {
	duration, _ = strconv.ParseFloat(meta.Format.Duration, 64)
	for _, stream := range meta.Streams {
		if stream.CodecType != "video" {
			continue
		}
		width, height = stream.Width, stream.Height
		if d, parseErr := strconv.ParseFloat(stream.Duration, 64); parseErr == nil && d > 0 {
			duration = d
		}
		break
	}
	if width <= 0 || height <= 0 || width > 4096 || height > 4096 || int64(width)*int64(height) > 4096*2160 {
		return 0, 0, 0, apperror.New(apperror.CodeInvalidInput, "深度动作转换支持最高 4K 视频")
	}
	if duration <= 0 || duration > 600 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return 0, 0, 0, apperror.New(apperror.CodeInvalidInput, "视频时长无效或超过 10 分钟")
	}
	return duration, width, height, nil
}

func resolveVideoDepthRuntime() (videoDepthRuntime, error) {
	configuredRoot := strings.TrimSpace(os.Getenv("VIDEO_DEPTH_ANYTHING_DIR"))
	if configuredRoot != "" {
		abs, err := filepath.Abs(configuredRoot)
		if err != nil {
			return videoDepthRuntime{}, apperror.New(apperror.CodeValidation, "VIDEO_DEPTH_ANYTHING_DIR 配置无效")
		}
		runner := filepath.Join(abs, "run.py")
		if stat, err := os.Stat(runner); err != nil || stat.IsDir() {
			return videoDepthRuntime{}, apperror.New(apperror.CodeValidation, "VIDEO_DEPTH_ANYTHING_DIR 中未找到 run.py")
		}
		python, err := videoDepthPython(abs)
		if err != nil {
			return videoDepthRuntime{}, err
		}
		return videoDepthRuntime{Python: python, Root: abs, Runner: runner}, nil
	}
	roots := make([]string, 0, 3)
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Join(filepath.Dir(exe), "tools", "Video-Depth-Anything"))
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, filepath.Join(cwd, "tools", "Video-Depth-Anything"), filepath.Join(cwd, "..", "tools", "Video-Depth-Anything"))
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		runner := filepath.Join(abs, "run.py")
		if stat, err := os.Stat(runner); err != nil || stat.IsDir() {
			continue
		}
		python, err := videoDepthPython(abs)
		if err != nil {
			return videoDepthRuntime{}, err
		}
		return videoDepthRuntime{Python: python, Root: abs, Runner: runner}, nil
	}
	return videoDepthRuntime{}, apperror.New(apperror.CodeValidation, "未安装 Video Depth Anything，请运行 scripts/setup-video-depth.ps1 后重启后端")
}

func videoDepthPython(root string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv("VIDEO_DEPTH_PYTHON")); configured != "" {
		if stat, err := os.Stat(configured); err == nil && !stat.IsDir() {
			return configured, nil
		}
		return "", apperror.New(apperror.CodeValidation, "VIDEO_DEPTH_PYTHON 配置无效")
	}
	candidates := []string{filepath.Join(root, ".venv", "Scripts", "python.exe"), filepath.Join(root, ".venv", "bin", "python")}
	for _, candidate := range candidates {
		if stat, err := os.Stat(candidate); err == nil && !stat.IsDir() {
			return candidate, nil
		}
	}
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", apperror.New(apperror.CodeValidation, "未找到 Video Depth Anything 的 Python 环境")
}

func depthRunnerArgs(runner, input, outputDir string) []string {
	return []string{runner, "--input_video", input, "--output_dir", outputDir, "--encoder", "vits", "--max_res", "1280", "--target_fps", "-1", "--grayscale"}
}

func depthInputNeedsPreparation(width, height int) bool {
	return width > 1280 || height > 1280 || width%2 != 0 || height%2 != 0
}

// prepareDepthInput keeps both dimensions even before Video Depth Anything
// sees the file. Its OpenCV fallback can otherwise turn a common 1366x720
// source into 1280x675, which libx264/yuv420p refuses to encode after the
// depth inference has already finished.
func prepareDepthInput(ctx context.Context, ffmpeg, input, output string) error {
	filter := "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", trimFormats,
		"-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", filter,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "4", "-filter_threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output}
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return apperror.Wrap(apperror.CodeValidation, "深度动作输入预处理失败", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	return nil
}

func findDepthVideo(root string) (string, error) {
	type candidate struct {
		path     string
		size     int64
		priority int
	}
	var files []candidate
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".mp4", ".mov", ".mkv", ".webm", ".avi":
			if stat, err := entry.Info(); err == nil && stat.Size() > 0 {
				// Video Depth Anything writes both <input>_src.mp4 (the RGB
				// source frames) and <input>_vis.mp4 (the actual rendered depth
				// map). The RGB file is commonly larger, so choosing by size alone
				// silently returned the original-looking video instead of depth.
				name := strings.ToLower(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
				priority := 0
				switch {
				case strings.HasSuffix(name, "_vis"):
					priority = 100
				case strings.Contains(name, "depth"):
					priority = 80
				case strings.HasSuffix(name, "_src") || strings.Contains(name, "source"):
					priority = -100
				}
				files = append(files, candidate{path: path, size: stat.Size(), priority: priority})
			}
		}
		return nil
	})
	if len(files) == 0 {
		return "", apperror.New(apperror.CodeValidation, "Video Depth Anything 未生成深度视频")
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].priority != files[j].priority {
			return files[i].priority > files[j].priority
		}
		return files[i].size > files[j].size
	})
	return files[0].path, nil
}

func normalizeDepthVideo(ctx context.Context, ffmpeg, input, output string, invert bool) error {
	filter := "pad=ceil(iw/2)*2:ceil(ih/2)*2"
	if invert {
		filter += ",negate"
	}
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", trimFormats,
		"-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", filter,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "4", "-filter_threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
		"-fs", strconv.FormatInt(trimMaxOutputBytes, 10), output}
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return apperror.Wrap(apperror.CodeValidation, "深度视频编码失败", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	return nil
}
