package audit

import "context"

type MultiRecorder struct {
	recorders []Recorder
}

func NewMultiRecorder(recorders ...Recorder) *MultiRecorder {
	filtered := make([]Recorder, 0, len(recorders))
	for _, recorder := range recorders {
		if recorder == nil {
			continue
		}
		filtered = append(filtered, recorder)
	}
	return &MultiRecorder{recorders: filtered}
}

func (m *MultiRecorder) Record(ctx context.Context, event Event) {
	if m == nil {
		return
	}
	for _, recorder := range m.recorders {
		recorder.Record(ctx, event)
	}
}
