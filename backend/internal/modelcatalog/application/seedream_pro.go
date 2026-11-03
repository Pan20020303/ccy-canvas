package application

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"ccy-canvas/backend/internal/shared/apperror"
)

// https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
// Pro's 0.92–4.62MP limits differ from Lite/4.5; fixed ratios need pixels.
var seedreamProSizes = map[string]map[string]string{
	"1K":   {"1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1280x720", "9:16": "720x1280", "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672"},
	"1.5K": {"1:1": "1536x1536", "4:3": "1792x1344", "3:4": "1344x1792", "16:9": "2048x1152", "9:16": "1152x2048", "3:2": "1872x1248", "2:3": "1248x1872", "21:9": "2352x1008"},
	"2K":   {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584", "9:16": "1584x2816", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344"},
}

func isSeedreamPro(model string) bool {
	return strings.Contains(strings.ReplaceAll(strings.ToLower(model), ".", "-"), "seedream-5-0-pro")
}

func seedreamProImageSize(size, resolution string) (string, error) {
	size = strings.ToLower(strings.TrimSpace(size))
	if strings.Contains(size, "x") {
		parts := strings.Split(size, "x")
		if len(parts) == 2 {
			w, ew := strconv.ParseInt(parts[0], 10, 32)
			h, eh := strconv.ParseInt(parts[1], 10, 32)
			if ew == nil && eh == nil && w > 0 && h > 0 && w <= 4624220/h && w*h >= 921600 && float64(w)/float64(h) >= 1.0/16 && float64(w)/float64(h) <= 16 {
				return fmt.Sprintf("%dx%d", w, h), nil
			}
		}
		return "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 自定义尺寸须为宽x高，总像素 921600–4624220，宽高比 1:16–16:1")
	}
	tier := strings.ToUpper(strings.TrimSpace(resolution))
	if strings.HasSuffix(size, "k") {
		tier = strings.ToUpper(size)
		size = "auto"
	}
	if tier == "" {
		tier = "2K"
	}
	sizes, valid := seedreamProSizes[tier]
	if !valid {
		return "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 分辨率仅支持 1K、1.5K、2K")
	}
	if size == "" || size == "auto" || size == "adaptive" {
		return tier, nil
	}
	if pixels, ok := sizes[size]; ok {
		return pixels, nil
	}
	// Preserve the other UI ratios exactly, aligned to 16 pixels, within the
	// selected tier's area budget. Never resize using Lite's minimum area.
	parts := strings.Split(size, ":")
	if len(parts) == 2 {
		a, ea := strconv.Atoi(parts[0])
		b, eb := strconv.Atoi(parts[1])
		if ea == nil && eb == nil && a > 0 && b > 0 && a <= 100 && b <= 100 && float64(a)/float64(b) >= 1.0/16 && float64(a)/float64(b) <= 16 {
			x, y := a, b
			for y != 0 {
				x, y = y, x%y
			}
			a, b = a/x, b/x
			base := map[string]float64{"1K": 1024, "1.5K": 1536, "2K": 2048}[tier]
			unit := int(math.Sqrt(base*base/float64(a*b))/16) * 16
			if a*b*unit*unit < 921600 {
				unit += 16
			}
			if a*b*unit*unit >= 921600 && a*b*unit*unit <= 4624220 {
				return fmt.Sprintf("%dx%d", a*unit, b*unit), nil
			}
		}
	}
	return "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 图片比例无效，请选择有效比例或自适应")
}

func seedreamProOptions(req GenerateRequest) (string, string, string, error) {
	ratio := req.Size
	if (ratio == "" || ratio == "auto" || ratio == "adaptive") && req.AspectRatio != "" {
		ratio = req.AspectRatio
	}
	size, err := seedreamProImageSize(ratio, req.Resolution)
	if err != nil {
		return "", "", "", err
	}
	if len(req.ReferenceImages) > 10 {
		return "", "", "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 最多支持 10 张参考图")
	}
	format := strings.ToLower(strings.TrimSpace(req.OutputFormat))
	if value, ok := req.Parameters["output_format"]; ok {
		var valid bool
		format, valid = value.(string)
		if !valid {
			return "", "", "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 输出格式须为 png 或 jpeg")
		}
	}
	if format == "" {
		format = "jpeg"
	}
	if format != "png" && format != "jpeg" {
		return "", "", "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 输出格式须为 png 或 jpeg")
	}
	mode := "standard"
	if value, ok := req.Parameters["optimize_prompt_options"]; ok {
		options, valid := value.(map[string]any)
		if !valid {
			return "", "", "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 提示词优化配置须为对象")
		}
		if value, exists := options["mode"]; exists {
			mode, valid = value.(string)
			if !valid || (mode != "standard" && mode != "fast") {
				return "", "", "", apperror.New(apperror.CodeInvalidInput, "Seedream 5.0 Pro 优化模式仅支持 standard 或 fast")
			}
		}
	}
	return size, format, mode, nil
}
