package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
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

// PreflightGeneration performs only provider selection and local validation.
// The HTTP handler calls this before credits, task rows, or queue submission.
// It never downloads, uploads, signs media, or invokes a generation provider.
func (s *Service) PreflightGeneration(ctx context.Context, req GenerateRequest) error {
	if req.ServiceType == "image" && isSeedreamPro(req.Model) {
		candidates, err := s.buildCandidates(req)
		if err != nil {
			return err
		}
		if isVolcengine(candidates[0].cfg) && !isTSProvider(candidates[0].cfg) {
			_, _, _, err = seedreamProOptions(req)
			return err
		}
		return nil
	}
	if req.ServiceType != "video" {
		return nil
	}
	if _, known := hopBaseSeedanceCapabilitiesFor(req.Model); !known {
		return nil
	}
	candidates, err := s.buildCandidates(req)
	if err != nil {
		return err
	}
	selected := candidates[0]
	if !isHopBaseProvider(selected.cfg, selected.baseURL) || isTSProvider(selected.cfg) {
		return nil
	}
	return validateHopBaseReferences(ctx, req)
}

// This validation also runs at the adapter entry, before the first media GET
// or upload. The same checks protect HTTP submissions and non-HTTP callers.
func validateHopBaseReferences(ctx context.Context, req GenerateRequest) error {
	caps, known := hopBaseSeedanceCapabilitiesFor(req.Model)
	if !known {
		return apperror.New(apperror.CodeInvalidInput, "HopBase 当前仅支持已登记的 Seedance 2.5 / 2.0 型号")
	}
	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))
	if resolution != "" {
		if _, ok := caps.resolutions[resolution]; !ok {
			return apperror.New(apperror.CodeInvalidInput, "此 Seedance 型号不支持所选分辨率")
		}
	}
	ratio := strings.ToLower(strings.TrimSpace(req.AspectRatio))
	if ratio == "" {
		ratio = strings.ToLower(strings.TrimSpace(req.Size))
	}
	if ratio != "" && ratio != "auto" && !hopBaseRatioAllowed(ratio) {
		return apperror.New(apperror.CodeInvalidInput, "Seedance 视频比例无效")
	}
	if caps.is25 && req.Duration != 0 && req.Duration != -1 && (req.Duration < 4 || req.Duration > 30) {
		return apperror.New(apperror.CodeInvalidInput, "Seedance 2.5 时长须为 4–30 秒或 -1")
	}
	videos, audios := collectArkReferenceVideos(req), collectHopBaseReferenceAudios(req)
	if len(req.ReferenceImages) > caps.maxImages || len(videos) > caps.maxVideos || len(audios) > caps.maxAudios {
		return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("此型号最多支持 %d 张图片、%d 条视频、%d 条音频", caps.maxImages, caps.maxVideos, caps.maxAudios))
	}
	if !caps.is25 && len(audios) > 0 && len(req.ReferenceImages) == 0 && len(videos) == 0 {
		return apperror.New(apperror.CodeInvalidInput, "Seedance 2.0 音频参考必须同时提供图片或视频参考")
	}
	mode := strings.ToLower(strings.TrimSpace(req.ReferenceMode))
	frameMode := mode == "start_end" || mode == "first_frame" || mode == "start_frame"
	if frameMode && (len(req.ReferenceImages) == 0 || len(req.ReferenceImages) > 2 || len(videos) > 0 || len(audios) > 0) {
		return apperror.New(apperror.CodeInvalidInput, "首帧/首尾帧模式需要 1–2 张图片，不能混入视频或音频参考")
	}
	if (mode == "first_frame" || mode == "start_frame") && len(req.ReferenceImages) != 1 {
		return apperror.New(apperror.CodeInvalidInput, "首帧模式需要恰好 1 张图片")
	}
	if strings.TrimSpace(req.Prompt) == "" && len(req.ReferenceImages)+len(videos)+len(audios) == 0 {
		return apperror.New(apperror.CodeInvalidInput, "提示词或参考素材至少需要提供一项")
	}
	var localAudioSeconds float64
	audioDurationCap := 15.0
	if caps.is25 {
		audioDurationCap = 30
	}
	for _, batch := range []struct {
		kind string
		urls []string
	}{{"图片", req.ReferenceImages}, {"视频", videos}, {"音频", audios}} {
		for index, raw := range batch.urls {
			raw = strings.TrimSpace(raw)
			if strings.HasPrefix(raw, "asset://") && batch.kind == "图片" && !caps.is25 {
				continue
			}
			if strings.HasPrefix(raw, "/uploads/") {
				path, err := hopBaseLocalReferencePath(raw)
				if err != nil {
					return apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考%s #%d 无法使用", batch.kind, index+1), err)
				}
				if batch.kind == "音频" {
					seconds, err := probeHopBaseLocalAudio(ctx, path, audioDurationCap)
					if err != nil {
						return err
					}
					localAudioSeconds += seconds
				}
				// Validate the configuration without initializing the store or
				// contacting it. Actual transfer is deferred to an explicit run.
				backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
				if backend != "oss" && backend != "cos" {
					return apperror.New(apperror.CodeInvalidInput, "本地参考素材可预览；远端生成前需配置 OSS/COS 以提供可下载地址")
				}
				continue
			}
			parsed, err := url.Parse(raw)
			if err != nil || parsed.User != nil || safehttp.ValidatePublicURL(raw) != nil {
				return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("参考%s #%d 需使用已存在的 /uploads/ 文件或无用户名密码的公开 HTTP(S) 地址", batch.kind, index+1))
			}
		}
	}
	if localAudioSeconds > audioDurationCap+0.01 {
		return apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("本地参考音频合计 %.2f 秒，超过此型号 %.0f 秒上限", localAudioSeconds, audioDurationCap))
	}
	return nil
}

