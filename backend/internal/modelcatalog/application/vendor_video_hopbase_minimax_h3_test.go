package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"ccy-canvas/backend/internal/modelcatalog/domain"
)

func TestHopBaseMiniMaxH3Contract(t *testing.T) {
	image := "https://media.example.test/image.png"
	video := "https://media.example.test/video.mp4"
	audio := "https://media.example.test/audio.mp3"
	for _, tc := range []struct {
		name  string
		req   GenerateRequest
		roles []string
	}{
		{"text", GenerateRequest{Model: "MiniMax-H3", Prompt: "云海", Resolution: "2K", Duration: 4, AspectRatio: "16:9"}, nil},
		{"frames", GenerateRequest{Model: "MiniMax-H3-Max", Prompt: "推镜", ReferenceMode: "start_end", ReferenceImages: []string{image, image}}, []string{"first_frame", "last_frame"}},
		{"mixed", GenerateRequest{Model: "MiniMax-H3", Prompt: "雨庭", ReferenceMode: "image_reference", ReferenceImages: []string{image}, ReferenceVideos: []string{video}, ReferenceAudios: []string{audio}}, []string{"reference_image", "reference_video", "reference_audio"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := buildHopBaseMiniMaxH3Body(context.Background(), tc.req)
			if err != nil {
				t.Fatal(err)
			}
			if len(body) < 4 || len(body) > 6 || body["model"] != tc.req.Model {
				t.Fatalf("wrong top-level fields: %#v", body)
			}
			content := body["content"].([]map[string]any)
			if len(content) != len(tc.roles)+1 || content[0]["type"] != "text" {
				t.Fatalf("wrong content: %#v", content)
			}
			for i, role := range tc.roles {
				if content[i+1]["role"] != role {
					t.Fatalf("role #%d = %v", i, content[i+1]["role"])
				}
			}
		})
	}
}

func TestHopBaseMiniMaxH3RejectsInvalidInputs(t *testing.T) {
	for _, req := range []GenerateRequest{
		{Model: "MiniMax-H3", Prompt: "test", Duration: 3},
		{Model: "MiniMax-H3", Prompt: "test", Resolution: "480P"},
		{Model: "MiniMax-H3-Max", Prompt: "test", Resolution: "2K"},
		{Model: "MiniMax-H3-Max", Prompt: "test", ReferenceMode: "image_reference", ReferenceImages: []string{"https://example.test/a.png"}},
		{Model: "MiniMax-H3", Prompt: "test", ReferenceAudios: []string{"https://example.test/a.mp3"}},
		{Model: "MiniMax-H3", Prompt: "test", ReferenceMode: "start_end", ReferenceImages: []string{"https://example.test/a.png"}, ReferenceVideos: []string{"https://example.test/a.mp4"}},
		{Model: "MiniMax-H3", Prompt: "test", AspectRatio: "adaptive"},
	} {
		if err := validateHopBaseMiniMaxH3(req); err == nil {
			t.Fatalf("accepted invalid request: %+v", req)
		}
	}
}

func TestHopBaseMiniMaxH3SubmitPollAndRecovery(t *testing.T) {
	fastVideoPoll(t)
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
	repo := &recordingTaskRepo{}
	submits, polls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing authorization")
		}
		switch r.URL.Path {
		case hopBaseVideoSubmitPath:
			submits++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["model"] != "MiniMax-H3" || body["resolution"] != "768P" {
				t.Errorf("unexpected body: %#v", body)
			}
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"id":"mmt-1","status":"queued"}`)
		case "/v1/video/tasks/mmt-1":
			polls++
			if repo.taskID != "mmt-1" {
				t.Error("task not checkpointed before poll")
			}
			fmt.Fprint(w, `{"id":"mmt-1","status":"completed","outputs":["https://media.example.test/h3.mp4"]}`)
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	svc := &Service{repo: repo}
	provider := &domain.ProviderConfig{ID: "h3-provider", Vendor: "HopBase"}
	request := GenerateRequest{Model: "MiniMax-H3", Prompt: "云海", GenerationLogID: "log"}
	result, err := svc.generateVideo(context.Background(), provider, server.URL+"/v1", "test-key", request)
	if err != nil || result == nil || result.Content != "https://media.example.test/h3.mp4" || submits != 1 || polls != 1 {
		t.Fatalf("result=%v err=%v submits=%d polls=%d", result, err, submits, polls)
	}
	request.UpstreamTaskID, request.UpstreamProviderID = "mmt-1", "h3-provider"
	request.ReferenceImages = []string{"/uploads/missing.png"}
	_, err = svc.generateVideo(context.Background(), provider, server.URL, "test-key", request)
	if err != nil || submits != 1 || polls != 2 {
		t.Fatalf("recovery err=%v submits=%d polls=%d", err, submits, polls)
	}
}
