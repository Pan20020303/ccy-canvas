package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
	"github.com/google/uuid"
)

type LocalUpscaleRequest struct {
	MediaURL string
	Kind     string
	Scale    float64
	Quality  string
}

type LocalUpscaleResult struct {
	URL    string  `json:"url"`
	Kind   string  `json:"kind"`
	Engine string  `json:"engine"`
	Scale  float64 `json:"scale"`
}

// UpscaleLocalMedia runs SeedVR2 3B INT8 through the local ComfyUI instance.
// Video latents are temporally chunked so the quality model remains usable on
// a 16 GB GPU while preserving the source frame rate and audio track.
func (s *Service) UpscaleLocalMedia(ctx context.Context, req LocalUpscaleRequest) (*LocalUpscaleResult, error) {
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	if kind != "image" && kind != "video" {
		return nil, apperror.New(apperror.CodeInvalidInput, "media kind must be image or video")
	}
	if strings.TrimSpace(req.MediaURL) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "media_url is required")
	}
	scale := req.Scale
	if scale < 1 || scale > 4 {
		scale = 2
	}
	quality := strings.ToUpper(strings.TrimSpace(req.Quality))
	if quality != "LOW" && quality != "MEDIUM" && quality != "HIGH" && quality != "ULTRA" {
		quality = "ULTRA"
	}
	baseURL := "http://127.0.0.1:8188"
	uploaded, err := uploadComfyReference(ctx, baseURL, req.MediaURL, 1)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInvalidInput, "failed to upload media to local ComfyUI", err)
	}
	prompt, outputNode := buildSeedVR2UpscalePrompt(kind, uploaded, scale, quality)
	body, _ := json.Marshal(map[string]any{"prompt": prompt, "client_id": uuid.NewString()})
	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/prompt", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := newProviderHTTPClient(60 * time.Second).Do(httpReq)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "SeedVR2 upscale submission failed", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("ComfyUI rejected SeedVR2 upscale (HTTP %d): %s", resp.StatusCode, string(responseBody[:min(len(responseBody), 800)])))
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(responseBody, &queued) != nil || queued.PromptID == "" {
		return nil, apperror.New(apperror.CodeInternal, "ComfyUI returned no prompt_id for SeedVR2 upscale")
	}
	outputURL, err := pollComfyUpscaleResult(ctx, baseURL, queued.PromptID, outputNode, kind)
	if err != nil {
		return nil, err
	}
	return &LocalUpscaleResult{URL: outputURL, Kind: kind, Engine: "seedvr2-3b-int8", Scale: scale}, nil
}

