package application

import (
	"ccy-canvas/backend/internal/shared/apperror"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const editorFormats = "mov,matroska,webm,avi,mp3,wav,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,image2"

type VideoEditClip struct {
	MediaURL string   `json:"media_url" minLength:"1" maxLength:"8192"`
	Kind     string   `json:"kind" enum:"video,image,audio"`
	Start    float64  `json:"start"`
	End      float64  `json:"end"`
	Speed    float64  `json:"speed"`
	Volume   float64  `json:"volume"`
	At       float64  `json:"at,omitempty"`
	Track    int      `json:"track,omitempty"`
	Scale    *float64 `json:"scale,omitempty"`
	X        *float64 `json:"x,omitempty"`
	Y        *float64 `json:"y,omitempty"`
}
type LocalVideoEditRequest struct {
	FreeTimeline bool            `json:"free_timeline,omitempty"`
	MultiTrack   bool            `json:"multi_track,omitempty"`
	Clips        []VideoEditClip `json:"clips" minItems:"1" maxItems:"32"`
	Audio        []VideoEditClip `json:"audio,omitempty" maxItems:"8"`
	Width        int             `json:"width"`
	Height       int             `json:"height"`
	FPS          int             `json:"fps"`
	NodeID       string          `json:"node_id" minLength:"1" maxLength:"200"`
}

func editorSeconds(n float64) string { return strconv.FormatFloat(n, 'f', 6, 64) }
func validateVideoEdit(req LocalVideoEditRequest) (float64, error) {
	bad := func() (float64, error) {
		return 0, apperror.New(apperror.CodeInvalidInput, "剪辑参数无效：最多 32 个画面、8 个音频片段，成片最长 10 分钟")
	}
	if len(req.Clips) == 0 || len(req.Clips) > 32 || len(req.Audio) > 8 {
		return bad()
	}
	if req.MultiTrack && !req.FreeTimeline {
		return bad()
	}
	sizes := map[[2]int]bool{{1280, 720}: true, {720, 1280}: true, {720, 720}: true, {1920, 1080}: true, {1080, 1920}: true, {1080, 1080}: true}
	if !sizes[[2]int{req.Width, req.Height}] || (req.FPS != 24 && req.FPS != 30) {
		return bad()
	}
	total := 0.0
	for i, c := range append(append([]VideoEditClip{}, req.Clips...), req.Audio...) {
		for _, v := range []float64{c.Start, c.End, c.Speed, c.Volume, c.At} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return bad()
			}
		}
		if c.Start < 0 || c.End-c.Start < .099999 || c.End > 3600 || c.Speed < .5 || c.Speed > 2 || c.Volume < 0 || c.Volume > 1 || c.At < 0 {
			return bad()
		}
		if i < len(req.Clips) {
			scale, x, y := editorLayerTransform(c)
			if c.Track < 0 || c.Track > 7 || !isFinitePositive(scale) || scale < .1 || scale > 1 || math.IsNaN(x) || math.IsNaN(y) || x < 0 || x > 1 || y < 0 || y > 1 {
				return bad()
			}
			if !req.MultiTrack && (c.Track != 0 || scale != 1 || x != .5 || y != .5) {
				return bad()
			}
			if c.Kind != "video" && c.Kind != "image" {
				return bad()
			}
			if req.FreeTimeline {
				total = math.Max(total, c.At+(c.End-c.Start)/c.Speed)
			} else {
				total += (c.End - c.Start) / c.Speed
			}
		} else if c.Kind != "audio" {
			return bad()
		}
	}
	if req.FreeTimeline {
		clips := append([]VideoEditClip{}, req.Clips...)
		sort.SliceStable(clips, func(i, j int) bool { return clips[i].At < clips[j].At })
		var end [8]float64
		for _, c := range clips {
			if c.At < end[c.Track]-1e-6 {
				return 0, apperror.New(apperror.CodeInvalidInput, "同一画面轨道的片段不能重叠")
			}
			end[c.Track] = c.At + (c.End-c.Start)/c.Speed
		}
		for _, c := range req.Audio {
			total = math.Max(total, c.At+(c.End-c.Start)/c.Speed)
		}
	}
	if total < .1 || total > 600 {
		return bad()
	}
	for _, c := range req.Audio {
		if c.At >= total {
			return bad()
		}
	}
	return total, nil
}
func probeEditorMedia(ctx context.Context, exe, path string) (*trimProbe, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", editorFormats,
		"-threads", "2", "-show_entries", "format=duration:stream=codec_type,width,height,duration,avg_frame_rate", "-of", "json", path)
	hideMediaProcess(cmd)
	var out limitedTrimBuffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, apperror.New(apperror.CodeValidation, "素材无法解析，请使用完整的 MP4、PNG/JPG/WebP 或 MP3/WAV 文件")
	}
	var meta trimProbe
	if err := json.Unmarshal(out.Bytes(), &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}
