package application

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStreamChatCompletionsAcceptsCompletedSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"镜头一\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"镜头二\"},\"finish_reason\":\"stop\"}]}\n\n")
	}))
	defer server.Close()

	var deltas strings.Builder
	got, err := streamChatCompletions(context.Background(), server.URL, "token", "model", "prompt", nil, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatalf("streamChatCompletions error: %v", err)
	}
	if got != "镜头一镜头二" || deltas.String() != got {
		t.Fatalf("got %q, deltas %q", got, deltas.String())
	}
}

func TestStreamChatCompletionsRejectsIncompleteSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
	}))
	defer server.Close()

	got, err := streamChatCompletions(context.Background(), server.URL, "token", "model", "prompt", nil, nil)
	if err == nil {
		t.Fatal("expected incomplete stream error")
	}
	if got != "partial" || !strings.Contains(err.Error(), "ended before completion") {
		t.Fatalf("got %q, err %v", got, err)
	}
}

func TestStreamChatCompletionsAcceptsNonStreamFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"完整结果"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	var delta string
	got, err := streamChatCompletions(context.Background(), server.URL, "token", "model", "prompt", nil, func(value string) error {
		delta += value
		return nil
	})
	if err != nil {
		t.Fatalf("streamChatCompletions error: %v", err)
	}
	if got != "完整结果" || delta != got {
		t.Fatalf("got %q, delta %q", got, delta)
	}
}