// Resolve only regular files under uploads, rejecting traversal, Windows ADS,
// encoded backslashes, directories, and symlink/junction escapes.
func hopBaseLocalReferencePath(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(parsed.Path, "/uploads/") || strings.ContainsAny(parsed.Path, "\\:\x00") {
		return "", fmt.Errorf("无效的本地素材路径")
	}
	root, err := filepath.EvalSymlinks(uploadRoot())
	if err != nil {
		return "", fmt.Errorf("本地素材目录不可用")
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("本地素材目录无效")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(parsed.Path, "/uploads/"))))
	if err != nil {
		return "", fmt.Errorf("本地素材不存在")
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("本地素材超出 uploads 目录")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return "", fmt.Errorf("本地素材须为非空普通文件")
	}
	return path, nil
}

func probeHopBaseLocalAudio(ctx context.Context, path string, durationCap float64) (float64, error) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > 15*1024*1024 {
		return 0, apperror.New(apperror.CodeInvalidInput, "Seedance 参考音频单文件不能超过 15 MB")
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".wav" && ext != ".mp3" {
		return 0, apperror.New(apperror.CodeInvalidInput, "Seedance 参考音频仅支持 WAV/MP3")
	}
	probe, err := localMediaExecutable("ffprobe")
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, probe, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "wav,mp3",
		"-show_entries", "format=duration,format_name:stream=codec_type", "-of", "json", path)
	hideMediaProcess(cmd)
	var stdout, stderr limitedTrimBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return 0, apperror.New(apperror.CodeInvalidInput, "参考音频无法解码，请使用完整的 WAV/MP3 文件")
	}
	var meta struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Type string `json:"codec_type"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &meta); err != nil {
		return 0, apperror.New(apperror.CodeInvalidInput, "参考音频信息不可读")
	}
	seconds, err := strconv.ParseFloat(meta.Format.Duration, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 2 || seconds > durationCap+0.01 || len(meta.Streams) == 0 {
		return 0, apperror.New(apperror.CodeInvalidInput, fmt.Sprintf("参考音频须为 2–%.0f 秒", durationCap))
	}
	for _, stream := range meta.Streams {
		if stream.Type != "audio" {
			return 0, apperror.New(apperror.CodeInvalidInput, "参考音频不能包含视频流")
		}
	}
	return seconds, nil
}

// Swappable only for offline tests: the production implementation uses the
// existing asset store. Preflight never invokes this function.
var uploadHopBaseLocalReference = assetstore.UploadFile

// HopBase accepts an MP4 container, but some relay deployments reject MOV
// files containing HEVC even though the public contract lists MOV as allowed.
// Normalize non-MP4 references once, before submitting a paid task, so one
// incompatible asset does not turn a batch into a partial 400 failure.
var hopBaseTranscodeSlots = make(chan struct{}, 2)

func shouldNormalizeHopBaseVideo(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	ext := strings.ToLower(filepath.Ext(parsed.Path))
	return ext != "" && ext != ".mp4"
}

func normalizeHopBaseVideoReference(ctx context.Context, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !shouldNormalizeHopBaseVideo(raw) {
		return raw, nil
	}
	select {
	case hopBaseTranscodeSlots <- struct{}{}:
		defer func() { <-hopBaseTranscodeSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	ffmpeg, err := localMediaExecutable("ffmpeg")
	if err != nil {
		return "", err
	}
	ffprobe, err := localMediaExecutable("ffprobe")
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "ccy-hopbase-video-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "input.media")
	output := filepath.Join(dir, "reference.mp4")
	if err := copyTrimInput(ctx, raw, input); err != nil {
		return "", err
	}
	if _, err := probeTrimVideo(ctx, ffprobe, input); err != nil {
		return "", apperror.Wrap(apperror.CodeInvalidInput, "参考视频无法读取，请重新上传 MP4 视频", err)
	}
	transcodeCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(transcodeCtx, ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-format_whitelist", trimFormats,
		"-threads", "2", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k",
		"-sn", "-dn", "-map_metadata", "-1", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "4",
		"-filter_threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
		"-fs", strconv.FormatInt(trimMaxOutputBytes, 10), output)
	hideMediaProcess(cmd)
	var stderr limitedTrimBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if transcodeCtx.Err() != nil {
			return "", apperror.New(apperror.CodeTimeout, "参考视频转换超时，请缩短素材后重试")
		}
		return "", apperror.Wrap(apperror.CodeValidation, "参考视频编码不兼容，自动转换失败，请上传 H.264 MP4", fmt.Errorf("%w: %s", err, stderr.String()))
	}
	file, err := os.Open(output)
	if err != nil {
		return "", err
	}
	defer file.Close()
	staged, err := writeStagedAsset(file, ".mp4", "video/mp4")
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, "保存转换后的参考视频失败", err)
	}
	return staged.StagingURL, nil
}

func hopBaseReferenceMediaURL(ctx context.Context, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "/uploads/") {
		return arkReferenceMediaURL(ctx, raw)
	}
	path, err := hopBaseLocalReferencePath(raw)
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(path))
	contentType := mime.TypeByExtension(ext)
	// Windows MIME registrations vary by installed desktop applications.
	// Use stable audio types for the provider's two accepted formats.
	if ext == ".wav" {
		contentType = "audio/wav"
	} else if ext == ".mp3" {
		contentType = "audio/mpeg"
	}
	key := "references/hopbase/" + hex.EncodeToString(hash.Sum(nil)) + ext
	publicURL, err := uploadHopBaseLocalReference(ctx, key, path, contentType)
	if err != nil {
		return "", fmt.Errorf("参考素材上传到已配置对象存储失败: %w", err)
	}
	return arkReferenceMediaURL(ctx, publicURL)
}