func checkEditorSource(c VideoEditClip, meta *trimProbe) (bool, error) {
	hasVideo, hasAudio := false, false
	duration, _ := strconv.ParseFloat(meta.Format.Duration, 64)
	for _, s := range meta.Streams {
		if s.CodecType == "video" {
			hasVideo = true
			if s.Width < 1 || s.Height < 1 || s.Width > 8192 || s.Height > 8192 || int64(s.Width)*int64(s.Height) > 33554432 {
				return false, apperror.New(apperror.CodeInvalidInput, "素材画面过大，请先缩小到 8K 以内")
			}
			if d, e := strconv.ParseFloat(s.Duration, 64); e == nil && d > 0 && c.Kind == "video" {
				duration = d
			}
		}
		if s.CodecType == "audio" {
			hasAudio = true
		}
	}
	if (c.Kind == "audio" && !hasAudio) || (c.Kind != "audio" && !hasVideo) {
		return false, apperror.New(apperror.CodeInvalidInput, "素材类型和实际轨道不匹配")
	}
	if c.Kind != "image" && (!isFinitePositive(duration) || c.End > duration+.12) {
		return false, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("素材剪辑出点超过实际时长（%.2f 秒）", duration))
	}
	return hasAudio, nil
}
func isFinitePositive(v float64) bool { return v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }

