package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
)

const trimMaxInputBytes int64 = 512 * 1024 * 1024
const trimMaxOutputBytes int64 = 190 * 1024 * 1024
const trimFormats = "mov,matroska,webm,avi"

var localTrimSlots = make(chan struct{}, 1)

type LocalVideoTrimRequest struct {
	MediaURL string
	Start    float64
	End      float64
	Mute     bool
}
type LocalVideoTrimResult struct {
	URL      string  `json:"url"`
	Engine   string  `json:"engine"`
	Duration float64 `json:"duration"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	HasAudio bool    `json:"has_audio"`
}
type trimProbe struct {
	Streams []struct {
		CodecType    string `json:"codec_type"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		Duration     string `json:"duration"`
		AvgFrameRate string `json:"avg_frame_rate"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func validateTrimRange(start, end float64) error {
	if math.IsNaN(start) || math.IsInf(start, 0) || math.IsNaN(end) || math.IsInf(end, 0) ||
		start < 0 || end-start < 0.1 || end-start > 600 || end > 3600 {
		return apperror.New(apperror.CodeInvalidInput, "请选择有效剪辑范围：至少 0.1 秒，单段不超过 10 分钟，结束位置不超过 1 小时")
	}
	return nil
}

// FFmpeg only receives private, bounded, local copies. It never fetches user URLs
// or executes a shell; playlist / concat demuxers and network protocols are disabled.
func (s *Service) TrimLocalVideo(ctx context.Context, req LocalVideoTrimRequest) (*LocalVideoTrimResult, error) {
	if err := validateTrimRange(req.Start, req.End); err != nil {
		return nil, err
	}
	select {
	case localTrimSlots <- struct{}{}:
		defer func() { <-localTrimSlots }()
	default:
		return nil, apperror.New(apperror.CodeRateLimited, "本地剪辑繁忙，请等待当前剪辑完成后再试")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		return nil, err
	}
	ffprobe, err := localMediaExecutable("ffprobe")
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "ccy-video-trim-")
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "无法创建剪辑临时目录", err)
	}
	defer os.RemoveAll(dir) // only this request's newly created temporary directory
	input, output := filepath.Join(dir, "input.media"), filepath.Join(dir, "clip.mp4")
	if err := copyTrimInput(ctx, req.MediaURL, input); err != nil {
		return nil, err
	}
	meta, err := probeTrimVideo(ctx, ffprobe, input)
	if err != nil {
		return nil, err
	}
	duration, _ := strconv.ParseFloat(meta.Format.Duration, 64)
	videoFound := false
	for _, stream := range meta.Streams {
		if stream.CodecType != "video" {
			continue
		}
		videoFound = true
		if d, e := strconv.ParseFloat(stream.Duration, 64); e == nil && d > 0 {
			duration = d
		}
		if stream.Width <= 0 || stream.Height <= 0 || stream.Width > 4096 || stream.Height > 4096 || int64(stream.Width)*int64(stream.Height) > 4096*2160 {
			return nil, apperror.New(apperror.CodeInvalidInput, "当前本地剪辑支持最高 4K 视频")
		}
		break
	}
	if !videoFound || duration <= 0 || math.IsInf(duration, 0) || math.IsNaN(duration) {
		return nil, apperror.New(apperror.CodeInvalidInput, "素材没有可剪辑的视频轨道或有效时长")
	}
	if req.Start >= duration || req.End > duration+0.1 {
		return nil, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("剪辑时间超出视频实际时长（%.3f 秒）", duration))
	}
	req.End = math.Min(req.End, duration)
	if err := validateTrimRange(req.Start, req.End); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, ffmpeg, trimFFmpegArgs(input, output, req)...)
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, apperror.New(apperror.CodeTimeout, "剪辑已取消或超过 5 分钟时限，请缩短片段后重试")
		}
		return nil, apperror.Wrap(apperror.CodeValidation, "FFmpeg 剪辑失败，素材可能损坏或编码不支持", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	stat, err := os.Stat(output)
	if err != nil || stat.Size() == 0 || stat.Size() >= trimMaxOutputBytes {
		return nil, apperror.New(apperror.CodeRequestTooLarge, "剪辑结果为空或超过 190 MB，请缩短片段")
	}
	resultMeta, err := probeTrimVideo(ctx, ffprobe, output)
	if err != nil {
		return nil, err
	}
	result := &LocalVideoTrimResult{Engine: "ffmpeg"}
	result.Duration, _ = strconv.ParseFloat(resultMeta.Format.Duration, 64)
	for _, stream := range resultMeta.Streams {
		if stream.CodecType == "video" {
			result.Width, result.Height = stream.Width, stream.Height
		}
		if stream.CodecType == "audio" {
			result.HasAudio = true
		}
	}
	if result.Width == 0 || math.Abs(result.Duration-(req.End-req.Start)) > 0.3 {
		return nil, apperror.New(apperror.CodeValidation, "导出视频时长校验失败，请重试较短片段")
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
	result.URL = staged.StagingURL
	return result, nil
}

func localMediaExecutable(name string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv(strings.ToUpper(name) + "_PATH")); configured != "" {
		if stat, err := os.Stat(configured); err == nil && !stat.IsDir() {
			return configured, nil
		}
		return "", apperror.New(apperror.CodeValidation, strings.ToUpper(name)+"_PATH 配置无效")
	}
	suffix := ""
	if os.PathSeparator == '\\' {
		suffix = ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "tools", "ffmpeg", name+suffix)
		if stat, err := os.Stat(candidate); err == nil && !stat.IsDir() {
			return candidate, nil
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	return "", apperror.New(apperror.CodeValidation, "未安装 "+name+"，请配置本机 FFmpeg 工具目录")
}

func trimFFmpegArgs(input, output string, req LocalVideoTrimRequest) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-format_whitelist", trimFormats,
		"-threads", "2", "-ss", strconv.FormatFloat(req.Start, 'f', 6, 64), "-i", input,
		"-t", strconv.FormatFloat(req.End-req.Start, 'f', 6, 64), "-map", "0:v:0"}
	if !req.Mute {
		args = append(args, "-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k")
	} else {
		args = append(args, "-an")
	}
	return append(args, "-sn", "-dn", "-map_metadata", "-1",
		"-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
		"-threads", "4", "-filter_threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
		"-fs", strconv.FormatInt(trimMaxOutputBytes, 10), output)
}

type limitedTrimBuffer struct{ bytes.Buffer }

func (b *limitedTrimBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 64*1024 - b.Len(); remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(remaining, n)])
	}
	return n, nil
}

func probeTrimVideo(ctx context.Context, exe, path string) (*trimProbe, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", trimFormats,
		"-threads", "2", "-show_entries", "format=duration:stream=codec_type,width,height,duration,avg_frame_rate", "-of", "json", path)
	hideMediaProcess(cmd)
	var stdout, stderr limitedTrimBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, apperror.Wrap(apperror.CodeValidation, "无法读取视频：支持 MP4/MOV/WebM/MKV/AVI，请确认素材完整", err)
	}
	var meta trimProbe
	if err := json.Unmarshal(stdout.Bytes(), &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func copyTrimInput(ctx context.Context, raw, destination string) error {
	raw = strings.TrimSpace(raw)
	var reader io.ReadCloser
	if strings.HasPrefix(raw, "/uploads/") {
		parsed, err := url.Parse(raw)
		if err != nil || strings.ContainsAny(parsed.Path, "\\:") {
			return apperror.New(apperror.CodeInvalidInput, "无效的素材路径")
		}
		// Strictly restrict access to the configured public upload root, including symlinks.
		root, err := filepath.EvalSymlinks(uploadRoot())
		if err != nil {
			return apperror.New(apperror.CodeInvalidInput, "本地素材目录不可用")
		}
		root, _ = filepath.Abs(root)
		candidate, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(parsed.Path, "/uploads/"))))
		if err != nil {
			return apperror.New(apperror.CodeInvalidInput, "本地视频不存在，请重新上传")
		}
		relative, err := filepath.Rel(root, candidate)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
			return apperror.New(apperror.CodeInvalidInput, "无效的素材路径")
		}
		f, err := os.Open(candidate)
		if err != nil {
			return apperror.New(apperror.CodeInvalidInput, "无法读取本地视频")
		}
		reader = f
	} else {
		if err := safehttp.ValidatePublicURL(raw); err != nil {
			return apperror.New(apperror.CodeInvalidInput, "请使用已上传的视频或公开 HTTPS 视频地址")
		}
		signed, err := assetstore.PresignGet(ctx, raw, 5*time.Minute)
		if err != nil {
			return apperror.New(apperror.CodeInvalidInput, "视频授权失败，请重新上传素材")
		}
		if signed != "" {
			raw = signed
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			return apperror.New(apperror.CodeInvalidInput, "无效的视频地址")
		}
		resp, err := safehttp.Client(90 * time.Second).Do(req)
		if err != nil {
			return apperror.New(apperror.CodeValidation, "视频下载失败，请检查素材是否已过期")
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return apperror.New(apperror.CodeValidation, fmt.Sprintf("视频下载失败（HTTP %d）", resp.StatusCode))
		}
		reader = resp.Body
	}
	defer reader.Close()
	f, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, io.LimitReader(reader, trimMaxInputBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return apperror.New(apperror.CodeValidation, "视频读取中断，请重试")
	}
	if closeErr != nil {
		return closeErr
	}
	if n == 0 || n > trimMaxInputBytes {
		return apperror.New(apperror.CodeRequestTooLarge, "视频为空或超过 512 MB 限制")
	}
	return nil
}
