package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccy-canvas/backend/internal/modelcatalog/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

func TestHopBaseMidjourneyStrictBodyAndPrompt(t *testing.T) {
	body, err := buildHopBaseMidjourneyBody(context.Background(), GenerateRequest{
		Model: hopBaseMidjourneyModel, Prompt: "雨中森林 --stylize 250", Size: "16:9", Resolution: "2K", OutputCount: 4,
		ReferenceImages: []string{"https://media.example.test/ref.png"}, Quality: "high", OutputFormat: "png",
		Parameters: map[string]any{"size": "1024x1024", "extra": map[string]any{"bad": true}, "background": "transparent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 4 || body["model"] != hopBaseMidjourneyModel || body["n"] != 4 || body["prompt"] != "雨中森林 --stylize 250 --ar 16:9 --hd" {
		t.Fatalf("unexpected body: %#v", body)
	}
	refs := body["images"].([]map[string]string)
	if len(refs) != 1 || len(refs[0]) != 1 || refs[0]["url"] != "https://media.example.test/ref.png" {
		t.Fatalf("invalid references: %#v", refs)
	}
	prompt, err := hopBaseMidjourneyPrompt(GenerateRequest{Prompt: "A forest --ASPECT 9:16 --HD --no rain", Resolution: "2K"})
	if err != nil || prompt != "A forest --ASPECT 9:16 --HD --no rain" {
		t.Fatalf("explicit flags were changed: %q %v", prompt, err)
	}
}

func TestHopBaseMidjourneyCanvasRatioOverridesPastedPrompt(t *testing.T) {
	for _, tt := range []struct {
		name, prompt, size, aspect, want string
	}{
		{"reported conflict", "Immortal palace --ar 21:9 --style raw --stylize 400 --v 8.2", "1:1", "", "Immortal palace --ar 1:1 --style raw --stylize 400 --v 8.2"},
		{"alias and end", "A forest --stylize 200 --ASPECT 21:9", "1:1", "", "A forest --stylize 200 --ar 1:1"},
		{"aspect field", "A forest --ar 21:9 --no rain", "", "9:16", "A forest --ar 9:16 --no rain"},
		{"prompt only", "A forest --ar 21:9 --style raw", "", "", "A forest --ar 21:9 --style raw"},
		{"auto defers to prompt", "A forest --aspect 21:9", "auto", "", "A forest --aspect 21:9"},
		{"HD validates selected ratio", "A forest --ar 21:1 --hd", "1:1", "", "A forest --ar 1:1 --hd"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body, err := buildHopBaseMidjourneyBody(context.Background(), GenerateRequest{
				Model: hopBaseMidjourneyModel, Prompt: tt.prompt, Size: tt.size, AspectRatio: tt.aspect, OutputCount: 4,
			})
			if err != nil || body["prompt"] != tt.want || body["n"] != 4 {
				t.Fatalf("body=%#v err=%v; want prompt=%q with four outputs", body, err, tt.want)
			}
		})
	}
}

func TestHopBaseMidjourneyRejectsInvalidInput(t *testing.T) {
	for _, prompt := range []string{"", "--ar 16:9", "A tree :: 2", "A tree --q 2", "A tree --p", "A tree --ar 1.5:1", "A tree --ar 0:1", "A tree --ar 15:1", "A tree --ar 5:1 --hd", "A tree --ar 1:1 --aspect 2:1", "A tree --stylize 1001", "A tree --iw 4", "A tree --c 4 5", "A tree --seed 1.2", "A tree --hd text after flag"} {
		if _, err := hopBaseMidjourneyPrompt(GenerateRequest{Prompt: prompt}); err == nil {
			t.Errorf("accepted %q", prompt)
		}
	}
	for _, req := range []GenerateRequest{
		{Prompt: "A tree", OutputCount: 1},
		{Prompt: "A tree", ReferenceImages: []string{"a", "b"}},
		{Prompt: "A tree", ReferenceImages: []string{"data:image/png;base64,YQ=="}},
		{Prompt: "A tree", MaskImage: "mask"},
		{Prompt: "A tree", Resolution: "4K"},
	} {
		if err := validateHopBaseMidjourney(req); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
	if billableUnits(GenerateRequest{ServiceType: "image", Model: hopBaseMidjourneyModel}) != 4 || billableUnits(GenerateRequest{ServiceType: "image", Model: "other"}) != 1 {
		t.Fatal("fixed group billing is incorrect")
	}
}

type midjourneyCheckpointRepo struct {
	fakeRepository
	logID, providerID, taskID string
}

func (r *midjourneyCheckpointRepo) SetGenerationLogUpstreamTask(_ context.Context, logID, providerID, taskID string) error {
	r.logID, r.providerID, r.taskID = logID, providerID, taskID
	return nil
}

func fastMidjourneyPoll(t *testing.T) {
	delay, interval := imageTaskPollInitialDelay, imageTaskPollInterval
	imageTaskPollInitialDelay, imageTaskPollInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() { imageTaskPollInitialDelay, imageTaskPollInterval = delay, interval })
	t.Setenv("CCY_ALLOW_INTERNAL_FETCH", "1")
}

func TestHopBaseMidjourneySubmitFourOutputsAndRecovery(t *testing.T) {
	fastMidjourneyPoll(t)
	repo := &midjourneyCheckpointRepo{}
	posts, polls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing auth")
		}
		switch r.URL.Path {
		case "/v1/images/generations":
			posts++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if r.Method != http.MethodPost || len(body) != 3 || body["n"] != float64(4) {
				t.Errorf("bad submit: %#v", body)
			}
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"id":"kt-example","status":"queued","images_per_task":4}`)
		case "/v1/video/tasks/kt-example":
			polls++
			if repo.taskID != "kt-example" || repo.providerID != "provider" || r.Method != http.MethodGet {
				t.Error("missing durable task checkpoint before GET")
			}
			switch polls {
			case 1:
				w.WriteHeader(http.StatusTooManyRequests)
			case 2:
				fmt.Fprint(w, `{"status":"new_state","outputs":["https://media.example.test/1.png"]}`)
			case 3:
				fmt.Fprint(w, `{"status":"completed","outputs":[]}`)
			default:
				fmt.Fprint(w, `{"status":"completed","outputs":["https://media.example.test/1.png","https://media.example.test/2.png","https://media.example.test/3.png","https://media.example.test/4.png"]}`)
			}
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	svc := &Service{repo: repo}
	pc := &domain.ProviderConfig{ID: "provider", Vendor: "HopBase"}
	req := GenerateRequest{ServiceType: "image", Model: hopBaseMidjourneyModel, Prompt: "Forest", OutputCount: 4, GenerationLogID: "log"}
	result, err := svc.generateImage(context.Background(), pc, server.URL+"/v1", "test-key", req)
	if err != nil || result == nil || len(result.ContentList) != 4 || result.Content != result.ContentList[0] || posts != 1 || polls != 4 {
		t.Fatalf("result=%+v err=%v posts=%d polls=%d", result, err, posts, polls)
	}
	req.UpstreamTaskID, req.UpstreamProviderID = "kt-example", "provider"
	req.ReferenceImages = []string{"/uploads/expired.png"}
	result, err = svc.dispatchToVendor(context.Background(), candidateChannel{cfg: pc, baseURL: server.URL, apiKey: "test-key"}, req)
	if err != nil || result == nil || len(result.ContentList) != 4 || posts != 1 {
		t.Fatalf("recovery lost outputs or resubmitted: result=%+v err=%v posts=%d", result, err, posts)
	}
}

func TestHopBaseMidjourneyFailureAndCancellation(t *testing.T) {
	fastMidjourneyPoll(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":"failed","error":{"code":"input_sensitive","message":"the prompt was rejected by content moderation"}}`)
	}))
	defer server.Close()
	_, err := (&Service{}).pollHopBaseMidjourneyTask(context.Background(), server.URL, "key", "kt-failed")
	if err == nil || !strings.Contains(apperror.PublicMessage(err), "input_sensitive") {
		t.Fatalf("failure code was lost: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = (&Service{}).pollHopBaseMidjourneyTask(ctx, server.URL, "key", "kt-running")
	if err == nil {
		t.Fatal("cancelled polling returned success")
	}
}