func buildSeedVR2UpscalePrompt(kind, filename string, scale float64, quality string) (map[string]any, string) {
	colorMethod := "lab"
	if quality == "ULTRA" {
		colorMethod = "wavelet"
	}
	graph := map[string]any{
		"3":  map[string]any{"class_type": "ResizeImageMaskNode", "inputs": map[string]any{"input": []any{"2", 0}, "resize_type": "scale by multiplier", "resize_type.multiplier": scale, "scale_method": "lanczos"}},
		"4":  map[string]any{"class_type": "SeedVR2Preprocess", "inputs": map[string]any{"resized_images": []any{"3", 0}}},
		"5":  map[string]any{"class_type": "VAELoader", "inputs": map[string]any{"vae_name": "seedvr2_ema_vae_fp16.safetensors"}},
		"6":  map[string]any{"class_type": "VAEEncodeTiled", "inputs": map[string]any{"pixels": []any{"4", 0}, "vae": []any{"5", 0}, "tile_size": 512, "overlap": 128, "temporal_size": 64, "temporal_overlap": 8}},
		"7":  map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "seedvr2_3b_int8_convrot.safetensors", "weight_dtype": "default"}},
		"9":  map[string]any{"class_type": "SeedVR2Conditioning", "inputs": map[string]any{"model": []any{"7", 0}, "vae_conditioning": []any{"6", 0}}},
		"10": map[string]any{"class_type": "KSampler", "inputs": map[string]any{"model": []any{"7", 0}, "seed": 1, "steps": 1, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": []any{"9", 0}, "negative": []any{"9", 1}, "latent_image": []any{"6", 0}, "denoise": 1.0}},
		"12": map[string]any{"class_type": "VAEDecodeTiled", "inputs": map[string]any{"samples": []any{"10", 0}, "vae": []any{"5", 0}, "tile_size": 512, "overlap": 128, "temporal_size": 64, "temporal_overlap": 8}},
		"13": map[string]any{"class_type": "SeedVR2PostProcessing", "inputs": map[string]any{"images": []any{"12", 0}, "original_resized_images": []any{"3", 0}, "color_correction_method": colorMethod}},
	}
	if kind == "image" {
		graph["1"] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": filename}}
		graph["2"] = map[string]any{"class_type": "ImageFromBatch", "inputs": map[string]any{"image": []any{"1", 0}, "batch_index": 0, "length": 1}}
		graph["14"] = map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"13", 0}, "filename_prefix": "ccy-canvas/SeedVR2_Image_Upscale"}}
		return graph, "14"
	}
	graph["1"] = map[string]any{"class_type": "LoadVideo", "inputs": map[string]any{"file": filename}}
	graph["2"] = map[string]any{"class_type": "GetVideoComponents", "inputs": map[string]any{"video": []any{"1", 0}}}
	// Replace the direct latent links with automatic temporal chunking. ComfyUI
	// maps conditioning and sampling over the latent list, then merges it again.
	graph["8"] = map[string]any{"class_type": "SeedVR2TemporalChunk", "inputs": map[string]any{"latent": []any{"6", 0}, "temporal_overlap": 2, "chunking_mode": "auto"}}
	graph["9"].(map[string]any)["inputs"].(map[string]any)["vae_conditioning"] = []any{"8", 0}
	graph["10"].(map[string]any)["inputs"].(map[string]any)["latent_image"] = []any{"8", 0}
	graph["11"] = map[string]any{"class_type": "SeedVR2TemporalMerge", "inputs": map[string]any{"latents": []any{"10", 0}, "temporal_overlap": []any{"8", 1}}}
	graph["12"].(map[string]any)["inputs"].(map[string]any)["samples"] = []any{"11", 0}
	graph["14"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"13", 0}, "audio": []any{"2", 1}, "fps": []any{"2", 2}, "bit_depth": []any{"2", 3}}}
	graph["15"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"14", 0}, "filename_prefix": "video/ccy-canvas/SeedVR2_Video_Upscale", "format": "mp4", "codec": "auto"}}
	return graph, "15"
}

func pollComfyUpscaleResult(ctx context.Context, baseURL, promptID, outputNode, kind string) (string, error) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", apperror.New(apperror.CodeInternal, "SeedVR2 upscale timed out")
		case <-ticker.C:
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/history/"+url.PathEscape(promptID), nil)
			resp, err := newProviderHTTPClient(30 * time.Second).Do(req)
			if err != nil {
				continue
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var history map[string]struct {
				Status struct {
					Status    string `json:"status_str"`
					Completed bool   `json:"completed"`
				} `json:"status"`
				Outputs map[string]struct {
					Images []struct{ Filename, Subfolder, Type string } `json:"images"`
				} `json:"outputs"`
			}
			if json.Unmarshal(body, &history) != nil {
				continue
			}
			entry, ok := history[promptID]
			if !ok {
				continue
			}
			if strings.EqualFold(entry.Status.Status, "error") {
				return "", apperror.New(apperror.CodeInternal, "SeedVR2 upscale failed in ComfyUI")
			}
			if !entry.Status.Completed {
				continue
			}
			if entry.Status.Status != "success" {
				return "", apperror.New(apperror.CodeInternal, "SeedVR2 upscale ended without success")
			}
			files := entry.Outputs[outputNode].Images
			if len(files) == 0 {
				return "", apperror.New(apperror.CodeInternal, "SeedVR2 upscale returned no media")
			}
			item := files[0]
			viewURL := baseURL + "/view?" + url.Values{"filename": {item.Filename}, "subfolder": {item.Subfolder}, "type": {item.Type}}.Encode()
			mediaReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, viewURL, nil)
			mediaResp, err := newProviderHTTPClient(30 * time.Minute).Do(mediaReq)
			if err != nil {
				return "", err
			}
			if mediaResp.StatusCode >= 300 {
				mediaResp.Body.Close()
				return "", fmt.Errorf("ComfyUI output download HTTP %d", mediaResp.StatusCode)
			}
			ext, mime := ".png", "image/png"
			if kind == "video" {
				ext, mime = ".mp4", "video/mp4"
			}
			staged, err := writeStagedAsset(mediaResp.Body, ext, mime)
			mediaResp.Body.Close()
			if err != nil {
				return "", err
			}
			return staged.StagingURL, nil
		}
	}
}
