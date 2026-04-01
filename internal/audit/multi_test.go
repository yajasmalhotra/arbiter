package audit

import (
	"context"
	"testing"
)

type stubRecorder struct {
	count int
}

func (r *stubRecorder) Record(_ context.Context, _ Event) {
	r.count++
}

func TestMultiRecorderForwardsEvents(t *testing.T) {
	t.Parallel()

	a := &stubRecorder{}
	b := &stubRecorder{}

	recorder := NewMultiRecorder(a, nil, b)
	recorder.Record(context.Background(), Event{DecisionID: "d1"})

	if a.count != 1 {
		t.Fatalf("expected first recorder to receive 1 event, got %d", a.count)
	}
	if b.count != 1 {
		t.Fatalf("expected second recorder to receive 1 event, got %d", b.count)
	}
}