func editorSegmentArgs(path, output string, c VideoEditClip, hasAudio bool, req LocalVideoEditRequest) []string {
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", "2", "-protocol_whitelist", "file"}
	if c.Kind == "image" {
		args = append(args, "-f", "image2", "-pattern_type", "none", "-loop", "1", "-framerate", strconv.Itoa(req.FPS))
	} else {
		args = append(args, "-format_whitelist", editorFormats, "-ss", editorSeconds(c.Start))
	}
	args = append(args, "-i", path)
	if !hasAudio || c.Kind == "image" || c.Volume == 0 {
		args = append(args, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0")
	} else {
		args = append(args, "-map", "0:v:0", "-map", "0:a:0")
	}
	duration := (c.End - c.Start) / c.Speed
	vf := fmt.Sprintf("setpts=(PTS-STARTPTS)/%s,scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%d", editorSeconds(c.Speed), req.Width, req.Height, req.Width, req.Height, req.FPS)
	// Keep padding finite; output -t alone need not stop an infinite filter.
	af := "atrim=duration=" + editorSeconds(c.End-c.Start) + ",asetpts=PTS-STARTPTS,atempo=" + editorSeconds(c.Speed) + ",volume=" + editorSeconds(c.Volume) + ",aresample=48000,apad=whole_dur=" + editorSeconds(duration) + ",atrim=duration=" + editorSeconds(duration)
	return append(args, "-t", editorSeconds(duration), "-vf", vf, "-af", af, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-threads", "4", "-filter_threads", "1", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-sn", "-dn", "-map_metadata", "-1", "-fs", "536870912", output)
}
func runEditorCommand(ctx context.Context, exe string, args []string) error {
	cmd := exec.CommandContext(ctx, exe, args...)
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return apperror.New(apperror.CodeTimeout, "剪辑导出已取消或超过 8 分钟，请降低分辨率或缩短工程")
		}
		return apperror.Wrap(apperror.CodeValidation, "FFmpeg 合成失败，请检查素材编码或缩短片段", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	return nil
}
func editorBlackGapArgs(output string, duration float64, req LocalVideoEditRequest) []string {
	return []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
		fmt.Sprintf("color=c=black:s=%dx%d:r=%d:d=%s", req.Width, req.Height, req.FPS, editorSeconds(duration)),
		"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", editorSeconds(duration),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "4", "-filter_threads", "1",
		"-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-shortest", "-fs", "536870912", output}
}
func (s *Service) EditLocalVideo(ctx context.Context, req LocalVideoEditRequest) (*LocalVideoTrimResult, error) {
	total, err := validateVideoEdit(req)
	if err != nil {
		return nil, err
	}
	select {
	case localTrimSlots <- struct{}{}:
		defer func() { <-localTrimSlots }()
	default:
		return nil, apperror.New(apperror.CodeRateLimited, "本地剪辑繁忙，请等待当前导出完成")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		return nil, err
	}
	ffprobe, err := localMediaExecutable("ffprobe")
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "ccy-video-editor-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	type source struct {
		path string
		meta *trimProbe
	}
	sources := map[string]source{}
	var inputBytes, tempBytes int64
	getSource := func(c VideoEditClip) (source, error) {
		if cached, ok := sources[c.MediaURL]; ok {
			return cached, nil
		}
		path := filepath.Join(dir, fmt.Sprintf("input-%03d.media", len(sources)))
		if err := copyTrimInput(ctx, c.MediaURL, path); err != nil {
			return source{}, err
		}
		stat, err := os.Stat(path)
		if err != nil {
			return source{}, err
		}
		inputBytes += stat.Size()
		if inputBytes > 1024*1024*1024 {
			return source{}, apperror.New(apperror.CodeRequestTooLarge, "工程输入素材总大小超过 1 GB")
		}
		meta, err := probeEditorMedia(ctx, ffprobe, path)
		if err != nil {
			return source{}, err
		}
		result := source{path, meta}
		sources[c.MediaURL] = result
		return result, nil
	}
	if req.MultiTrack {
		clips := append([]VideoEditClip{}, req.Clips...)
		sort.SliceStable(clips, func(i, j int) bool {
			if clips[i].Track != clips[j].Track {
				return clips[i].Track < clips[j].Track
			}
			return clips[i].At < clips[j].At
		})
		var layers []editorLayerSource
		for _, c := range append(clips, req.Audio...) {
			src, err := getSource(c)
			if err != nil {
				return nil, err
			}
			hasAudio, err := checkEditorSource(c, src.meta)
			if err != nil {
				return nil, err
			}
			layers = append(layers, editorLayerSource{clip: c, path: src.path, hasAudio: hasAudio})
		}
		output := filepath.Join(dir, "edited.mp4")
		if err := runEditorCommand(ctx, ffmpeg, editorMultiTrackArgs(layers, output, req, total)); err != nil {
			return nil, err
		}
		return finishEditorVideo(ctx, ffprobe, output, req, total)
	}
	var manifest strings.Builder
	clips := append([]VideoEditClip{}, req.Clips...)
	if req.FreeTimeline {
		sort.SliceStable(clips, func(i, j int) bool { return clips[i].At < clips[j].At })
	}
	cursor, gapIndex := 0.0, 0
	appendGap := func(duration float64) error {
		if duration < 1e-6 {
			return nil
		}
		name := fmt.Sprintf("gap-%03d.mkv", gapIndex)
		gapIndex++
		output := filepath.Join(dir, name)
		if err := runEditorCommand(ctx, ffmpeg, editorBlackGapArgs(output, duration, req)); err != nil {
			return err
		}
		stat, err := os.Stat(output)
		if err != nil {
			return err
		}
		tempBytes += stat.Size()
		if stat.Size() >= 512*1024*1024 || tempBytes > 1536*1024*1024 {
			return apperror.New(apperror.CodeRequestTooLarge, "剪辑临时文件过大")
		}
		fmt.Fprintf(&manifest, "file '%s'\n", name)
		return nil
	}
	for i, c := range clips {
		if req.FreeTimeline {
			if err := appendGap(c.At - cursor); err != nil {
				return nil, err
			}
			cursor = c.At
		}
		src, err := getSource(c)
		if err != nil {
			return nil, err
		}
		audio, err := checkEditorSource(c, src.meta)
		if err != nil {
			return nil, err
		}
		segmentName := fmt.Sprintf("segment-%03d.mkv", i)
		output := filepath.Join(dir, segmentName)
		if err := runEditorCommand(ctx, ffmpeg, editorSegmentArgs(src.path, output, c, audio, req)); err != nil {
			return nil, err
		}
		stat, err := os.Stat(output)
		if err != nil {
			return nil, err
		}
		tempBytes += stat.Size()
		if stat.Size() >= 512*1024*1024 || tempBytes > 1536*1024*1024 {
			return nil, apperror.New(apperror.CodeRequestTooLarge, "剪辑临时文件过大，请降低分辨率或缩短工程")
		}
		meta, err := probeEditorMedia(ctx, ffprobe, output)
		if err != nil {
			return nil, err
		}
		d, _ := strconv.ParseFloat(meta.Format.Duration, 64)
		if math.Abs(d-(c.End-c.Start)/c.Speed) > .2 {
			return nil, apperror.New(apperror.CodeValidation, "片段时长校验失败，素材可能提前结束")
		}
		// Trusted manifest: only generated basenames, never user paths or directives.
		fmt.Fprintf(&manifest, "file '%s'\n", segmentName)
		cursor += (c.End - c.Start) / c.Speed
	}
	if req.FreeTimeline {
		if err := appendGap(total - cursor); err != nil {
			return nil, err
		}
	}
	manifestPath := filepath.Join(dir, "segments.txt")
	if err := os.WriteFile(manifestPath, []byte(manifest.String()), 0600); err != nil {
		return nil, err
	}
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-protocol_whitelist", "file", "-i", manifestPath}
	var filters []string
	mix := "[0:a]"
	for i, c := range req.Audio {
		src, err := getSource(c)
		if err != nil {
			return nil, err
		}
		if _, err := checkEditorSource(c, src.meta); err != nil {
			return nil, err
		}
		args = append(args, "-protocol_whitelist", "file", "-format_whitelist", editorFormats, "-ss", editorSeconds(c.Start), "-i", src.path)
		label := fmt.Sprintf("bg%d", i)
		filters = append(filters, fmt.Sprintf("[%d:a:0]atrim=duration=%s,asetpts=PTS-STARTPTS,atempo=%s,volume=%s,aresample=48000,aformat=channel_layouts=stereo,adelay=%d|%d[%s]", i+1, editorSeconds(c.End-c.Start), editorSeconds(c.Speed), editorSeconds(c.Volume), int(c.At*1000), int(c.At*1000), label))
		mix += "[" + label + "]"
	}
	if len(req.Audio) > 0 {
		filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=1[mixed]", mix, len(req.Audio)+1))
		args = append(args, "-filter_complex", strings.Join(filters, ";"), "-filter_complex_threads", "1", "-map", "0:v:0", "-map", "[mixed]")
	} else {
		args = append(args, "-map", "0:v:0", "-map", "0:a:0")
	}
	output := filepath.Join(dir, "edited.mp4")
	args = append(args, "-t", editorSeconds(total), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-fs", strconv.FormatInt(trimMaxOutputBytes, 10), output)
	if err := runEditorCommand(ctx, ffmpeg, args); err != nil {
		return nil, err
	}
	return finishEditorVideo(ctx, ffprobe, output, req, total)
}
func finishEditorVideo(ctx context.Context, ffprobe, output string, req LocalVideoEditRequest, total float64) (*LocalVideoTrimResult, error) {
	stat, err := os.Stat(output)
	if err != nil {
		return nil, err
	}
	if stat.Size() == 0 || stat.Size() >= trimMaxOutputBytes {
		return nil, apperror.New(apperror.CodeRequestTooLarge, "成片超过 190 MB，请降低分辨率或缩短工程")
	}
	meta, err := probeEditorMedia(ctx, ffprobe, output)
	if err != nil {
		return nil, err
	}
	duration, _ := strconv.ParseFloat(meta.Format.Duration, 64)
	if math.Abs(duration-total) > .5 {
		return nil, apperror.New(apperror.CodeValidation, "成片时长校验失败")
	}
	file, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	staged, err := writeStagedAsset(file, ".mp4", "video/mp4")
	if err != nil {
		return nil, err
	}
	return &LocalVideoTrimResult{URL: staged.StagingURL, Engine: "ffmpeg", Duration: duration, Width: req.Width, Height: req.Height, HasAudio: true}, nil
}
