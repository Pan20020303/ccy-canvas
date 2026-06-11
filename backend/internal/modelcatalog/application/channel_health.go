package application

import (
	"context"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/platform/crypto"
)

// httpStatusFromError pulls an HTTP status code out of an error message that
// was formatted by one of the upstream helpers (e.g. "Provider HTTP 403: ..."
// or "LLM HTTP 503: ..."). Returns 0 when no status is present — the caller
// then treats it as a transport-level failure.
//
// This lets us classify errors WITHOUT refactoring every generateImage* /
// generateVideo* helper to return (result, httpStatus, error) — they already
// embed the status in the message and we just sniff it back out.
var httpStatusRegex = regexp.MustCompile(`(?i)\bHTTP\s+(\d{3})\b`)

func httpStatusFromError(err error) int {
	if err == nil {
		return 0
	}
	m := httpStatusRegex.FindStringSubmatch(err.Error())
	if len(m) < 2 {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// Channel-health policy.
//
// Each provider_config (= "channel") accumulates a consecutive-failure
// counter and last-error snapshot for operator visibility. We no longer
// push channels into cooldown automatically; the admin surface can alert on
// repeated failures, but routing keeps trying the configured provider list.
//
// Defaults match the user's confirmed preferences (3 failures / 5 min /
// exp backoff to 60 min); env vars override at startup so production can
// tune without code changes.

const (
	defaultFailureThreshold      = 3
	defaultInitialCooldownSec    = 300  // 5 minutes
	defaultMaxCooldownSec        = 3600 // 60 minutes
	defaultCooldownBackoffFactor = 2
	maxErrorMsgLen               = 200 // truncate before storing
)

// channelHealthConfig is loaded once at process start and reused. We don't
// re-read env vars per request (would be a syscall on every generation).
var channelHealthConfig = loadChannelHealthConfig()

type channelHealthCfg struct {
	failureThreshold      int32
	initialCooldown       time.Duration
	maxCooldown           time.Duration
	cooldownBackoffFactor int32
}

func loadChannelHealthConfig() channelHealthCfg {
	cfg := channelHealthCfg{
		failureThreshold:      defaultFailureThreshold,
		initialCooldown:       defaultInitialCooldownSec * time.Second,
		maxCooldown:           defaultMaxCooldownSec * time.Second,
		cooldownBackoffFactor: defaultCooldownBackoffFactor,
	}
	if v, err := strconv.Atoi(os.Getenv("CHANNEL_FAILURE_THRESHOLD")); err == nil && v > 0 {
		cfg.failureThreshold = int32(v)
	}
	if v, err := strconv.Atoi(os.Getenv("CHANNEL_INITIAL_COOLDOWN_SECONDS")); err == nil && v > 0 {
		cfg.initialCooldown = time.Duration(v) * time.Second
	}
	if v, err := strconv.Atoi(os.Getenv("CHANNEL_MAX_COOLDOWN_SECONDS")); err == nil && v > 0 {
		cfg.maxCooldown = time.Duration(v) * time.Second
	}
	if v, err := strconv.Atoi(os.Getenv("CHANNEL_COOLDOWN_BACKOFF_FACTOR")); err == nil && v > 1 {
		cfg.cooldownBackoffFactor = int32(v)
	}
	return cfg
}

// ErrorCategory classifies an upstream failure to drive routing decisions.
type ErrorCategory int

const (
	// CategoryTransient — temporary network blip, 5xx, EOF. Worth retrying
	// the SAME channel a couple times before giving up on it.
	CategoryTransient ErrorCategory = iota
	// CategoryChannelDead — the channel is structurally broken for now:
	// 401 (bad key), 403 (banned), 404 (model not in this relay), 429
	// (rate limit), 503 with "model_not_found". Skip the rest of the
	// per-channel retries and put it in cooldown immediately.
	CategoryChannelDead
	// CategoryClientFault — the user's request itself is malformed:
	// 400 with "prompt too long", 422 validation, etc. Switching vendor
	// won't help — return the error to the user, don't mark the channel.
	CategoryClientFault
	// CategoryTimeout — request exceeded the allotted wall-clock (i/o
	// timeout, context deadline exceeded, upstream 408). Per Stage 4 of
	// the timeout-treatment plan, these do NOT count toward the cooldown
	// failure budget: an upstream having a slow minute shouldn't kick
	// the whole channel out of rotation.
	CategoryTimeout
)

// ClassifyError inspects an HTTP status code (0 means "no HTTP response, was
// a network/transport failure") plus an error message and decides how the
// router should react. The error message is matched case-insensitively
// against a fixed set of well-known relay vocabulary.
func ClassifyError(httpStatus int, errMsg string) ErrorCategory {
	lower := strings.ToLower(errMsg)

	// Timeouts get their own bucket regardless of how they arrived
	// (transport-level i/o timeout, context deadline exceeded, or an
	// upstream HTTP 408). Classified first so timeout-shaped errors
	// can't fall through into Transient (which would count toward
	// the cooldown budget).
	timeoutHints := []string{
		"i/o timeout",
		"context deadline exceeded",
		"deadline exceeded",
		"timeout exceeded",
		"timed out",
	}
	for _, h := range timeoutHints {
		if strings.Contains(lower, h) {
			return CategoryTimeout
		}
	}
	if httpStatus == 408 {
		return CategoryTimeout
	}

	// Transport-level failures land here with httpStatus = 0.
	if httpStatus == 0 {
		// EOFs, connection resets, broken pipes — try the same channel
		// once or twice more before moving on; they often clear up.
		transientHints := []string{
			"eof",
			"connection reset",
			"broken pipe",
			"forcibly closed",
			"no such host",       // DNS hiccup — usually transient
			"connection refused", // service restart? give it a beat
		}
		for _, h := range transientHints {
			if strings.Contains(lower, h) {
				return CategoryTransient
			}
		}
		return CategoryTransient // unknown transport error: still try again
	}

	// HTTP status-based classification.
	switch {
	case httpStatus == 401 || httpStatus == 403:
		// Auth / permission — admin needs to fix this channel. Sideline it
		// so the next request immediately tries an alternate provider.
		return CategoryChannelDead
	case httpStatus == 404:
		// Often "model not found at this relay" — kill this channel,
		// other vendors may still have the model.
		return CategoryChannelDead
	case httpStatus == 429:
		// Rate limit. Channel-dead for cooldown duration; will recover.
		return CategoryChannelDead
	case httpStatus == 400 || httpStatus == 422:
		// Client-side validation. Don't punish the channel — the next
		// request with a corrected prompt should succeed.
		return CategoryClientFault
	case httpStatus >= 500:
		// 5xx — try the same channel a couple times (transient) but if
		// the error message mentions "model_not_found" or "no available
		// channel for model", treat as channel-dead (common with relay
		// distributors when a backing provider is exhausted).
		if strings.Contains(lower, "model_not_found") ||
			strings.Contains(lower, "no available channel") ||
			strings.Contains(lower, "no available endpoint") {
			return CategoryChannelDead
		}
		return CategoryTransient
	}
	// 2xx/3xx shouldn't reach here, and other 4xx default to client fault.
	return CategoryClientFault
}

// computeCooldown returns the duration the channel should sit out, given
// how many times in a row it has already been cooled. Exposed for tests.
func computeCooldown(consecutiveCooldowns int32) time.Duration {
	cfg := channelHealthConfig
	mult := int64(1)
	for i := int32(0); i < consecutiveCooldowns; i++ {
		mult *= int64(cfg.cooldownBackoffFactor)
		if time.Duration(mult)*cfg.initialCooldown >= cfg.maxCooldown {
			return cfg.maxCooldown
		}
	}
	d := time.Duration(mult) * cfg.initialCooldown
	if d > cfg.maxCooldown {
		d = cfg.maxCooldown
	}
	return d
}

// MarkChannelSuccess clears all health counters on a provider — call this
// after every successful upstream request so a recovered channel re-enters
// the rotation immediately.
func (s *Service) MarkChannelSuccess(ctx context.Context, providerID string) {
	if providerID == "" {
		return
	}
	_ = s.repo.MarkChannelSuccess(ctx, providerID)
}

// MarkChannelFailure increments the failure counter and stores the latest
// error for admin visibility. Best-effort: errors from the storage layer
// are swallowed (we'd rather lose a counter update than fail the actual
// generation request because of bookkeeping).
func (s *Service) MarkChannelFailure(ctx context.Context, providerID string, cat ErrorCategory, errMsg string) {
	if providerID == "" || cat == CategoryClientFault {
		return
	}
	if len(errMsg) > maxErrorMsgLen {
		errMsg = errMsg[:maxErrorMsgLen]
	}
	_, _, err := s.repo.IncrementChannelFailure(ctx, providerID, errMsg)
	if err != nil {
		return
	}
}

// MarkChannelTimeout bumps the channel's timeout counter without touching
// the failure counter or cooldown. Per Stage 4 of the timeout-treatment
// plan, timeouts are an informational signal — visible to admins via the
// health badge — but do NOT cause the router to sideline the provider.
func (s *Service) MarkChannelTimeout(ctx context.Context, providerID string) {
	if providerID == "" {
		return
	}
	_ = s.repo.MarkChannelTimeout(ctx, providerID)
}

// ResetChannelHealth clears all counters and cooldown on a channel. Wired
// to the admin "重置健康" button.
func (s *Service) ResetChannelHealth(ctx context.Context, providerID string) error {
	if providerID == "" {
		return nil
	}
	return s.repo.ResetChannelHealth(ctx, providerID)
}

// ChannelTestReport is what TestChannelConnectivity returns. OK=true means
// the upstream answered any HTTP status; the admin still gets to see the
// concrete code (e.g. 401 means "reachable but credentials bad").
type ChannelTestReport struct {
	OK         bool
	HTTPStatus int
	LatencyMs  int
	ErrorMsg   string
}

// TestChannelConnectivity probes the upstream provider. We try the most
// neutral OpenAI-compatible endpoint that doesn't burn quota: GET /v1/models
// (or whatever the base URL resolves it to). Reports the latency + HTTP
// status so admins can tell "reachable but auth bad" apart from "totally
// offline".
//
// Doesn't mutate channel health — this is a manual probe; we don't want a
// single failed test to put the channel into cooldown.
func (s *Service) TestChannelConnectivity(ctx context.Context, providerID string) (ChannelTestReport, error) {
	cfg, err := s.repo.GetProviderConfigByID(ctx, providerID)
	if err != nil || cfg == nil {
		return ChannelTestReport{}, err
	}
	if cfg.EncryptedAPIKey == "" {
		return ChannelTestReport{OK: false, ErrorMsg: "no API key configured"}, nil
	}
	apiKey, derr := crypto.Decrypt(s.encryptionKey, cfg.EncryptedAPIKey)
	if derr != nil {
		return ChannelTestReport{OK: false, ErrorMsg: "key decrypt failed: " + derr.Error()}, nil
	}

	url := strings.TrimRight(cfg.BaseURL, "/") + "/models"
	started := time.Now()
	report := ChannelTestReport{}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	report.LatencyMs = int(time.Since(started).Milliseconds())
	if err != nil {
		report.OK = false
		report.ErrorMsg = err.Error()
		return report, nil
	}
	defer resp.Body.Close()
	report.HTTPStatus = resp.StatusCode
	// Anything that isn't a 5xx counts as "reachable". 401/403 still
	// communicate something useful: the URL is correct, the key is wrong.
	report.OK = resp.StatusCode < 500
	if !report.OK {
		report.ErrorMsg = "upstream " + resp.Status
	}
	return report, nil
}

// OnEndpointSuccess satisfies the skills package's ChannelHealthReporter
// interface so the LLM streaming layer can report results back without
// importing modelcatalog directly.
func (s *Service) OnEndpointSuccess(ctx context.Context, providerID string) {
	s.MarkChannelSuccess(ctx, providerID)
}

// OnEndpointFailure satisfies ChannelHealthReporter. Translates the
// (httpStatus, errMsg) pair into our internal ErrorCategory and dispatches
// to MarkChannelFailure.
func (s *Service) OnEndpointFailure(ctx context.Context, providerID string, httpStatus int, errMsg string) {
	cat := ClassifyError(httpStatus, errMsg)
	s.MarkChannelFailure(ctx, providerID, cat, errMsg)
}

// RecordGenerationAttempt persists one row in generation_attempts. The
// caller passes the per-call status / error / duration so the audit log
// reflects what really happened on the wire. Best-effort.
func (s *Service) RecordGenerationAttempt(
	ctx context.Context,
	logID, providerID, vendor string,
	attemptNumber, httpStatus, durationMs int,
	errMsg string,
) {
	if len(errMsg) > maxErrorMsgLen {
		errMsg = errMsg[:maxErrorMsgLen]
	}
	_ = s.repo.InsertGenerationAttempt(ctx, domain.GenerationAttempt{
		GenerationLogID:  logID,
		ProviderConfigID: providerID,
		Vendor:           vendor,
		AttemptNumber:    int32(attemptNumber),
		HTTPStatus:       int32(httpStatus),
		ErrorMsg:         errMsg,
		DurationMs:       int32(durationMs),
	})
}
