package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	visionVideoMaxBytes      = 128 << 20
	visionVideoMaxDuration   = 600
	visionVideoMaxRange      = 120
	visionVideoDefaultFrames = 8
	visionVideoMaxFrames     = 12
	visionVideoFrameMaxBytes = 1 << 20
	visionMediaCommandOutput = 256 << 10
)

var visionVideoSlots = make(chan struct{}, 2)

type analyzeVideoTool struct {
	state     *CanvasState
	llm       *LLMClient
	endpoints []Endpoint
	model     string
}

type videoAnalysisRequest struct {
	NodeID       string   `json:"node_id"`
	VideoURL     string   `json:"video_url"`
	Question     string   `json:"question"`
	StartSeconds float64  `json:"start_seconds"`
	EndSeconds   *float64 `json:"end_seconds"`
	FrameCount   int      `json:"frame_count"`
}

type videoAnalysisMetadata struct {
	Duration float64
	Width    int
	Height   int
	HasAudio bool
}

type VideoAnalysisResult struct {
	Analysis        string    `json:"analysis"`
	SampledTimes    []float64 `json:"sampled_times_seconds"`
	DurationSeconds float64   `json:"duration_seconds"`
	StartSeconds    float64   `json:"start_seconds"`
	EndSeconds      float64   `json:"end_seconds"`
	FrameCount      int       `json:"frame_count"`
	AudioAnalyzed   bool      `json:"audio_analyzed"`
	AudioNotice     string    `json:"audio_notice"`
	CoverageNotice  string    `json:"coverage_notice"`
	Model           string    `json:"model"`
}

