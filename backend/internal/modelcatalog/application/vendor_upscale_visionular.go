package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/safehttp"
	"github.com/google/uuid"
)

const visionularBaseURL = "https://api.visionular.cn/vodencoding/v1"

func visionularAPIBase(baseURL string) (string, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && os.Getenv("CCY_ALLOW_INTERNAL_FETCH") == "1")) {
		return "", apperror.New(apperror.CodeInvalidInput, "Visionular 渠道必须使用 HTTPS 服务根地址")
	}
	// The existing channel editor may normalize a bare host to /v1.
	if u.Path == "" || u.Path == "/v1" {
		u.Path = "/vodencoding/v1"
	}
	return u.String(), nil
}

func probeVisionularChannel(ctx context.Context, baseURL, apiKey string) ChannelTestReport {
	started := time.Now()
	base, err := visionularAPIBase(baseURL)
	if err != nil {
		return ChannelTestReport{ErrorMsg: apperror.PublicMessage(err)}
	}
	client := safehttp.Client(10 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, err = visionularRequest(ctx, client, http.MethodGet, base+"/list_storage", apiKey, nil)
	report := ChannelTestReport{OK: err == nil, LatencyMs: int(time.Since(started).Milliseconds())}
	if err != nil {
		report.ErrorMsg = apperror.PublicMessage(err)
		report.HTTPStatus = httpStatusFromError(err)
	} else {
		report.HTTPStatus = 200
	}
	return report
}

var visionularTemplates = map[string]string{
	"visionular-genopt-1080p": "genopt_1080p",
	"visionular-genopt-1440p": "genopt_1440p",
	"visionular-genopt-2160p": "genopt_2160p",
}

func isVisionularUpscale(pc *domain.ProviderConfig) bool {
	return pc != nil && strings.EqualFold(strings.TrimSpace(pc.Vendor), "Visionular")
}

// Bootstrap once from backend-only environment values. Subsequent starts preserve
// administrator edits (including disabling a channel, prices and key rotation).
func (s *Service) EnsureVisionularProviderFromEnv(ctx context.Context) error {
	ak, sk := strings.TrimSpace(os.Getenv("VISIONULAR_ACCESS_KEY")), strings.TrimSpace(os.Getenv("VISIONULAR_SECRET_KEY"))
	if ak == "" && sk == "" {
		return nil
	}
	pipeline, storage := strings.TrimSpace(os.Getenv("VISIONULAR_PIPELINE")), strings.TrimSpace(os.Getenv("VISIONULAR_STORAGE_ID"))
	if ak == "" || sk == "" || pipeline == "" || storage == "" {
		return fmt.Errorf("Visionular requires access key, secret key, pipeline and storage id")
	}
	configs, err := s.repo.ListProviderConfigs(ctx)
	if err != nil {
		return fmt.Errorf("cannot check Visionular channel configuration")
	}
	for i := range configs {
		if isVisionularUpscale(&configs[i]) {
			return nil
		}
	}
	models := []string{"visionular-genopt-1080p", "visionular-genopt-1440p", "visionular-genopt-2160p"}
	labels := []string{"Visionular · 1080p 高清", "Visionular · 1440p 超清", "Visionular · 2160p / 4K 极清"}
	presentations := make([]map[string]any, 0, len(models))
	for i, model := range models {
		// Hidden from ordinary text-to-video selectors; available in Upscale.
		presentations = append(presentations, map[string]any{"modelName": model, "name": labels[i], "type": "video", "hidden": true})
	}
	schema, _ := json.Marshal(map[string]any{
		"visionular":         map[string]string{"pipeline": pipeline, "storage_id": storage, "output_base_url": strings.TrimSpace(os.Getenv("VISIONULAR_OUTPUT_BASE_URL"))},
		"vendor_models":      presentations,
		"vendor_description": "视频画质增强，使用现有模板。API Key 格式为 AccessKey:SecretKey；仅在后端加密保存。各档积分请在模型计费中配置。",
	})
	_, err = s.CreateProviderConfig(ctx, domain.ProviderConfig{
		ServiceType: "video", Vendor: "Visionular", Name: "Visionular · 视频画质增强",
		APISpec: "custom", Protocol: "native", BaseURL: visionularBaseURL,
		SubmitEndpoint: "/create_enhance_task", QueryEndpoint: "/query_task?task_id={taskId}",
		ModelList: models, DefaultModel: models[0], Priority: 100, ParameterSchema: schema,
	}, ak+":"+sk)
	return err
}

type visionularReply struct {
	Code *int `json:"code"`
	Data struct {
		TaskID string `json:"task_id"`
		Status string `json:"status"`
		Output string `json:"output"`
		Region string `json:"region"`
		Code   int    `json:"code"`
	} `json:"data"`
}

// V2: BasicAuth(AK, SK) AND auth-type: use-basic. Never expose upstream
// response bodies, headers or signed input URLs in client errors.
func visionularRequest(ctx context.Context, client *http.Client, method, endpoint, apiKey string, body []byte) (*visionularReply, error) {
	ak, sk, ok := strings.Cut(apiKey, ":")
	if !ok || strings.TrimSpace(ak) == "" || strings.TrimSpace(sk) == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Visionular 渠道密钥格式应为 AccessKey:SecretKey，请联系管理员")
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, apperror.New(apperror.CodeInternal, "无法构造 Visionular 请求")
	}
	req.SetBasicAuth(ak, sk)
	req.Header.Set("auth-type", "use-basic")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, apperror.New(apperror.CodeInternal, "Visionular 连接失败；请先检查任务状态，避免重复提交")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Visionular 请求失败（HTTP %d），请联系管理员检查渠道", resp.StatusCode))
	}
	var reply visionularReply
	if json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&reply) != nil || reply.Code == nil {
		return nil, apperror.New(apperror.CodeInternal, "Visionular 返回了无法识别的任务数据")
	}
	// 1006 is documented session_id deduplication, not a second paid job.
	if *reply.Code != 0 && !(method == http.MethodPost && *reply.Code == 1006 && reply.Data.TaskID != "") {
		return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Visionular 接口错误（%d），请联系管理员检查任务", *reply.Code))
	}
	return &reply, nil
}

