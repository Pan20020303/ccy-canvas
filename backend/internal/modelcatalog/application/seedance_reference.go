package application

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"io"
	"os"
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
)

// Seedance accepts image_url.url as a public URL, an image Data URL, or an
// asset:// ID. Videos use a separate, URL-only path. See:
// https://doc.dmxapi.cn/doubao-seedance-2-0-multimodal-reference-video.html
const seedanceMaxInlineImageBytes = 30 << 20

// seedanceInlineImageURL handles images stored on this server or embedded in
// canvas state. It never requires an object store to submit a local image.
func seedanceInlineImageURL(raw string) (string, error) {
	var data []byte
	if strings.HasPrefix(raw, "data:") {
		header, encoded, ok := strings.Cut(raw, ",")
		if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
			return "", apperror.New(apperror.CodeInvalidInput, "参考图须为 image 类型的 Base64 Data URL，请重新上传图片")
		}
		if len(encoded) > base64.StdEncoding.EncodedLen(seedanceMaxInlineImageBytes) {
			return "", apperror.New(apperror.CodeInvalidInput, "参考图超过 30 MB，请压缩后重试")
		}
		var err error
		data, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考图 Base64 数据无效，请重新上传图片", err)
		}
	} else {
		// Keep disk reads restricted to the application's upload namespace.
		if !strings.HasPrefix(raw, "/uploads/") {
			return "", apperror.New(apperror.CodeInvalidInput, "参考图须为上传图片、图片链接或 Base64 图片")
		}
		path, _, _ := strings.Cut(raw, "?")
		path, _, _ = strings.Cut(path, "#")
		diskPath, err := resolveUploadDiskPath(path)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "本地参考图不存在或已失效，请重新上传图片", err)
		}
		file, err := os.Open(diskPath)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "本地参考图读取失败，请重新上传图片", err)
		}
		defer file.Close()
		data, err = io.ReadAll(io.LimitReader(file, seedanceMaxInlineImageBytes+1))
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "本地参考图读取失败，请重新上传图片", err)
		}
	}
	if len(data) > seedanceMaxInlineImageBytes {
		return "", apperror.New(apperror.CodeInvalidInput, "参考图超过 30 MB，请压缩后重试")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInvalidInput, "参考图无法解码，请上传有效的 JPEG、PNG、WebP、BMP、TIFF 或 GIF 图片", err)
	}
	ratio := float64(cfg.Width) / float64(cfg.Height)
	if ratio < 0.4 || ratio > 2.5 {
		return "", apperror.New(apperror.CodeInvalidInput, "参考图宽高比须在 0.4～2.5 之间，请裁剪后重试")
	}
	if cfg.Width < arkRefMinDim || cfg.Height < arkRefMinDim || cfg.Width > arkRefMaxDim || cfg.Height > arkRefMaxDim {
		// Avoid unbounded decoding of compressed images with enormous dimensions.
		if int64(cfg.Width)*int64(cfg.Height) > 64_000_000 {
			return "", apperror.New(apperror.CodeInvalidInput, "参考图像素过大，请缩小到每边不超过 6000 像素后重试")
		}
		src, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考图已损坏，请重新上传图片", err)
		}
		normalized, err := resizeToArkBounds(src)
		if err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考图尺寸无法调整，请裁剪后重试", err)
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, normalized, &jpeg.Options{Quality: 92}); err != nil {
			return "", apperror.Wrap(apperror.CodeInvalidInput, "参考图转换失败，请重新上传图片", err)
		}
		data, format = buf.Bytes(), "jpeg"
	}
	if len(data) > seedanceMaxInlineImageBytes {
		return "", apperror.New(apperror.CodeInvalidInput, "处理后的参考图超过 30 MB，请压缩后重试")
	}
	return "data:image/" + format + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func seedanceReferenceImageError(index int, err error) error {
	message := "无法读取或处理图片，请检查图片链接或重新上传"
	// Preserve only explicitly safe application messages, never raw file paths,
	// signed URLs, credentials, or provider diagnostics.
	if appErr, ok := err.(*apperror.Error); ok && appErr.Code == apperror.CodeInvalidInput {
		message = apperror.PublicMessage(appErr)
	}
	return apperror.Wrap(apperror.CodeInvalidInput, fmt.Sprintf("参考图 #%d 处理失败：%s", index+1, message), err)
}
