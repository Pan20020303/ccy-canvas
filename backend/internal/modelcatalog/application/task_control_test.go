package application

import (
	"testing"
)

func TestCommittedCancellationPublishesCancelledWithoutRefundingAgain(t *testing.T) {
	bus := NewTaskEventBus()
	subscriber, unsubscribe := bus.Subscribe("owner")
	defer unsubscribe()
	svc := NewService(nil, nil).WithEventBus(bus)
	if svc.CreditChargingEnabled() {
		t.Fatal("optional charger must not claim an actual reserve")
	}
	svc.PublishTaskCancellation("owner", "task", "node", "project", "video")
	select {
	case event := <-subscriber.Events():
		if event.TaskID != "task" || event.NodeID != "node" || event.ProjectID != "project" || event.Status != "cancelled" || event.ErrorMsg != "" || event.ResultURL != "" {
			t.Fatalf("wrong cancellation event: %+v", event)
		}
	default:
		t.Fatal("confirmed cancellation did not reach the task tracker")
	}
}

func TestGenerationEventsRetainOriginatingProject(t *testing.T) {
	bus := NewTaskEventBus()
	subscriber, unsubscribe := bus.Subscribe("owner")
	defer unsubscribe()
	svc := NewService(nil, nil).WithEventBus(bus)
	for _, status := range []string{"persisting", "success", "error"} {
		svc.publishTaskEventWithStatus(GenerateRequest{UserID: "owner", GenerationLogID: "task", NodeID: "copied-node", ProjectID: "original-project", ServiceType: "video"}, &GenerateResult{Content: "/uploads/result.mp4"}, nil, 0, status)
		select {
		case event := <-subscriber.Events():
			if event.ProjectID != "original-project" || event.Status != status {
				t.Fatalf("lost task project: %+v", event)
			}
		default:
			t.Fatal("event was not delivered")
		}
	}
}