func (s *Service) generateVideoVisionular(ctx context.Context, pc *domain.ProviderConfig, baseURL, apiKey string, req GenerateRequest) (*GenerateResult, error) {
	template, ok := visionularTemplates[req.Model]
	if !ok {
		return nil, apperror.New(apperror.CodeInvalidInput, "Visionular 视频超分仅支持 1080p、1440p、2160p 三个档位")
	}
	if len(req.ReferenceImages) > 0 || len(req.ReferenceAudios) > 0 || req.ReferenceAudio != "" || len(req.ReferenceVideos) > 1 || (req.ReferenceVideo != "" && len(req.ReferenceVideos) > 0) {
		return nil, apperror.New(apperror.CodeInvalidInput, "Visionular 超分只接受一段原视频，不支持参考图片、额外音轨或多视频")
	}
	source := strings.TrimSpace(req.ReferenceVideo)
	if source == "" && len(req.ReferenceVideos) == 1 {
		source = strings.TrimSpace(req.ReferenceVideos[0])
	}
	parsed, err := url.Parse(source)
	if err != nil || parsed.User != nil || parsed.Hostname() == "localhost" || safehttp.ValidatePublicURL(source) != nil {
		return nil, apperror.New(apperror.CodeInvalidInput, "视频超分需要公网可访问的原视频，请先上传至 OSS/COS；不支持 blob、Base64 或本机地址")
	}
	source, err = resolveDashScopePublicVideoURL(ctx, source)
	if err != nil {
		return nil, err
	}
	var schema struct {
		Visionular struct {
			Pipeline      string `json:"pipeline"`
			StorageID     string `json:"storage_id"`
			OutputBaseURL string `json:"output_base_url"`
		} `json:"visionular"`
	}
	if json.Unmarshal(pc.ParameterSchema, &schema) != nil || schema.Visionular.Pipeline == "" || schema.Visionular.StorageID == "" {
		return nil, apperror.New(apperror.CodeInvalidInput, "Visionular 渠道缺少管道或存储配置，请联系管理员")
	}
	// Stable across queue retries. The vendor returns the original task on 1006.
	sessionID := req.GenerationLogID
	if sessionID == "" {
		sessionID = uuid.NewString()
	}
	if len(sessionID) > 50 || !regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(sessionID) {
		return nil, apperror.New(apperror.CodeInvalidInput, "无效的超分任务标识")
	}
	body, _ := json.Marshal(map[string]any{
		"input": source, "output": "ccy-canvas/visionular/" + sessionID + "/" + template + ".mp4",
		"template_name": template, "storage_id": schema.Visionular.StorageID, "pipeline": schema.Visionular.Pipeline,
		"extra_options": map[string]string{"session_id": sessionID},
	})
	client := safehttp.Client(45 * time.Second)
	// Never follow redirects with vendor BasicAuth credentials.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	baseURL, err = visionularAPIBase(baseURL)
	if err != nil {
		return nil, err
	}
	reply, err := visionularRequest(ctx, client, http.MethodPost, baseURL+"/create_enhance_task", apiKey, body)
	if err != nil {
		return nil, err
	}
	taskID := reply.Data.TaskID
	if taskID == "" {
		return nil, apperror.New(apperror.CodeInternal, "Visionular 未返回超分任务编号")
	}
	s.rememberProviderTask(req.GenerationLogID, pc.ID, taskID)
	queryURL := baseURL + "/query_task?" + url.Values{"task_id": {taskID}}.Encode()
	failures := 0
	for i := 0; i < videoPollMaxAttempts(); i++ {
		delay := videoPollInterval()
		if i == 0 {
			delay = videoPollInitialDelay()
		}
		select {
		case <-ctx.Done():
			return nil, apperror.New(apperror.CodeTimeout, "Visionular 超分等待超时，请在任务记录中检查状态，避免重复提交")
		case <-time.After(delay):
		}
		status, queryErr := visionularRequest(ctx, client, http.MethodGet, queryURL, apiKey, nil)
		if queryErr != nil {
			failures++
			if failures >= 3 {
				return nil, queryErr
			}
			continue
		}
		failures = 0
		if status.Data.TaskID != "" && status.Data.TaskID != taskID {
			return nil, apperror.New(apperror.CodeInternal, "Visionular 查询返回了不匹配的任务编号")
		}
		switch strings.ToLower(status.Data.Status) {
		case "pending", "running", "downloading", "uploading":
			continue
		case "succeeded":
			if status.Data.Code != 0 {
				return nil, apperror.New(apperror.CodeInternal, "Visionular 超分任务返回错误状态")
			}
			output, outputErr := visionularOutputURL(status.Data.Output, status.Data.Region, schema.Visionular.OutputBaseURL)
			if outputErr != nil {
				return nil, outputErr
			}
			// Our configured private OSS/COS bucket can issue a signed download
			// before the normal generation pipeline stages the finished video.
			if signed, signErr := assetstore.PresignGet(ctx, output, videoEditPresignTTL); signErr == nil && signed != "" {
				output = signed
			}
			return &GenerateResult{Type: "url", Content: output}, nil
		case "failed":
			return nil, apperror.New(apperror.CodeInternal, fmt.Sprintf("Visionular 超分失败（任务错误码 %d），请联系管理员查询详情", status.Data.Code))
		default:
			return nil, apperror.New(apperror.CodeInternal, "Visionular 返回了未知任务状态")
		}
	}
	return nil, apperror.New(apperror.CodeTimeout, "Visionular 超分查询超时，请先检查任务记录")
}

func visionularOutputURL(raw, region, outputBase string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err == nil && u.Scheme == "oss" && regexp.MustCompile(`^[a-z0-9][a-z0-9-]+$`).MatchString(u.Host) && u.Path != "" {
		base := strings.TrimRight(strings.TrimSpace(outputBase), "/")
		if base == "" && regexp.MustCompile(`^cn-[a-z0-9-]+$`).MatchString(region) {
			base = "https://" + u.Host + ".oss-" + region + ".aliyuncs.com"
		}
		if base != "" {
			raw = base + u.EscapedPath()
		}
	}
	parsed, parseErr := url.Parse(raw)
	if parseErr != nil || parsed.User != nil || safehttp.ValidatePublicURL(raw) != nil {
		return "", apperror.New(apperror.CodeInternal, "Visionular 输出不是可下载地址，请检查存储地域和输出域名配置")
	}
	return raw, nil
}