// BuildAnalyzeVideoTool uses the current selected model directly: no delegated
// agent, implicit model switch, generation request or audio claims.
func BuildAnalyzeVideoTool(state *CanvasState, llm *LLMClient, endpoints []Endpoint, model string) Tool {
	return &analyzeVideoTool{state: state, llm: llm, endpoints: endpoints, model: model}
}
func (t *analyzeVideoTool) Name() string { return "analyze_video" }
func (t *analyzeVideoTool) Description() string {
	return "读取实际视频并用当前选定模型分析带时间标记的画面抽帧，可描述动作、镜头和反推提示词。默认8帧、最多12帧；只代表抽样画面，不含声音或完整逐帧观看。优先传用户引用的视频 node_id，也可传 video_url；超过2分钟的视频请指定 start_seconds/end_seconds 分段。"
}
func (t *analyzeVideoTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"node_id":{"type":"string","description":"优先使用用户明确引用的视频节点"},"video_url":{"type":"string","description":"本站上传路径或公网视频地址；有node_id时不使用此字段"},"question":{"type":"string","maxLength":4000,"description":"需要分析的画面问题"},"start_seconds":{"type":"number","minimum":0,"maximum":600,"default":0},"end_seconds":{"type":"number","minimum":0,"maximum":600},"frame_count":{"type":"integer","minimum":2,"maximum":12,"default":8}},"additionalProperties":false}`)
}

func (t *analyzeVideoTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var request videoAnalysisRequest
	decoder := json.NewDecoder(bytes.NewReader(args))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return "", fmt.Errorf("视频分析参数格式无效")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", fmt.Errorf("视频分析参数只能包含一个对象")
	}
	if request.FrameCount == 0 {
		request.FrameCount = visionVideoDefaultFrames
	}
	if request.FrameCount < 2 || request.FrameCount > visionVideoMaxFrames || !validVideoAnalysisTime(request.StartSeconds) ||
		(request.EndSeconds != nil && (!validVideoAnalysisTime(*request.EndSeconds) || *request.EndSeconds <= request.StartSeconds)) {
		return "", fmt.Errorf("请指定有效的视频时间范围和 2–12 张抽帧数量")
	}
	request.Question = strings.TrimSpace(request.Question)
	if len([]rune(request.Question)) > 4000 {
		return "", fmt.Errorf("视频分析问题请控制在 4000 字以内")
	}
	videoURL := strings.TrimSpace(request.VideoURL)
	if strings.TrimSpace(request.NodeID) != "" {
		var err error
		videoURL, err = t.videoURLFromNode(strings.TrimSpace(request.NodeID))
		if err != nil {
			return "", err
		}
	}
	if videoURL == "" {
		return "", fmt.Errorf("请选择视频节点或提供 video_url")
	}
	frames, metadata, start, end, err := prepareVisionVideo(ctx, videoURL, request)
	if err != nil {
		return "", err
	}
	if request.Question == "" {
		request.Question = "请按时间顺序描述视频抽样画面中的人物、动作变化、场景、镜头和光影，并给出可复用的中文视频提示词。"
	}
	prompt := fmt.Sprintf("你正在分析真实视频的定时抽帧，不是完整连续视频。视频总长 %.3f 秒，本次抽样范围 %.3f–%.3f 秒，共 %d 帧。严格依据所见帧回答，动作衔接属于推断时须注明，未抽到的内容不要杜撰。未提供音频，不得判断对白、配乐、音效或有声/无声。用中文回答用户问题：\n%s", metadata.Duration, start, end, len(frames), request.Question)
	answer, err := t.llm.VisionFramesOneShot(ctx, t.endpoints, t.model, frames, prompt)
	if err != nil {
		return "", fmt.Errorf("当前模型的视频画面分析失败：%w", err)
	}
	times := make([]float64, len(frames))
	for index, frame := range frames {
		times[index] = frame.TimestampSeconds
	}
	result := VideoAnalysisResult{
		Analysis: truncateForTranscript(answer, 10000), SampledTimes: times, DurationSeconds: metadata.Duration,
		StartSeconds: start, EndSeconds: end, FrameCount: len(frames), Model: t.model,
		AudioAnalyzed: false, AudioNotice: "本次仅分析视频画面抽帧，未分析音频、对白、配乐或音效。",
		CoverageNotice: "仅对列出的抽样时刻进行视觉分析，不等于观看了全部帧；快速动作与未采样瞬间可能遗漏。",
	}
	raw, err := json.Marshal(result)
	return string(raw), err
}

func validVideoAnalysisTime(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= visionVideoMaxDuration
}

func (t *analyzeVideoTool) videoURLFromNode(nodeID string) (string, error) {
	if t.state == nil {
		return "", fmt.Errorf("当前没有可读取的画布")
	}
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	node, found := t.state.nodeLocked(nodeID)
	if !found {
		return "", fmt.Errorf("未找到指定的视频节点")
	}
	if !strings.Contains(strings.ToLower(node.Type), "video") && !strings.HasPrefix(strings.ToLower(fmt.Sprint(node.Data["mimeType"])), "video/") {
		return "", fmt.Errorf("所选节点不是视频，请引用实际的视频节点")
	}
	for _, field := range []string{"url", "video", "videoUrl", "video_url", "output", "src", "outputs", "videos"} {
		if value := videoValueURL(node.Data[field]); value != "" {
			return value, nil
		}
	}
	return "", fmt.Errorf("该视频节点没有可读取的视频文件；缩略图不能代替视频，请等待生成完成或重新上传")
}

func videoValueURL(value any) string {
	switch typed := value.(type) {
	case string:
		if trimmed := strings.TrimSpace(typed); strings.HasPrefix(trimmed, "/uploads/") || strings.HasPrefix(trimmed, "/api/app/proxy-media?") || strings.HasPrefix(trimmed, "https://") || strings.HasPrefix(trimmed, "http://") {
			return trimmed
		}
	case map[string]any:
		for _, key := range []string{"video", "videoUrl", "video_url", "url", "output"} {
			if result := videoValueURL(typed[key]); result != "" {
				return result
			}
		}
	case []any:
		for _, item := range typed {
			if result := videoValueURL(item); result != "" {
				return result
			}
		}
	case []string:
		for _, item := range typed {
			if result := videoValueURL(item); result != "" {
				return result
			}
		}
	}
	return ""
}

func prepareVisionVideo(parent context.Context, rawURL string, request videoAnalysisRequest) ([]VisionFrame, videoAnalysisMetadata, float64, float64, error) {
	var empty videoAnalysisMetadata
	select {
	case visionVideoSlots <- struct{}{}:
		defer func() { <-visionVideoSlots }()
	default:
		return nil, empty, 0, 0, fmt.Errorf("视频分析准备繁忙，请稍后重试")
	}
	ctx, cancel := context.WithTimeout(parent, 120*time.Second)
	defer cancel()
	ffmpeg, err := visionMediaExecutable("ffmpeg")
	if err != nil {
		return nil, empty, 0, 0, err
	}
	ffprobe, err := visionMediaExecutable("ffprobe")
	if err != nil {
		return nil, empty, 0, 0, err
	}
	directory, err := os.MkdirTemp("", "ccy-video-analysis-")
	if err != nil {
		return nil, empty, 0, 0, fmt.Errorf("无法创建视频分析临时目录")
	}
	defer os.RemoveAll(directory) // only the unique directory just created by this call
	input := filepath.Join(directory, "input.media")
	format, err := copyVisionVideo(ctx, rawURL, input)
	if err != nil {
		return nil, empty, 0, 0, err
	}
	metadata, err := probeVisionVideo(ctx, ffprobe, input, format)
	if err != nil {
		return nil, empty, 0, 0, err
	}
	start, end := request.StartSeconds, metadata.Duration
	if request.EndSeconds != nil {
		end = *request.EndSeconds
	}
	times, err := videoSampleTimes(metadata.Duration, start, end, request.FrameCount)
	if err != nil {
		return nil, metadata, start, end, err
	}
	frames := make([]VisionFrame, 0, len(times))
	for index, timestamp := range times {
		output := filepath.Join(directory, fmt.Sprintf("frame-%02d.jpg", index))
		args := videoFrameCommandArgs(input, output, format, timestamp)
		if _, err := runVisionMediaCommand(ctx, ffmpeg, args); err != nil {
			return nil, metadata, start, end, fmt.Errorf("无法提取视频画面，请确认素材完整且编码受支持")
		}
		file, err := os.Open(output)
		if err != nil {
			return nil, metadata, start, end, fmt.Errorf("视频没有可读取的抽样画面")
		}
		content, readErr := io.ReadAll(io.LimitReader(file, visionVideoFrameMaxBytes+1))
		file.Close()
		if readErr != nil || len(content) > visionVideoFrameMaxBytes || len(content) < 4 || content[len(content)-2] != 0xff || content[len(content)-1] != 0xd9 {
			return nil, metadata, start, end, fmt.Errorf("抽帧图片不完整或超过大小限制")
		}
		dataURL, err := validatedVisionImage(content)
		if err != nil {
			return nil, metadata, start, end, err
		}
		frames = append(frames, VisionFrame{ImageURL: dataURL, TimestampSeconds: timestamp})
	}
	return frames, metadata, start, end, nil
}

func videoSampleTimes(duration, start, end float64, count int) ([]float64, error) {
	if !validVideoAnalysisTime(duration) || duration <= 0 || !validVideoAnalysisTime(start) || !validVideoAnalysisTime(end) || start >= duration || end > duration+0.001 || end <= start || end-start > visionVideoMaxRange || count < 2 || count > visionVideoMaxFrames {
		return nil, fmt.Errorf("视频源需在 10 分钟以内；请选择不超过 2 分钟且位于实际视频时长内的分析范围")
	}
	// Cell centers avoid an EOF seek and accurately declare the sample times.
	times := make([]float64, count)
	for index := range times {
		times[index] = start + (float64(index)+0.5)*(end-start)/float64(count)
	}
	return times, nil
}

func copyVisionVideo(ctx context.Context, rawURL, destination string) (string, error) {
	reader, err := openVisionMedia(ctx, rawURL, visionVideoMaxBytes)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", fmt.Errorf("无法准备本地视频副本")
	}
	n, copyErr := io.Copy(file, io.LimitReader(&visionContextReader{ctx: ctx, reader: reader}, visionVideoMaxBytes+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return "", fmt.Errorf("视频读取中断，请重试")
	}
	if n <= 0 || n > visionVideoMaxBytes {
		return "", fmt.Errorf("视频为空或超过 128MB 限制")
	}
	file, err = os.Open(destination)
	if err != nil {
		return "", fmt.Errorf("无法检查视频格式")
	}
	defer file.Close()
	header := make([]byte, 64)
	nRead, _ := io.ReadFull(file, header)
	return visionVideoContainer(header[:nRead])
}

type visionContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *visionContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func visionVideoContainer(header []byte) (string, error) {
	if len(header) >= 8 {
		switch string(header[4:8]) {
		case "ftyp", "moov", "mdat", "wide", "free", "skip":
			return "mov", nil
		}
	}
	if len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "AVI " {
		return "avi", nil
	}
	if len(header) >= 4 && bytes.Equal(header[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return "matroska", nil
	}
	return "", fmt.Errorf("仅支持完整的 MP4、MOV、WebM、MKV 或 AVI 视频文件，不支持播放列表或网页")
}

func visionInputArguments(input, format string) []string {
	args := []string{"-protocol_whitelist", "file", "-format_whitelist", format, "-f", format, "-probesize", "8388608", "-analyzeduration", "5000000", "-threads", "2"}
	if format == "mov" {
		args = append(args, "-enable_drefs", "0", "-use_absolute_path", "0")
	}
	return append(args, "-i", input)
}

func videoFrameCommandArgs(input, output, format string, timestamp float64) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-max_alloc", "67108864", "-ss", strconv.FormatFloat(timestamp, 'f', 6, 64)}
	args = append(args, visionInputArguments(input, format)...)
	return append(args, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", "scale=1024:1024:force_original_aspect_ratio=decrease,setsar=1", "-threads", "2", "-filter_threads", "1", "-c:v", "mjpeg", "-q:v", "4", "-fs", strconv.Itoa(visionVideoFrameMaxBytes), "-f", "image2", output)
}

func probeVisionVideo(ctx context.Context, executable, input, format string) (videoAnalysisMetadata, error) {
	var metadata videoAnalysisMetadata
	args := []string{"-v", "error", "-max_alloc", "67108864"}
	args = append(args, visionInputArguments(input, format)...)
	args = append(args, "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json")
	output, err := runVisionMediaCommand(ctx, executable, args)
	if err != nil {
		return metadata, fmt.Errorf("无法读取视频信息，请确认视频完整且不是播放列表")
	}
	var probe struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Duration  string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &probe); err != nil {
		return metadata, fmt.Errorf("视频元数据无效")
	}
	metadata.Duration, _ = strconv.ParseFloat(probe.Format.Duration, 64)
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" {
			metadata.HasAudio = true
		}
		if stream.CodecType == "video" && metadata.Width == 0 {
			metadata.Width, metadata.Height = stream.Width, stream.Height
			if duration, err := strconv.ParseFloat(stream.Duration, 64); err == nil && duration > 0 {
				metadata.Duration = duration
			}
		}
	}
	if metadata.Width < 1 || metadata.Height < 1 || metadata.Width > 4096 || metadata.Height > 4096 || int64(metadata.Width)*int64(metadata.Height) > 4096*2160 {
		return metadata, fmt.Errorf("未找到有效视频画面，当前支持最高 4K 输入")
	}
	if !validVideoAnalysisTime(metadata.Duration) || metadata.Duration <= 0 {
		return metadata, fmt.Errorf("视频时长无效或超过 10 分钟，请先剪短")
	}
	return metadata, nil
}

type boundedVisionBuffer struct{ bytes.Buffer }

func (b *boundedVisionBuffer) Write(p []byte) (int, error) {
	if remaining := visionMediaCommandOutput - b.Len(); remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(remaining, len(p))])
	}
	return len(p), nil
}

func runVisionMediaCommand(parent context.Context, executable string, args []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.WaitDelay = time.Second
	hideVisionMediaProcess(command)
	var stdout, stderr boundedVisionBuffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("媒体处理失败或超过时限")
	}
	return stdout.Bytes(), nil
}

func visionMediaExecutable(name string) (string, error) {
	if name != "ffmpeg" && name != "ffprobe" {
		return "", fmt.Errorf("不支持的媒体处理程序")
	}
	if configured := strings.TrimSpace(os.Getenv(strings.ToUpper(name) + "_PATH")); configured != "" {
		absolute, err := filepath.Abs(configured)
		if err == nil {
			if info, err := os.Stat(absolute); err == nil && info.Mode().IsRegular() {
				return absolute, nil
			}
		}
		return "", fmt.Errorf("%s_PATH 配置无效，请检查本机媒体工具", strings.ToUpper(name))
	}
	suffix := ""
	if os.PathSeparator == '\\' {
		suffix = ".exe"
	}
	var candidates []string
	if executable, err := os.Executable(); err == nil {
		directory := filepath.Dir(executable)
		candidates = append(candidates, filepath.Join(directory, "tools", "ffmpeg", name+suffix), filepath.Join(directory, "..", "backend", "tools", "ffmpeg", name+suffix))
	}
	if directory, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(directory, "tools", "ffmpeg", name+suffix), filepath.Join(directory, "backend", "tools", "ffmpeg", name+suffix))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			absolute, _ := filepath.Abs(candidate)
			return absolute, nil
		}
	}
	if executable, err := exec.LookPath(name); err == nil {
		return executable, nil
	}
	return "", fmt.Errorf("未找到 %s，请配置本机 FFMPEG_PATH 和 FFPROBE_PATH", name)
}
