package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// WaitResult is the terminal outcome of a generation.
type WaitResult struct {
	Status     string // "success" | "error"
	ResultURL  string
	ResultURLs []string
	ErrorMsg   string
}

// NormalizeStatus folds the backend's status plus lenient aliases into
// "success" / "error" / <active>. Terminal states are only success/error.
func NormalizeStatus(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "success", "succeeded", "completed", "done":
		return "success"
	case "error", "failed", "failure", "cancelled", "canceled":
		return "error"
	default:
		return strings.ToLower(strings.TrimSpace(s)) // queued/pending/running/retrying/persisting
	}
}

// errStreamEnded signals the SSE connection closed without a terminal event.
var errStreamEnded = errors.New("sse stream ended")

// Wait blocks until the task reaches a terminal state. SSE and polling run IN
// PARALLEL (not fallback): SSE yields the full ResultURLs for multi-asset
// results, while polling guarantees progress even when the in-process event
// bus misses a cross-replica event. The first terminal signal wins.
func (c *Client) Wait(ctx context.Context, taskID string, timeout time.Duration, pollOnly bool) (WaitResult, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	results := make(chan WaitResult, 2)
	errs := make(chan error, 2)
	pending := 1

	if !pollOnly {
		pending = 2
		go func() {
			r, err := c.streamWait(ctx, taskID)
			if err != nil {
				errs <- err
				return
			}
			results <- r
		}()
	}
	go func() {
		r, err := c.pollWait(ctx, taskID)
		if err != nil {
			errs <- err
			return
		}
		results <- r
	}()

	var firstErr error
	for pending > 0 {
		select {
		case r := <-results:
			return r, nil
		case e := <-errs:
			pending--
			if firstErr == nil || errors.Is(firstErr, errStreamEnded) {
				firstErr = e
			}
		case <-ctx.Done():
			return WaitResult{}, ctx.Err()
		}
	}
	if firstErr != nil {
		return WaitResult{}, firstErr
	}
	return WaitResult{}, ctx.Err()
}

// StreamEvents subscribes to the task SSE stream and calls onEvent for each
// parsed frame. It stops when onEvent returns true or the context is done.
func (c *Client) StreamEvents(ctx context.Context, onEvent func(TaskEvent) bool) error {
	req, err := c.newRequest(ctx, http.MethodGet, "/api/app/tasks/stream", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return &APIError{Status: 0, Message: networkErr(c.BaseURL, err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return parseAPIError(resp.StatusCode, raw)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		// Skip comment frames (": connected", ": ping") and blanks.
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var ev TaskEvent
		if json.Unmarshal([]byte(payload), &ev) != nil {
			continue
		}
		if onEvent(ev) {
			return nil
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	return errStreamEnded
}

func (c *Client) streamWait(ctx context.Context, taskID string) (WaitResult, error) {
	var res WaitResult
	err := c.StreamEvents(ctx, func(ev TaskEvent) bool {
		if ev.TaskID != taskID {
			return false
		}
		switch NormalizeStatus(ev.Status) {
		case "success":
			res = WaitResult{Status: "success", ResultURL: ev.ResultURL, ResultURLs: ev.ResultURLs}
			return true
		case "error":
			res = WaitResult{Status: "error", ErrorMsg: ev.ErrorMsg}
			return true
		}
		return false
	})
	if err != nil {
		return WaitResult{}, err
	}
	return res, nil
}

func (c *Client) pollWait(ctx context.Context, taskID string) (WaitResult, error) {
	interval := 1500 * time.Millisecond
	const maxInterval = 5 * time.Second
	for {
		item, err := c.GetTask(ctx, taskID)
		if err != nil {
			// A fresh task row may briefly 404; keep polling until ctx expires.
			var ae *APIError
			if !(errors.As(err, &ae) && ae.Status == http.StatusNotFound) {
				if ctx.Err() != nil {
					return WaitResult{}, ctx.Err()
				}
				// Other transient error — keep trying.
			}
		} else {
			switch NormalizeStatus(item.Status) {
			case "success":
				return WaitResult{Status: "success", ResultURL: item.ResultURL}, nil
			case "error":
				return WaitResult{Status: "error", ErrorMsg: item.ErrorMsg}, nil
			}
		}
		select {
		case <-ctx.Done():
			return WaitResult{}, ctx.Err()
		case <-time.After(interval):
		}
		if interval < maxInterval {
			interval += 500 * time.Millisecond
			if interval > maxInterval {
				interval = maxInterval
			}
		}
	}
}
