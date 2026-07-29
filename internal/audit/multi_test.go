package audit

import (
	"context"
	"errors"
	"testing"
)

type stubRecorder struct {
	count int
}

type readyStubRecorder struct {
	stubRecorder
	readyErr error
}

func (r *readyStubRecorder) Ready(context.Context) error { return r.readyErr }

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

func TestMultiRecorderReadinessIncludesEveryReadySink(t *testing.T) {
	t.Parallel()
	recorder := NewMultiRecorder(
		&readyStubRecorder{},
		&readyStubRecorder{readyErr: errors.New("audit database unavailable")},
	)
	if err := recorder.Ready(context.Background()); err == nil {
		t.Fatal("expected unavailable audit sink to make multi-recorder unready")
	}
}
