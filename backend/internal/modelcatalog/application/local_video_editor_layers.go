package application

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

type editorLayerSource struct {
	clip     VideoEditClip
	path     string
	hasAudio bool
}

func editorLayerTransform(c VideoEditClip) (scale, x, y float64) {
	scale, x, y = 1, .5, .5
	if c.Scale != nil {
		scale = *c.Scale
	}
	if c.X != nil {
		x = *c.X
	}
	if c.Y != nil {
		y = *c.Y
	}
	return
}

// Sources are validated local files, ordered bottom-to-top. A finite black
// canvas is the master clock; independent video layers and audio keep their
// explicit positions, including leading gaps and audio-only tails.
func editorMultiTrackArgs(layers []editorLayerSource, output string, req LocalVideoEditRequest, total float64) []string {
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d:d=%s", req.Width, req.Height, req.FPS, editorSeconds(total)),
		"-f", "lavfi", "-t", editorSeconds(total), "-i", "anullsrc=r=48000:cl=stereo"}
	var filters []string
	video, mix, audioCount := "[0:v]", "[1:a]", 1
	for n, src := range layers {
		c, idx := src.clip, n+2
		args = append(args, "-threads", "2", "-protocol_whitelist", "file")
		if c.Kind == "image" {
			args = append(args, "-f", "image2", "-pattern_type", "none", "-loop", "1", "-framerate", strconv.Itoa(req.FPS))
		} else {
			args = append(args, "-format_whitelist", editorFormats, "-ss", editorSeconds(c.Start))
		}
		args = append(args, "-t", editorSeconds(c.End-c.Start), "-i", src.path)
		if c.Kind != "audio" {
			scale, x, y := editorLayerTransform(c)
			w, h := int(math.Round(float64(req.Width)*scale/2))*2, int(math.Round(float64(req.Height)*scale/2))*2
			layer, next := fmt.Sprintf("layer%d", n), fmt.Sprintf("video%d", n)
			filters = append(filters, fmt.Sprintf("[%d:v:0]trim=duration=%s,setpts=(PTS-STARTPTS)/%s,scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=%d,format=rgba,setpts=PTS+%s/TB[%s]",
				idx, editorSeconds(c.End-c.Start), editorSeconds(c.Speed), w, h, req.FPS, editorSeconds(c.At), layer))
			filters = append(filters, fmt.Sprintf("%s[%s]overlay=x=W*%s-w/2:y=H*%s-h/2:eof_action=pass:repeatlast=0:enable='gte(t,%s)*lt(t,%s)'[%s]",
				video, layer, editorSeconds(x), editorSeconds(y), editorSeconds(c.At), editorSeconds(c.At+(c.End-c.Start)/c.Speed), next))
			video = "[" + next + "]"
		}
		if src.hasAudio && c.Kind != "image" && c.Volume > 0 {
			label := fmt.Sprintf("audio%d", n)
			delay := int(math.Round(c.At * 48000))
			filters = append(filters, fmt.Sprintf("[%d:a:0]atrim=duration=%s,asetpts=PTS-STARTPTS,atempo=%s,volume=%s,aresample=48000,aformat=channel_layouts=stereo,adelay=%dS:all=1[%s]",
				idx, editorSeconds(c.End-c.Start), editorSeconds(c.Speed), editorSeconds(c.Volume), delay, label))
			mix += "[" + label + "]"
			audioCount++
		}
	}
	audio := "1:a:0"
	if audioCount > 1 {
		filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=1[mixed]", mix, audioCount))
		audio = "[mixed]"
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-filter_complex_threads", "1", "-map", video, "-map", audio,
		"-t", editorSeconds(total), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "4",
		"-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-sn", "-dn", "-map_metadata", "-1", "-movflags", "+faststart", "-fs", strconv.FormatInt(trimMaxOutputBytes, 10), output)
	return args
}
