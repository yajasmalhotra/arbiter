package audit

import (
	"context"
	"testing"
)

func TestPostgresRecorderTracksDroppedAuditEvents(t *testing.T) {
	recorder := &PostgresRecorder{queue: make(chan Event, 1)}
	recorder.queue <- Event{DecisionID: "queued"}
	recorder.Record(context.Background(), Event{DecisionID: "dropped"})
	if err := recorder.deliveryError(); err == nil {
		t.Fatal("expected a dropped audit event to make delivery unhealthy")
	}
}

func TestPostgresRecorderTracksPersistFailures(t *testing.T) {
	recorder := &PostgresRecorder{}
	recorder.failed.Add(1)
	if err := recorder.deliveryError(); err == nil {
		t.Fatal("expected a failed audit persistence to make delivery unhealthy")
	}
}
